import { tool } from "@langchain/core/tools";
import type { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { z } from "zod";
import { KnotClient } from "../knot/client.js";
import { KnotDemoStore } from "../knot/store.js";
import {
  refreshLinkedMerchants,
  resolveOrSeedExternalUserId,
  seedDevUser,
  syncCartForUser,
  checkoutCartForUser,
} from "../knot/shopping-service.js";
import { syncTransactionsForUser } from "../knot/transaction-service.js";
import type {
  KnotCheckoutPaymentMethod,
  KnotConfig,
  KnotDeliveryLocation,
} from "../knot/types.js";
import type { BasicInfoKey, MemoryStore } from "../memory/types.js";

type CreateKnotAgentToolsOptions = {
  client: KnotClient;
  config: KnotConfig;
  memoryStore: MemoryStore;
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: KnotDemoStore;
  userId: string;
  userMessageText: string;
};

const PHONE_E164 = /^\+[1-9]\d{6,14}$/;
const ISO_ALPHA2_ANY_CASE = /^[A-Za-z]{2}$/;
const ISO_REGION_ANY_CASE = /^[A-Za-z0-9]{1,3}$/;

function normalizePhone(raw: string) {
  const digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim();
}

const deliveryLocationSchema = z.object({
  address: z.object({
    city: z.string().min(1).transform((value) => value.trim()),
    country: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .refine((value) => ISO_ALPHA2_ANY_CASE.test(value), {
        message: "country must be a 2-letter ISO 3166-1 alpha-2 code like US",
      }),
    line1: z.string().min(1).max(46).transform((value) => value.trim()),
    line2: z
      .string()
      .max(46)
      .optional()
      .transform((value) => value?.trim()),
    postal_code: z.string().min(5).max(10).transform((value) => value.trim()),
    region: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .refine((value) => ISO_REGION_ANY_CASE.test(value), {
        message:
          "region must be a 2 or 3 character ISO 3166-2 subdivision code like NJ or CA",
      }),
  }),
  firstName: z.string().min(1).max(255).transform((value) => value.trim()),
  lastName: z.string().min(1).max(255).transform((value) => value.trim()),
  phoneNumber: z
    .string()
    .transform(normalizePhone)
    .refine((value) => PHONE_E164.test(value), {
      message:
        "phoneNumber must be E.164 like +11234567890. if the user gave 10 digits prepend +1",
    }),
  setAsDefault: z.boolean().optional(),
});

type DeliveryLocationInput = z.infer<typeof deliveryLocationSchema>;

function deliveryInputToKnot(input: DeliveryLocationInput): KnotDeliveryLocation {
  return {
    address: input.address,
    first_name: input.firstName,
    last_name: input.lastName,
    phone_number: input.phoneNumber,
    set_as_default: input.setAsDefault ?? false,
  };
}

const REQUIRED_PROFILE_KEYS: BasicInfoKey[] = [
  "first_name",
  "last_name",
  "phone",
  "address_line1",
  "address_city",
  "address_region",
  "address_postal_code",
  "address_country",
];

async function buildDeliveryLocationFromProfile(
  memoryStore: MemoryStore,
  userId: string,
): Promise<
  | { status: "ok"; deliveryLocation: KnotDeliveryLocation }
  | { status: "missing"; missing: BasicInfoKey[] }
> {
  const rows = await memoryStore.getBasicInfo(userId);
  const byKey = new Map<BasicInfoKey, string>();

  for (const row of rows) {
    byKey.set(row.key, row.value);
  }

  const fallbackName = byKey.get("name");
  let firstName = byKey.get("first_name");
  let lastName = byKey.get("last_name");

  if ((!firstName || !lastName) && fallbackName) {
    const parts = fallbackName.split(/\s+/).filter(Boolean);
    firstName = firstName ?? parts[0];
    const tail = parts.slice(1).join(" ");
    lastName = lastName ?? (tail.length > 0 ? tail : undefined);
  }

  const resolved: Partial<Record<BasicInfoKey, string>> = {
    first_name: firstName,
    last_name: lastName,
    phone: byKey.get("phone"),
    address_line1: byKey.get("address_line1"),
    address_line2: byKey.get("address_line2"),
    address_city: byKey.get("address_city"),
    address_region: byKey.get("address_region"),
    address_postal_code: byKey.get("address_postal_code"),
    address_country: byKey.get("address_country") ?? "US",
  };

  const missing = REQUIRED_PROFILE_KEYS.filter((key) => !resolved[key]);

  if (missing.length > 0) {
    return { status: "missing", missing };
  }

  const candidate = {
    address: {
      city: resolved.address_city!,
      country: resolved.address_country!,
      line1: resolved.address_line1!,
      line2: resolved.address_line2,
      postal_code: resolved.address_postal_code!,
      region: resolved.address_region!,
    },
    firstName: resolved.first_name!,
    lastName: resolved.last_name!,
    phoneNumber: resolved.phone!,
    setAsDefault: true,
  };

  const parsed = deliveryLocationSchema.safeParse(candidate);

  if (!parsed.success) {
    return {
      status: "missing",
      missing: parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((part): part is string => typeof part === "string")
        .map((part) => {
          if (part === "phoneNumber") return "phone";
          if (part === "firstName") return "first_name";
          if (part === "lastName") return "last_name";
          if (part === "address") return "address_line1";
          return part;
        })
        .filter((key): key is BasicInfoKey =>
          REQUIRED_PROFILE_KEYS.includes(key as BasicInfoKey),
        ),
    };
  }

  return { status: "ok", deliveryLocation: deliveryInputToKnot(parsed.data) };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function runToolSafely<T>(
  handler: () => Promise<T>,
): Promise<string> {
  try {
    const result = await handler();
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ status: "error", error: errorMessage(error) });
  }
}

