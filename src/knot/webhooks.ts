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

export type KnotWebhookNotifier = (params: {
  appUserId: string;
  event: KnotWebhookPayload["event"];
  externalUserId: string;
  message: string;
}) => Promise<void> | void;

async function notifyIfPossible(
  notifyUser: KnotWebhookNotifier | undefined,
  store: KnotDemoStore,
  event: KnotWebhookPayload["event"],
  externalUserId: string,
  merchantId: number,
  markOperationType: "sync_cart" | "checkout" | undefined,
  message: string,
) {
  if (!notifyUser) {
    return;
  }

  const appUserId = store.getAppUserIdForExternalUserId(externalUserId);

  if (!appUserId) {
    return;
  }

  try {
    await notifyUser({ appUserId, event, externalUserId, message });
    if (markOperationType) {
      store.markOperationNotified({
        externalUserId,
        merchantId,
        type: markOperationType,
      });
    }
  } catch (error) {
    console.error("knot webhook notifyUser failed", {
      error: error instanceof Error ? error.message : String(error),
      event,
      externalUserId,
    });
  }
}

export async function processKnotWebhook(params: {
  client: KnotClient;
  config: KnotConfig;
  embedTexts?: EmbedTextsFn;
  notifyUser?: KnotWebhookNotifier;
  payload: KnotWebhookPayload;
  store: KnotDemoStore;
}) {
  const externalUserId = params.payload.external_user_id;
  const merchantId = params.payload.merchant?.id;

  console.log("[knot-webhook]", {
    event: params.payload.event,
    externalUserId,
    merchantId,
    sessionId: params.payload.session_id,
  });

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
      await notifyIfPossible(
        params.notifyUser,
        params.store,
        params.payload.event,
        externalUserId,
        merchantId,
        "sync_cart",
        `your walmart cart is ready<textbreak>reply confirm ${confirmationToken} to place the order`,
      );
      break;
    }
    case "SYNC_CART_FAILED": {
      const errorMessage =
        typeof params.payload.error_message === "string"
          ? params.payload.error_message
          : undefined;

      params.store.updateLatestPendingOperation({
        errorCode:
          typeof params.payload.error_code === "string"
            ? params.payload.error_code
            : undefined,
        errorMessage,
        externalUserId,
        merchantId,
        result: params.payload,
        status: "failed",
        type: "sync_cart",
      });
      await notifyIfPossible(
        params.notifyUser,
        params.store,
        params.payload.event,
        externalUserId,
        merchantId,
        "sync_cart",
        errorMessage
          ? `walmart cart sync failed<textbreak>${errorMessage}`
          : "walmart cart sync failed",
      );
      break;
    }
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

      await notifyIfPossible(
        params.notifyUser,
        params.store,
        params.payload.event,
        externalUserId,
        merchantId,
        "checkout",
        transactionIds.length > 0
          ? `walmart order placed<textbreak>${transactionIds.length} transaction${
              transactionIds.length === 1 ? "" : "s"
            } recorded`
          : "walmart order placed",
      );
      break;
    }
    case "CHECKOUT_FAILED": {
      const errorMessage =
        typeof params.payload.error_message === "string"
          ? params.payload.error_message
          : undefined;
      const operationId =
        params.store.updateLatestPendingOperation({
          errorCode:
            typeof params.payload.error_code === "string"
              ? params.payload.error_code
              : undefined,
          errorMessage,
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
      await notifyIfPossible(
        params.notifyUser,
        params.store,
        params.payload.event,
        externalUserId,
        merchantId,
        "checkout",
        errorMessage
          ? `walmart checkout failed<textbreak>${errorMessage}`
          : "walmart checkout failed",
      );
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
  notifyUser?: KnotWebhookNotifier;
  store: KnotDemoStore;
}) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === params.config.webhookPath) {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          env: params.config.environment,
          message:
            "knot webhook listener is up. configure this URL as a POST webhook in the knot dashboard for this environment",
          path: params.config.webhookPath,
          status: "ok",
        }),
      );
      return;
    }

    if (request.method !== "POST" || request.url !== params.config.webhookPath) {
      console.log("[knot-webhook] 404", {
        method: request.method,
        url: request.url,
      });
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
          notifyUser: params.notifyUser,
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

  server.listen(params.config.webhookPort, () => {
    const localUrl = `http://localhost:${params.config.webhookPort}${params.config.webhookPath}`;
    console.log("[knot-webhook] listening", {
      env: params.config.environment,
      localUrl,
    });

    void detectPublicWebhookUrl(params.config.webhookPort).then((publicUrl) => {
      const resolved =
        process.env.KNOT_WEBHOOK_PUBLIC_URL ??
        (publicUrl ? `${publicUrl}${params.config.webhookPath}` : undefined);

      if (resolved) {
        console.log(
          `[knot-webhook] register this URL in the knot ${params.config.environment} dashboard: ${resolved}`,
        );
      } else {
        console.log(
          "[knot-webhook] no ngrok tunnel detected on :4040 and KNOT_WEBHOOK_PUBLIC_URL not set. run `./ngrok http 8787` and register the https URL with path /webhooks/knot in the knot dashboard for this environment",
        );
      }
    });
  });
  return server;
}

async function detectPublicWebhookUrl(localPort: number) {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(1000),
    });

    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      tunnels?: Array<{
        config?: { addr?: string };
        proto?: string;
        public_url?: string;
      }>;
    };

    const match = body.tunnels?.find(
      (tunnel) =>
        tunnel.proto === "https" &&
        typeof tunnel.config?.addr === "string" &&
        tunnel.config.addr.endsWith(`:${localPort}`),
    );

    return match?.public_url;
  } catch {
    return undefined;
  }
}
