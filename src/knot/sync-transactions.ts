import dotenv from "dotenv";
import { KnotClient } from "./client.js";
import { loadKnotConfig } from "./config.js";
import { KnotDemoStore } from "./store.js";
import { syncTransactionsForUser } from "./transaction-service.js";

dotenv.config();

function parseArgValue(flag: string) {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main() {
  const config = loadKnotConfig();
  const client = new KnotClient(config);
  const store = new KnotDemoStore({
    filename: config.sqlitePath,
  });
  const appUserId = parseArgValue("--app-user-id") ?? "local-cli";
  const externalUserId =
    parseArgValue("--external-user-id") ??
    config.defaultExternalUserId ??
    store.resolveExternalUserId(appUserId);

  if (!externalUserId) {
    throw new Error(
      "No external user id found. Seed a dev user first or set KNOT_EXTERNAL_USER_ID.",
    );
  }

  await syncTransactionsForUser({
    client,
    config,
    externalUserId,
    store,
  });

  console.log(
    JSON.stringify(
      {
        externalUserId,
        merchantId: config.walmartMerchantId,
        status: "synced",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