function operationAgeSeconds(operation?: { createdAt: Date }) {
  if (!operation) {
    return undefined;
  }

  return Math.max(0, Math.round((Date.now() - operation.createdAt.getTime()) / 1000));
}

export function createKnotAgentTools(options: CreateKnotAgentToolsOptions) {
  const resolveExternalUserId = async (explicitExternalUserId?: string) =>
    resolveOrSeedExternalUserId({
      appUserId: options.userId,
      client: options.client,
      config: options.config,
      externalUserId: explicitExternalUserId,
      store: options.store,
    });

  return [
    tool(
      async () =>
        runToolSafely(() =>
          seedDevUser({
            appUserId: options.userId,
            client: options.client,
            config: options.config,
            store: options.store,
          }),
        ),
      {
        description:
          "seed a walmart only knot dev user and sync seeded walmart purchases for the current imessage user",
        name: "seed_dev_user",
        schema: z.object({}),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => options.store.listSeededDevUsers(options.userId)),
      {
        description: "list seeded dev users for the current app user",
        name: "list_seeded_dev_users",
        schema: z.object({}),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();
          const merchants = await refreshLinkedMerchants({
            client: options.client,
            externalUserId,
            store: options.store,
          });

          return { externalUserId, merchants };
        }),
      {
        description:
          "get walmart knot link status for the current dev user",
        name: "get_linked_merchants",
        schema: z.object({}),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();

          await syncTransactionsForUser({
            client: options.client,
            config: options.config,
            externalUserId,
            store: options.store,
          });

          return {
            externalUserId,
            merchantId: options.config.walmartMerchantId,
            status: "synced" as const,
          };
        }),
      {
        description:
          "sync seeded walmart transaction history for the current dev user",
        name: "sync_purchases",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();
          const queryEmbedding = await options.queryEmbeddings.embedQuery(input.query);
          const hits = options.store.searchPurchases(
            externalUserId,
            queryEmbedding,
            input.limit ?? 6,
          );
          const purchases = Array.from(
            new Map(
              hits.map((hit) => [
                hit.transactionId,
                options.store.getPurchase(externalUserId, hit.transactionId),
              ]),
            ).entries(),
          ).map(([transactionId, purchase]) => ({
            purchase,
            transactionId,
          }));

          return { externalUserId, hits, purchases };
        }),
      {
        description:
          "search semantically through previous knot purchases and return cited matching transactions and items",
        name: "search_purchases",
        schema: z.object({
          limit: z.number().int().min(1).max(10).optional(),
          query: z.string().min(1),
        }),
      },
    ),
    tool(
      async (input) =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();
          const purchase = options.store.getPurchase(
            externalUserId,
            input.transactionId,
          );

          return {
            externalUserId,
            purchase,
            transactionId: input.transactionId,
          };
        }),
      {
        description: "get the full stored detail for one knot purchase",
        name: "get_purchase",
        schema: z.object({
          transactionId: z.string().min(1),
        }),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();

          return {
            externalUserId,
            paymentMethods: options.store.listPaymentMethodProfiles(
              externalUserId,
              options.config.walmartMerchantId,
            ),
          };
        }),
      {
        description:
          "list payment methods inferred from prior walmart purchase history. these are read only and NOT usable for checkout. checkout always uses the merchant default payment method",
        name: "list_inferred_payment_methods",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) =>
        runToolSafely(async () => {
          const expandedProducts = input.products.flatMap((product) =>
            Array.from({ length: product.quantity ?? 1 }, () => ({
              external_id: product.externalId,
            })),
          );

          let deliveryLocation: KnotDeliveryLocation;

          if (input.deliveryLocation) {
            deliveryLocation = deliveryInputToKnot(input.deliveryLocation);
          } else {
            const fromProfile = await buildDeliveryLocationFromProfile(
              options.memoryStore,
              options.userId,
            );

            if (fromProfile.status === "missing") {
              return {
                missing: fromProfile.missing,
                status: "need_delivery_info",
              };
            }

            deliveryLocation = fromProfile.deliveryLocation;
          }

          const initial = await syncCartForUser({
            appUserId: options.userId,
            client: options.client,
            deliveryLocation,
            products: expandedProducts,
            store: options.store,
          });

          return {
            externalUserId: initial.externalUserId,
            operationId: initial.operationId,
            status: "pending" as const,
          };
        }),
      {
        description:
          "kick off a walmart cart sync using walmart product external ids. returns immediately with status pending. the system will message the user directly when the cart is ready with the confirmation token so after calling this tell the user you are preparing their cart and wait for their next message. delivery info is read from the stored user profile. if the profile is missing fields this returns status need_delivery_info with a list of missing keys",
        name: "sync_cart",
        schema: z.object({
          deliveryLocation: deliveryLocationSchema.optional(),
          products: z
            .array(
              z.object({
                externalId: z.string().min(1),
                quantity: z.number().int().min(1).optional(),
              }),
            )
            .min(1),
        }),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();
          const merchantId = options.config.walmartMerchantId;
          const snapshot = options.store.getCartStatus(externalUserId, merchantId);

          return {
            ageSeconds: operationAgeSeconds(snapshot.operation),
            cart: snapshot.cart,
            confirmationToken: snapshot.cart?.confirmationToken,
            externalUserId,
            operation: snapshot.operation,
            status: snapshot.operation?.status ?? "none",
            userAlreadyNotified: snapshot.operation?.notifiedAt != null,
          };
        }),
      {
        description:
          "get the latest walmart cart snapshot. status is pending succeeded failed or none. userAlreadyNotified is true when the system has already messaged the user about this cart. if userAlreadyNotified is true do not repeat the status or confirmation token unless the user explicitly asks for it",
        name: "get_cart_status",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) =>
        runToolSafely(async () => {
          let paymentMethod: KnotCheckoutPaymentMethod | undefined;

          if (input.appOwnedPaymentMethod) {
            paymentMethod = {
              id: input.appOwnedPaymentMethod.id,
              is_single_use: input.appOwnedPaymentMethod.isSingleUse,
              jwe: input.appOwnedPaymentMethod.jwe,
            };
          }

          const initial = await checkoutCartForUser({
            appUserId: options.userId,
            client: options.client,
            confirmationToken: input.confirmationToken,
            paymentMethod,
            requestedPaymentChoice: input.paymentChoice,
            store: options.store,
            userMessageText: options.userMessageText,
          });

          return {
            externalUserId: initial.externalUserId,
            operationId: initial.operationId,
            status: "pending" as const,
          };
        }),
      {
        description:
          "kick off a walmart checkout after the user explicitly confirms. the user message must contain the literal word confirm. pass the confirmationToken from get_cart_status. returns immediately with status pending. the system will message the user directly when the order completes so after calling this tell the user you are placing their order and wait for their next message",
        name: "checkout_cart",
        schema: z.object({
          appOwnedPaymentMethod: z
            .object({
              id: z.string().min(1),
              isSingleUse: z.boolean(),
              jwe: z.string().min(1),
            })
            .optional(),
          confirmationToken: z.string().min(1),
          paymentChoice: z.string().default("merchant_default"),
        }),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const externalUserId = await resolveExternalUserId();
          const merchantId = options.config.walmartMerchantId;
          const snapshot = options.store.getCheckoutStatus(externalUserId, merchantId);

          return {
            ageSeconds: operationAgeSeconds(snapshot.operation),
            externalUserId,
            operation: snapshot.operation,
            result: snapshot.result,
            status: snapshot.operation?.status ?? "none",
            transactionIds: snapshot.result?.transactionIds ?? [],
            userAlreadyNotified: snapshot.operation?.notifiedAt != null,
          };
        }),
      {
        description:
          "get the latest walmart checkout snapshot. status is pending succeeded failed or none. userAlreadyNotified is true when the system has already messaged the user about this checkout. if userAlreadyNotified is true do not repeat the status unless the user explicitly asks for it",
        name: "get_checkout_status",
        schema: z.object({}),
      },
    ),
    tool(
      async () =>
        runToolSafely(async () => {
          const events = options.store.getRecentWebhookEvents(10);
          const now = Date.now();
          const last = events[0];
          const secondsSinceLast = last
            ? Math.round((now - last.receivedAt.getTime()) / 1000)
            : undefined;

          return {
            events: events.map((event) => ({
              ageSeconds: Math.round((now - event.receivedAt.getTime()) / 1000),
              event: event.event,
              externalUserId: event.externalUserId,
              receivedAt: event.receivedAt.toISOString(),
            })),
            hint:
              events.length === 0
                ? "internal note for the agent only do not share with the user. no events received yet. apologize briefly and tell the user things are taking a bit longer than usual. never explain the internals"
                : secondsSinceLast !== undefined && secondsSinceLast > 60
                  ? "internal note for the agent only do not share with the user. no recent events. apologize briefly and tell the user things are taking longer than usual never explain the internals"
                  : "internal note for the agent only do not share with the user. events are flowing keep going",
            secondsSinceLast,
            totalRecent: events.length,
          };
        }),
      {
        description:
          "inspect recent knot webhook deliveries to diagnose why a cart or checkout is stuck pending. returns the last 10 events and seconds since the last one. call this if sync_cart or checkout_cart has been pending for more than 20 seconds",
        name: "get_webhook_diagnostics",
        schema: z.object({}),
      },
    ),
  ];
}
