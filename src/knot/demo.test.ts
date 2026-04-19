import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KNOT_WALMART_MERCHANT_ID } from "./config.js";
import { KnotClient } from "./client.js";
import { KnotDemoStore } from "./store.js";
import {
  checkoutCartForUser,
  resolveOrSeedExternalUserId,
  seedDevUser,
  syncCartForUser,
} from "./shopping-service.js";
import { buildItemText, buildTransactionText, syncTransactionsForUser } from "./transaction-service.js";
import { processKnotWebhook } from "./webhooks.js";
import type { KnotConfig, KnotMerchant, KnotTransaction } from "./types.js";

function makeConfig(tempDir: string): KnotConfig {
  return {
    apiVersion: "2.0",
    baseUrl: "https://development.knotapi.com",
    clientId: "client-id",
    dataDir: path.join(tempDir, "knot"),
    defaultExternalUserId: undefined,
    environment: "development",
    geminiApiKey: "gemini-key",
    secret: "secret-456",
    sqlitePath: path.join(tempDir, "shomi.sqlite"),
    walmartMerchantId: KNOT_WALMART_MERCHANT_ID,
    webhookPath: "/webhooks/knot",
    webhookPort: 8787,
  };
}

function makeMerchant(
  id = KNOT_WALMART_MERCHANT_ID,
  name = "Walmart",
): KnotMerchant {
  return { id, name };
}

function makeTransaction(overrides: Partial<KnotTransaction> = {}): KnotTransaction {
  return {
    datetime: "2026-04-18T12:30:00Z",
    external_id: "order-1",
    id: "txn-1",
    order_status: "DELIVERED",
    payment_methods: [
      {
        brand: "VISA",
        last_four: "4242",
        name: "personal visa",
        transaction_amount: "18.25",
        type: "CARD",
      },
    ],
    price: {
      currency: "USD",
      sub_total: "17.00",
      total: "18.25",
    },
    products: [
      {
        description: "lime 8 pack",
        eligibility: ["FSA/HSA"],
        external_id: "sku-1",
        name: "Sparkling Water",
        quantity: 2,
        seller: { name: "Acme Foods" },
        url: "https://example.com/item/sku-1",
        price: {
          total: "8.00",
          unit_price: "4.00",
        },
      },
    ],
    url: "https://example.com/orders/1",
    ...overrides,
  };
}

const embedTexts = async (_apiKey: string, texts: string[]) =>
  texts.map((text) => {
    if (/sparkling water/i.test(text)) {
      return [1, 0, 0];
    }

    if (/walmart/i.test(text)) {
      return [0, 1, 0];
    }

    return [0, 0, 1];
  });

