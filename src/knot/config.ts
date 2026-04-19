import path from "node:path";
import type { KnotConfig, KnotEnvironment } from "./types.js";

export const KNOT_WALMART_MERCHANT_ID = 45;

function requireEnv(name: keyof NodeJS.ProcessEnv): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function loadKnotConfig(): KnotConfig {
  const environment = (process.env.KNOT_ENV ??
    "development") as KnotEnvironment;
  const baseUrl =
    process.env.KNOT_BASE_URL ??
    `https://${environment === "production" ? "production" : "development"}.knotapi.com`;

  return {
    apiVersion: process.env.KNOT_API_VERSION ?? "2.0",
    baseUrl,
    clientId: requireEnv("KNOT_CLIENT_ID"),
    dataDir: process.env.KNOT_DATA_DIR ?? path.join("data", "knot"),
    defaultExternalUserId: process.env.KNOT_EXTERNAL_USER_ID,
    environment,
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    secret: requireEnv("KNOT_SECRET"),
    sqlitePath:
      process.env.KNOT_SQLITE_PATH ?? path.join("data", "shomi.sqlite"),
    walmartMerchantId: Number(
      process.env.KNOT_WALMART_MERCHANT_ID ??
        process.env.KNOT_SHOPPING_MERCHANT_ID ??
        process.env.KNOT_TRANSACTION_MERCHANT_ID ??
        String(KNOT_WALMART_MERCHANT_ID),
    ),
    webhookPath: process.env.KNOT_WEBHOOK_PATH ?? "/webhooks/knot",
    webhookPort: Number(process.env.KNOT_WEBHOOK_PORT ?? "8787"),
  };
}
