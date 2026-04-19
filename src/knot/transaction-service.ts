import fs from "node:fs";
import path from "node:path";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { KnotClient } from "./client.js";
import { KnotDemoStore, buildTransactionTitle } from "./store.js";
import type {
  KnotConfig,
  KnotMerchant,
  KnotProduct,
  KnotTransaction,
} from "./types.js";

export type EmbedTextsFn = (apiKey: string, texts: string[]) => Promise<number[][]>;

export function buildTransactionText(
  merchant: KnotMerchant,
  transaction: KnotTransaction,
) {
  const itemSummary = (transaction.products ?? [])
    .map((product) =>
      [
        product.name ?? "unnamed item",
        product.description ?? "",
        product.seller?.name ? `seller ${product.seller.name}` : "",
        typeof product.quantity === "number" ? `qty ${product.quantity}` : "",
        product.price?.total ? `total ${product.price.total}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");

  const paymentSummary = (transaction.payment_methods ?? [])
    .map((method) =>
      [
        method.type ?? "payment",
        method.brand ?? "",
        method.last_four ? `ending ${method.last_four}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");

  return [
    `merchant ${merchant.name}`,
    transaction.datetime ? `date ${transaction.datetime}` : "",
    transaction.order_status ? `status ${transaction.order_status}` : "",
    transaction.price?.total ? `total ${transaction.price.total}` : "",
    transaction.price?.currency ? `currency ${transaction.price.currency}` : "",
    paymentSummary ? `payment ${paymentSummary}` : "",
    itemSummary ? `items ${itemSummary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildItemText(
  merchant: KnotMerchant,
  transaction: KnotTransaction,
  item: KnotProduct,
) {
  return [
    `merchant ${merchant.name}`,
    transaction.datetime ? `date ${transaction.datetime}` : "",
    item.name ? `item ${item.name}` : "",
    item.description ? `description ${item.description}` : "",
    item.seller?.name ? `seller ${item.seller.name}` : "",
    typeof item.quantity === "number" ? `quantity ${item.quantity}` : "",
    item.price?.total ? `total ${item.price.total}` : "",
    item.price?.unit_price ? `unit ${item.price.unit_price}` : "",
    item.eligibility?.length ? `eligibility ${item.eligibility.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function defaultEmbedTexts(apiKey: string, texts: string[]) {
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey,
    model: "gemini-embedding-001",
    taskType: TaskType.RETRIEVAL_DOCUMENT,
  });

  return Promise.all(texts.map((text) => embeddings.embedQuery(text)));
}

export async function syncTransactionsForUser(params: {
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  externalUserId: string;
  merchantIds?: number[];
  store: KnotDemoStore;
}) {
  const accounts = await params.client.getMerchantAccounts(
    params.externalUserId,
    "transaction_link",
  );

  for (const account of accounts) {
    if (!account.merchant?.id) {
      continue;
    }

    params.store.upsertLinkedAccount({
      connectionStatus: account.connection?.status,
      externalUserId: params.externalUserId,
      merchantId: account.merchant.id,
      merchantName: account.merchant.name,
      productType: "transaction_link",
      raw: account,
    });
  }

  const connectedMerchantIds = accounts
    .filter((account) => account.connection?.status === "connected")
    .map((account) => account.merchant?.id)
    .filter((merchantId): merchantId is number => Number.isInteger(merchantId));

  const targetMerchantIds =
    params.merchantIds && params.merchantIds.length > 0
      ? params.merchantIds
      : connectedMerchantIds.includes(params.config.walmartMerchantId)
        ? [params.config.walmartMerchantId]
        : [params.config.walmartMerchantId];

  for (const merchantId of targetMerchantIds) {
    let cursor = params.store.getSyncCursor(params.externalUserId, merchantId);

    for (;;) {
      const response = await params.client.syncTransactions({
        cursor,
        externalUserId: params.externalUserId,
        limit: 100,
        merchantId,
      });

      writeRawSyncPage(params.config, params.externalUserId, merchantId, response);
      await storeTransactions(
        params.config,
        params.externalUserId,
        response,
        params.store,
        params.embedTexts ?? defaultEmbedTexts,
      );

      cursor = response.next_cursor;
      params.store.setSyncCursor(params.externalUserId, merchantId, cursor);

      if (!cursor) {
        break;
      }
    }
  }
}

export async function hydrateTransactionsByIds(params: {
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  externalUserId: string;
  merchantId: number;
  store: KnotDemoStore;
  transactionIds: string[];
}) {
  const merchantName =
    params.store
      .listLinkedMerchants(params.externalUserId)
      .find((merchant) => merchant.merchantId === params.merchantId)?.merchantName ??
    `merchant ${params.merchantId}`;
  const merchant = {
    id: params.merchantId,
    name: merchantName,
  };

  const transactions = await Promise.all(
    params.transactionIds.map((transactionId) =>
      params.client.getTransactionById(transactionId),
    ),
  );

  await storeTransactions(
    params.config,
    params.externalUserId,
    {
      merchant,
      transactions,
    },
    params.store,
    params.embedTexts ?? defaultEmbedTexts,
  );
}

async function storeTransactions(
  config: KnotConfig,
  externalUserId: string,
  response: {
    merchant: KnotMerchant;
    transactions: KnotTransaction[];
  },
  store: KnotDemoStore,
  embedTexts: EmbedTextsFn,
) {
  const transactionTexts = response.transactions.map((transaction) =>
    buildTransactionText(response.merchant, transaction),
  );
  const transactionEmbeddings = await embedTexts(config.geminiApiKey, transactionTexts);

  for (const [index, transaction] of response.transactions.entries()) {
    const transactionText = transactionTexts[index] ?? buildTransactionText(response.merchant, transaction);
    const transactionEmbedding = transactionEmbeddings[index] ?? [];

    store.upsertTransaction({
      embeddedText: transactionText,
      externalUserId,
      merchant: response.merchant,
      transaction,
    });
    store.upsertPurchaseEmbedding({
      citationText: buildCitationText(response.merchant, transaction),
      embedding: transactionEmbedding,
      externalUserId,
      merchantId: response.merchant.id,
      sourceId: transaction.id,
      sourceType: "transaction",
      transactionId: transaction.id,
    });
    store.recordPaymentMethodObservations({
      externalUserId,
      merchantId: response.merchant.id,
      observedAt: transaction.datetime,
      paymentMethods: transaction.payment_methods ?? [],
      transactionId: transaction.id,
    });

    const itemTexts = (transaction.products ?? []).map((item) =>
      buildItemText(response.merchant, transaction, item),
    );
    const itemEmbeddings =
      itemTexts.length > 0 ? await embedTexts(config.geminiApiKey, itemTexts) : [];

    for (const [itemIndex, item] of (transaction.products ?? []).entries()) {
      const itemId = store.upsertItem({
        embeddedText: itemTexts[itemIndex] ?? buildItemText(response.merchant, transaction, item),
        externalUserId,
        merchantId: response.merchant.id,
        product: item,
        transactionId: transaction.id,
      });
      store.upsertPurchaseEmbedding({
        citationText: buildItemCitationText(response.merchant, transaction, item),
        embedding: itemEmbeddings[itemIndex] ?? [],
        externalUserId,
        itemId,
        merchantId: response.merchant.id,
        sourceId: itemId,
        sourceType: "item",
        transactionId: transaction.id,
      });
    }

    store.rebuildPaymentMethodProfiles(externalUserId, response.merchant.id);
  }
}

function writeRawSyncPage(
  config: KnotConfig,
  externalUserId: string,
  merchantId: number,
  payload: unknown,
) {
  const syncDir = path.join(
    config.dataDir,
    externalUserId,
    String(merchantId),
    "sync-pages",
  );
  fs.mkdirSync(syncDir, { recursive: true });

  const filename = `${new Date().toISOString().replaceAll(":", "-")}.json`;
  fs.writeFileSync(path.join(syncDir, filename), JSON.stringify(payload, null, 2));
}

function buildCitationText(merchant: KnotMerchant, transaction: KnotTransaction) {
  return [
    merchant.name,
    buildTransactionTitle(transaction, merchant.name),
    transaction.datetime ? transaction.datetime.slice(0, 10) : "",
    transaction.price?.total ? `${transaction.price.total} ${transaction.price.currency ?? ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildItemCitationText(
  merchant: KnotMerchant,
  transaction: KnotTransaction,
  item: KnotProduct,
) {
  return [
    merchant.name,
    item.name ?? "item",
    transaction.datetime ? transaction.datetime.slice(0, 10) : "",
    item.price?.total ? `${item.price.total} ${transaction.price?.currency ?? ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
