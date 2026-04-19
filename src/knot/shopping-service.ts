import { KnotClient } from "./client.js";
import { KNOT_WALMART_MERCHANT_ID } from "./config.js";
import { KnotDemoStore } from "./store.js";
import { syncTransactionsForUser } from "./transaction-service.js";
import type {
  KnotCartProductInput,
  KnotCheckoutPaymentMethod,
  KnotConfig,
  KnotDeliveryLocation,
} from "./types.js";
import type { EmbedTextsFn } from "./transaction-service.js";

function generateDevExternalUserId() {
  return `dev_${Date.now().toString(36)}`;
}

export async function seedDevUser(params: {
  appUserId: string;
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  externalUserId?: string;
  store: KnotDemoStore;
}) {
  const externalUserId =
    params.externalUserId ??
    params.store.resolveExternalUserId(params.appUserId) ??
    params.config.defaultExternalUserId ??
    generateDevExternalUserId();
  const merchantId = params.config.walmartMerchantId;
  const seededMerchants = [
    { merchantId, productType: "transaction_link" as const },
    { merchantId, productType: "shopping" as const },
  ];

  await params.client.linkDevelopmentAccount({
    external_user_id: externalUserId,
    merchant_id: merchantId,
    transactions: {
      new: true,
      updated: true,
    },
  });
  params.store.upsertLinkedAccount({
    connectionStatus: "connected",
    externalUserId,
    merchantId,
    merchantName: "Walmart",
    productType: "transaction_link",
    raw: { seeded: true, walmartOnly: true },
  });
  params.store.upsertLinkedAccount({
    connectionStatus: "connected",
    externalUserId,
    merchantId,
    merchantName: "Walmart",
    productType: "shopping",
    raw: { seeded: true, walmartOnly: true },
  });

  params.store.upsertDevUser({
    appUserId: params.appUserId,
    environment: params.config.environment,
    externalUserId,
    seededMerchants,
  });

  await syncTransactionsForUser({
    client: params.client,
    config: params.config,
    embedTexts: params.embedTexts,
    externalUserId,
    merchantIds: [merchantId],
    store: params.store,
  });

  return {
    externalUserId,
    seededMerchants,
  };
}

export async function resolveOrSeedExternalUserId(params: {
  appUserId: string;
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  externalUserId?: string;
  store: KnotDemoStore;
}) {
  const existingExternalUserId = params.store.resolveExternalUserId(
    params.appUserId,
    params.externalUserId,
  );

  if (existingExternalUserId) {
    return existingExternalUserId;
  }

  const seeded = await seedDevUser({
    appUserId: params.appUserId,
    client: params.client,
    config: params.config,
    embedTexts: params.embedTexts,
    externalUserId: params.externalUserId,
    store: params.store,
  });

  return seeded.externalUserId;
}

export async function listShoppingMerchants(params: {
  client: KnotClient;
  search?: string;
}) {
  return params.client.listMerchants("shopping", params.search);
}

export async function refreshLinkedMerchants(params: {
  client: KnotClient;
  externalUserId: string;
  store: KnotDemoStore;
}) {
  const accounts = await params.client.getMerchantAccounts(params.externalUserId);

  for (const account of accounts) {
    if (!account.merchant?.id) {
      continue;
    }

    params.store.upsertLinkedAccount({
      connectionStatus: account.connection?.status,
      externalUserId: params.externalUserId,
      merchantId: account.merchant.id,
      merchantName: account.merchant.name,
      raw: account,
    });
  }

  return params.store.listLinkedMerchants(params.externalUserId);
}

export async function syncCartForUser(params: {
  appUserId: string;
  client: KnotClient;
  config?: KnotConfig;
  deliveryLocation?: KnotDeliveryLocation;
  externalUserId?: string;
  merchantId?: number;
  products: KnotCartProductInput[];
  store: KnotDemoStore;
}) {
  const existingExternalUserId = params.store.resolveExternalUserId(
    params.appUserId,
    params.externalUserId,
  );
  const externalUserId =
    existingExternalUserId ??
    (params.config
      ? await resolveOrSeedExternalUserId({
          appUserId: params.appUserId,
          client: params.client,
          config: params.config,
          externalUserId: params.externalUserId,
          store: params.store,
        })
      : undefined);
  const merchantId = params.merchantId ?? KNOT_WALMART_MERCHANT_ID;

  if (!externalUserId) {
    throw new Error("No active dev user found. Seed a dev user first.");
  }

  const linkedMerchant = params.store
    .listLinkedMerchants(externalUserId)
    .find(
      (merchant) =>
        merchant.merchantId === merchantId &&
        merchant.connectionStatus === "connected",
    );

  if (!linkedMerchant) {
    throw new Error("Merchant account is not linked and connected for shopping.");
  }

  const operationId = params.store.createOperation({
    externalUserId,
    merchantId,
    payload: {
      deliveryLocation: params.deliveryLocation,
      products: params.products,
    },
    type: "sync_cart",
  });

  await params.client.syncCart({
    deliveryLocation: params.deliveryLocation,
    externalUserId,
    merchantId,
    products: params.products,
  });

  return {
    externalUserId,
    operationId,
    status: "pending",
  };
}

export async function checkoutCartForUser(params: {
  appUserId: string;
  client: KnotClient;
  confirmationToken: string;
  config?: KnotConfig;
  externalUserId?: string;
  merchantId?: number;
  paymentMethod?: KnotCheckoutPaymentMethod;
  requestedPaymentChoice?: string;
  store: KnotDemoStore;
  userMessageText: string;
}) {
  const existingExternalUserId = params.store.resolveExternalUserId(
    params.appUserId,
    params.externalUserId,
  );
  const externalUserId =
    existingExternalUserId ??
    (params.config
      ? await resolveOrSeedExternalUserId({
          appUserId: params.appUserId,
          client: params.client,
          config: params.config,
          externalUserId: params.externalUserId,
          store: params.store,
        })
      : undefined);
  const merchantId = params.merchantId ?? KNOT_WALMART_MERCHANT_ID;

  if (!externalUserId) {
    throw new Error("No active dev user found. Seed a dev user first.");
  }

  const latestToken = params.store.getConfirmationToken(
    externalUserId,
    merchantId,
  );

  if (!latestToken || latestToken !== params.confirmationToken) {
    throw new Error("Invalid confirmation token. Fetch cart status and confirm again.");
  }

  if (!/\bconfirm\b/i.test(params.userMessageText)) {
    throw new Error("Checkout requires an explicit confirm message from the user.");
  }

  if (
    params.requestedPaymentChoice &&
    params.requestedPaymentChoice.startsWith("app_owned:") &&
    !params.paymentMethod
  ) {
    throw new Error("No app owned payment method payload is available for checkout.");
  }

  const operationId = params.store.createOperation({
    confirmationToken: params.confirmationToken,
    externalUserId,
    merchantId,
    payload: {
      paymentMethod: params.paymentMethod ? "provided" : "merchant_default",
      requestedPaymentChoice: params.requestedPaymentChoice ?? "merchant_default",
    },
    type: "checkout",
  });

  await params.client.checkoutCart({
    externalUserId,
    merchantId,
    paymentMethod: params.paymentMethod,
  });

  return {
    externalUserId,
    operationId,
    status: "pending",
  };
}
