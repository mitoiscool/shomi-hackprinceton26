import dotenv from "dotenv";
import { KnotClient } from "./client.js";
import { loadKnotConfig } from "./config.js";
import { KnotDemoStore } from "./store.js";
import { startKnotWebhookServer } from "./webhooks.js";

dotenv.config();

async function main() {
  const config = loadKnotConfig();
  const client = new KnotClient(config);
  const store = new KnotDemoStore({
    filename: config.sqlitePath,
  });
  const server = startKnotWebhookServer({
    client,
    config,
    store,
  });

  console.log(
    JSON.stringify(
      {
        path: config.webhookPath,
        port: config.webhookPort,
        status: "listening",
      },
      null,
      2,
    ),
  );

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
