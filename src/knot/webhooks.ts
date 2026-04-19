import crypto from "node:crypto";
import { createServer } from "node:http";
import { KnotClient } from "./client.js";
import { KnotDemoStore } from "./store.js";
import { hydrateTransactionsByIds } from "./transaction-service.js";
import type { KnotConfig, KnotWebhookPayload } from "./types.js";
import type { EmbedTextsFn } from "./transaction-service.js";

function computeKnotSignature(body: string, headers: Record<string, string>, secret: string) {
  const fields = {
    "Content-Length": headers["content-length"] ?? String(Buffer.byteLength(body)),
    "Content-Type": headers["content-type"] ?? "application/json",
    "Encryption-Type": headers["encryption-type"] ?? "HMAC-SHA256",
    event: "",
    session_id: "",
  };
  let payload: KnotWebhookPayload | undefined;

  try {
    payload = JSON.parse(body) as KnotWebhookPayload;
  } catch {
    payload = undefined;
  }

  fields.event = payload?.event ?? "";
  fields.session_id =
    typeof payload?.session_id === "string" ? payload.session_id : "";

  const pairs = Object.entries(fields).filter(([, value]) => value.length > 0);
  const signatureBase = pairs.flatMap(([key, value]) => [key, value]).join("|");

  return crypto
    .createHmac("sha256", secret)
    .update(signatureBase)
    .digest("base64");
}

function parseTransactionIds(payload: KnotWebhookPayload) {
  const directTransactions = Array.isArray(payload.transactions)
    ? payload.transactions
    : Array.isArray((payload.data as { transactions?: unknown[] } | undefined)?.transactions)
      ? (((payload.data as { transactions?: unknown[] }).transactions ?? []) as Array<{
          id?: string;
        }>)
      : [];

  return directTransactions
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function processKnotWebhook(params: {
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  payload: KnotWebhookPayload;
  store: KnotDemoStore;
}) {
  const externalUserId = params.payload.external_user_id;
  const merchantId = params.payload.merchant?.id;

  params.store.recordWebhookEvent({
    event: params.payload.event,
    externalUserId,
    merchantId,
    payload: params.payload,
  });

  if (!externalUserId || !merchantId) {
    return;
  }

  switch (params.payload.event) {
    case "AUTHENTICATED":
      params.store.upsertLinkedAccount({
        connectionStatus: "connected",
        externalUserId,
        merchantId,
        merchantName: params.payload.merchant?.name,
        raw: params.payload,
      });
      break;
    case "ACCOUNT_LOGIN_REQUIRED":
      params.store.upsertLinkedAccount({
        connectionStatus: "disconnected",
        externalUserId,
        merchantId,
        merchantName: params.payload.merchant?.name,
        raw: params.payload,
      });
      break;
    case "SYNC_CART_SUCCEEDED": {
      const payload =
        (params.payload.data as Record<string, unknown> | undefined) ?? params.payload;
      const confirmationToken = params.store.upsertCartSnapshot(
        externalUserId,
        merchantId,
        payload,
      );
      params.store.updateLatestPendingOperation({
        externalUserId,
        merchantId,
        result: {
          confirmationToken,
          payload,
        },
        status: "succeeded",
        type: "sync_cart",
      });
      break;
    }
    case "SYNC_CART_FAILED":
      params.store.updateLatestPendingOperation({
        errorCode:
          typeof params.payload.error_code === "string"
            ? params.payload.error_code
            : undefined,
        errorMessage:
          typeof params.payload.error_message === "string"
            ? params.payload.error_message
            : undefined,
        externalUserId,
        merchantId,
        result: params.payload,
        status: "failed",
        type: "sync_cart",
      });
      break;
    case "CHECKOUT_SUCCEEDED": {
      const operationId =
        params.store.updateLatestPendingOperation({
          externalUserId,
          merchantId,
          result: params.payload,
          status: "succeeded",
          type: "checkout",
        }) ?? crypto.randomUUID();
      const transactionIds = parseTransactionIds(params.payload);

      params.store.storeCheckoutResult({
        externalUserId,
        merchantId,
        operationId,
        payload: params.payload,
        status: "succeeded",
        transactionIds,
      });

      if (transactionIds.length > 0) {
        await hydrateTransactionsByIds({
          client: params.client,
          config: params.config,
          embedTexts: params.embedTexts,
          externalUserId,
          merchantId,
          store: params.store,
          transactionIds,
        });
      }
      break;
    }
    case "CHECKOUT_FAILED": {
      const operationId =
        params.store.updateLatestPendingOperation({
          errorCode:
            typeof params.payload.error_code === "string"
              ? params.payload.error_code
              : undefined,
          errorMessage:
            typeof params.payload.error_message === "string"
              ? params.payload.error_message
              : undefined,
          externalUserId,
          merchantId,
          result: params.payload,
          status: "failed",
          type: "checkout",
        }) ?? crypto.randomUUID();

      params.store.storeCheckoutResult({
        externalUserId,
        merchantId,
        operationId,
        payload: params.payload,
        status: "failed",
        transactionIds: [],
      });
      break;
    }
    default:
      break;
  }
}

export function startKnotWebhookServer(params: {
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  store: KnotDemoStore;
}) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== params.config.webhookPath) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers["knot-signature"];
      const headerMap = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([, value]) => typeof value === "string")
          .map(([key, value]) => [key.toLowerCase(), value as string]),
      );

      if (
        typeof signature === "string" &&
        computeKnotSignature(body, headerMap, params.config.secret) !== signature
      ) {
        response.statusCode = 401;
        response.end("invalid signature");
        return;
      }

      try {
        const payload = JSON.parse(body) as KnotWebhookPayload;
        await processKnotWebhook({
          client: params.client,
          config: params.config,
          embedTexts: params.embedTexts,
          payload,
          store: params.store,
        });
        response.statusCode = 200;
        response.end("ok");
      } catch (error) {
        response.statusCode = 500;
        response.end(
          error instanceof Error ? error.message : "webhook processing failed",
        );
      }
    });
  });

  server.listen(params.config.webhookPort);
  return server;
}