function withMockedFetch(
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    return handler(url, init);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("transaction and item summaries capture semantic purchase context", () => {
  const merchant = makeMerchant();
  const transaction = makeTransaction();

  assert.match(buildTransactionText(merchant, transaction), /payment CARD VISA ending 4242/);
  assert.match(buildTransactionText(merchant, transaction), /items Sparkling Water/);
  assert.match(
    buildItemText(merchant, transaction, transaction.products?.[0] ?? {}),
    /item Sparkling Water/,
  );
});

test("sync stores searchable purchases and inferred payment methods", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-sync-demo-"));
  const config = makeConfig(tempDir);
  const store = new KnotDemoStore({ filename: config.sqlitePath });
  const restoreFetch = withMockedFetch(async (url) => {
    if (url.pathname === "/accounts/get") {
      return new Response(
        JSON.stringify([
          {
            connection: { status: "connected" },
            merchant: makeMerchant(),
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/transactions/sync") {
      return new Response(
        JSON.stringify({
          limit: 100,
          merchant: makeMerchant(),
          next_cursor: null,
          transactions: [makeTransaction()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch ${url.pathname}`);
  });

  try {
    await syncTransactionsForUser({
      client: new KnotClient(config),
      config,
      embedTexts,
      externalUserId: "demo-user",
      store,
    });
  } finally {
    restoreFetch();
  }

  const hits = store.searchPurchases("demo-user", [1, 0, 0], 3);
  const purchase = store.getPurchase("demo-user", "txn-1");
  const methods = store.listPaymentMethodProfiles(
    "demo-user",
    KNOT_WALMART_MERCHANT_ID,
  );

  assert.equal(hits[0]?.transactionId, "txn-1");
  assert.equal(purchase?.items[0]?.name, "Sparkling Water");
  assert.equal(methods[0]?.lastFour, "4242");
  assert.equal(methods[0]?.actionable, false);
});

test("seed dev user persists reusable identity and linked merchant cache", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-seed-demo-"));
  const config = makeConfig(tempDir);
  const store = new KnotDemoStore({ filename: config.sqlitePath });
  const restoreFetch = withMockedFetch(async (url) => {
    if (url.pathname === "/development/accounts/link") {
      return new Response(
        JSON.stringify({ message: "Success" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/accounts/get") {
      return new Response(
        JSON.stringify([
          {
            connection: { status: "connected" },
            merchant: makeMerchant(),
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/transactions/sync") {
      return new Response(
        JSON.stringify({
          limit: 100,
          merchant: makeMerchant(),
          next_cursor: null,
          transactions: [makeTransaction()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch ${url.pathname}`);
  });

  try {
    const result = await seedDevUser({
      appUserId: "chat-user",
      client: new KnotClient(config),
      config,
      embedTexts,
      externalUserId: "seed-user-1",
      store,
    });

    assert.equal(result.externalUserId, "seed-user-1");
  } finally {
    restoreFetch();
  }

  const seededUsers = store.listSeededDevUsers("chat-user");
  const linked = store.listLinkedMerchants("seed-user-1");

  assert.equal(seededUsers[0]?.externalUserId, "seed-user-1");
  assert.equal(seededUsers[0]?.isActive, true);
  assert.ok(linked.some((merchant) => merchant.merchantId === 45));
  assert.equal(linked.length, 2);
});

test("resolveOrSeedExternalUserId seeds a first run user for a new chat user", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-resolve-seed-"));
  const config = makeConfig(tempDir);
  const store = new KnotDemoStore({ filename: config.sqlitePath });
  const restoreFetch = withMockedFetch(async (url) => {
    if (url.pathname === "/development/accounts/link") {
      return new Response(
        JSON.stringify({ message: "Success" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/accounts/get") {
      return new Response(
        JSON.stringify([
          {
            connection: { status: "connected" },
            merchant: makeMerchant(),
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/transactions/sync") {
      return new Response(
        JSON.stringify({
          limit: 100,
          merchant: makeMerchant(),
          next_cursor: null,
          transactions: [makeTransaction()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch ${url.pathname}`);
  });

  try {
    const externalUserId = await resolveOrSeedExternalUserId({
      appUserId: "+16173124670",
      client: new KnotClient(config),
      config,
      store,
    });

    assert.ok(externalUserId.startsWith("dev_"));
    assert.equal(store.resolveExternalUserId("+16173124670"), externalUserId);
    assert.equal(store.getPurchase(externalUserId, "txn-1")?.items[0]?.name, "Sparkling Water");
  } finally {
    restoreFetch();
  }
});

test("sync cart requires a linked merchant and webhook flow enables confirmed checkout", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-shopping-demo-"));
  const config = makeConfig(tempDir);
  const store = new KnotDemoStore({ filename: config.sqlitePath });
  const client = new KnotClient(config);

  store.upsertDevUser({
    appUserId: "chat-user",
    environment: "development",
    externalUserId: "shop-user",
    seededMerchants: [{ merchantId: 45, productType: "shopping" }],
  });

  await assert.rejects(
    () =>
      syncCartForUser({
        appUserId: "chat-user",
        client,
        merchantId: 45,
        products: [{ external_id: "sku-1" }],
        store,
      }),
    /not linked and connected/,
  );

  store.upsertLinkedAccount({
    connectionStatus: "connected",
    externalUserId: "shop-user",
    merchantId: 45,
    merchantName: "Walmart",
    productType: "shopping",
    raw: { seeded: true },
  });

  const restoreFetch = withMockedFetch(async (url) => {
    if (url.pathname === "/cart") {
      return new Response(
        JSON.stringify({ message: "Success" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/cart/checkout") {
      return new Response(
        JSON.stringify({ message: "Success" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/transactions/txn-checkout-1") {
      return new Response(
        JSON.stringify(
          makeTransaction({
            id: "txn-checkout-1",
            products: [
              {
                external_id: "sku-1",
                name: "Sparkling Water",
                quantity: 1,
                price: { total: "4.00", unit_price: "4.00" },
              },
            ],
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch ${url.pathname}`);
  });

  try {
    const syncResult = await syncCartForUser({
      appUserId: "chat-user",
      client,
      merchantId: 45,
      products: [{ external_id: "sku-1" }],
      store,
    });

    assert.equal(syncResult.status, "pending");

    await processKnotWebhook({
      client,
      config,
      embedTexts,
      payload: {
        data: {
          items: [
            {
              external_id: "sku-1",
              fulfillment_options: [{ id: "pickup-1" }],
              name: "Sparkling Water",
              quantity: 1,
            },
          ],
        },
        event: "SYNC_CART_SUCCEEDED",
        external_user_id: "shop-user",
        merchant: { id: 45, name: "Walmart" },
      },
      store,
    });

    const cartStatus = store.getCartStatus("shop-user", 45);
    const confirmationToken = cartStatus.cart?.confirmationToken;
    assert.equal(cartStatus.operation?.status, "succeeded");
    assert.ok(confirmationToken);

    await assert.rejects(
      () =>
        checkoutCartForUser({
          appUserId: "chat-user",
          client,
          confirmationToken: confirmationToken ?? "missing",
          merchantId: 45,
          store,
          userMessageText: "buy it now",
        }),
      /explicit confirm/,
    );

    const checkoutResult = await checkoutCartForUser({
      appUserId: "chat-user",
      client,
      confirmationToken: confirmationToken ?? "missing",
      merchantId: 45,
      store,
      userMessageText: `confirm ${confirmationToken}`,
    });

    assert.equal(checkoutResult.status, "pending");

    await processKnotWebhook({
      client,
      config,
      embedTexts,
      payload: {
        data: {
          transactions: [{ id: "txn-checkout-1" }],
        },
        event: "CHECKOUT_SUCCEEDED",
        external_user_id: "shop-user",
        merchant: { id: 45, name: "Walmart" },
      },
      store,
    });
  } finally {
    restoreFetch();
  }

  const checkoutStatus = store.getCheckoutStatus("shop-user", 45);
  const purchase = store.getPurchase("shop-user", "txn-checkout-1");

  assert.equal(checkoutStatus.operation?.status, "succeeded");
  assert.deepEqual(checkoutStatus.result?.transactionIds, ["txn-checkout-1"]);
  assert.equal(purchase?.transactionId, "txn-checkout-1");
});
