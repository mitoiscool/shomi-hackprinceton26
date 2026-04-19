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
import type { KnotCheckoutPaymentMethod, KnotConfig } from "../knot/types.js";

type CreateKnotAgentToolsOptions = {
  client: KnotClient;
  config: KnotConfig;
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: KnotDemoStore;
  userId: string;
  userMessageText: string;
};

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
      async (input) => {
        const seeded = await seedDevUser({
          appUserId: options.userId,
          client: options.client,
          config: options.config,
          externalUserId: input.externalUserId,
          store: options.store,
        });

        return JSON.stringify(seeded);
      },
      {
        description:
          "seed a walmart only knot dev user and sync seeded walmart purchases",
        name: "seed_dev_user",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
    tool(
      async () =>
        JSON.stringify(options.store.listSeededDevUsers(options.userId)),
      {
        description: "list seeded dev users for the current app user",
        name: "list_seeded_dev_users",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);
        const merchants = await refreshLinkedMerchants({
          client: options.client,
          externalUserId,
          store: options.store,
        });

        return JSON.stringify({
          externalUserId,
          merchants,
        });
      },
      {
        description:
          "get walmart knot link status for the current dev user",
        name: "get_linked_merchants",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);

        await syncTransactionsForUser({
          client: options.client,
          config: options.config,
          externalUserId,
          store: options.store,
        });

        return JSON.stringify({
          externalUserId,
          merchantId: options.config.walmartMerchantId,
          status: "synced",
        });
      },
      {
        description:
          "sync seeded walmart transaction history for the current dev user",
        name: "sync_purchases",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);
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

        return JSON.stringify({
          externalUserId,
          hits,
          purchases,
        });
      },
      {
        description:
          "search semantically through previous knot purchases and return cited matching transactions and items",
        name: "search_purchases",
        schema: z.object({
          externalUserId: z.string().optional(),
          limit: z.number().int().min(1).max(10).optional(),
          query: z.string().min(1),
        }),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);
        const purchase = options.store.getPurchase(
          externalUserId,
          input.transactionId,
        );

        return JSON.stringify({
          externalUserId,
          purchase,
          transactionId: input.transactionId,
        });
      },
      {
        description: "get the full stored detail for one knot purchase",
        name: "get_purchase",
        schema: z.object({
          externalUserId: z.string().optional(),
          transactionId: z.string().min(1),
        }),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);

        return JSON.stringify({
          externalUserId,
          paymentMethods: options.store.listPaymentMethodProfiles(
            externalUserId,
            options.config.walmartMerchantId,
          ),
        });
      },
      {
        description:
          "list inferred payment methods observed in prior walmart purchases",
        name: "list_inferred_payment_methods",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        const expandedProducts = input.products.flatMap((product) =>
          Array.from({ length: product.quantity ?? 1 }, () => ({
            external_id: product.externalId,
          })),
        );

        const result = await syncCartForUser({
          appUserId: options.userId,
          client: options.client,
          deliveryLocation: input.deliveryLocation
            ? {
                address: input.deliveryLocation.address,
                first_name: input.deliveryLocation.firstName,
                last_name: input.deliveryLocation.lastName,
                phone_number: input.deliveryLocation.phoneNumber,
                set_as_default: input.deliveryLocation.setAsDefault ?? false,
              }
            : undefined,
          externalUserId: input.externalUserId,
          products: expandedProducts,
          store: options.store,
        });

        return JSON.stringify(result);
      },
      {
        description:
          "sync the walmart shopping cart using walmart product external ids",
        name: "sync_cart",
        schema: z.object({
          deliveryLocation: z
            .object({
              address: z.object({
                city: z.string(),
                country: z.string(),
                line1: z.string(),
                line2: z.string().optional(),
                postal_code: z.string(),
                region: z.string(),
              }),
              firstName: z.string(),
              lastName: z.string(),
              phoneNumber: z.string(),
              setAsDefault: z.boolean().optional(),
            })
            .optional(),
          externalUserId: z.string().optional(),
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
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);

        return JSON.stringify(
          options.store.getCartStatus(
            externalUserId,
            options.config.walmartMerchantId,
          ),
        );
      },
      {
        description:
          "get the latest walmart cart status and confirmation token",
        name: "get_cart_status",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        let paymentMethod: KnotCheckoutPaymentMethod | undefined;

        if (input.appOwnedPaymentMethod) {
          paymentMethod = {
            id: input.appOwnedPaymentMethod.id,
            is_single_use: input.appOwnedPaymentMethod.isSingleUse,
            jwe: input.appOwnedPaymentMethod.jwe,
          };
        }

        const result = await checkoutCartForUser({
          appUserId: options.userId,
          client: options.client,
          confirmationToken: input.confirmationToken,
          externalUserId: input.externalUserId,
          paymentMethod,
          requestedPaymentChoice: input.paymentChoice,
          store: options.store,
          userMessageText: options.userMessageText,
        });

        return JSON.stringify(result);
      },
      {
        description:
          "checkout a merchant cart after the user explicitly confirms with the latest confirmation token",
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
          externalUserId: z.string().optional(),
          paymentChoice: z.string().default("merchant_default"),
        }),
      },
    ),
    tool(
      async (input) => {
        const externalUserId = await resolveExternalUserId(input.externalUserId);

        return JSON.stringify(
          options.store.getCheckoutStatus(
            externalUserId,
            options.config.walmartMerchantId,
          ),
        );
      },
      {
        description: "get the latest walmart checkout status",
        name: "get_checkout_status",
        schema: z.object({
          externalUserId: z.string().optional(),
        }),
      },
    ),
  ];
}
