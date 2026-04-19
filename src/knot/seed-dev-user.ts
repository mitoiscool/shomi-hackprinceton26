import dotenv from "dotenv";
import { KnotClient } from "./client.js";
import { loadKnotConfig } from "./config.js";
import { KnotDemoStore } from "./store.js";
import { seedDevUser } from "./shopping-service.js";

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
  const appUserId =
    parseArgValue("--app-user-id") ?? process.env.MY_PHONE_NUMBER ?? "local-cli";
  const externalUserId = parseArgValue("--external-user-id");
  const result = await seedDevUser({
    appUserId,
    client,
    config,
    externalUserId,
    store,
  });

  console.log(
    JSON.stringify(
      {
        appUserId,
        ...result,
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
