import dotenv from "dotenv";
import { chatGuid } from "@photon-ai/advanced-imessage";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

dotenv.config();

type AppConfig = {
  spectrumProjectId: string;
  spectrumSecretKey: string;
  myPhoneNumber: string;
};

function requireEnv(name: keyof NodeJS.ProcessEnv): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadConfig(): AppConfig {
  return {
    spectrumProjectId: requireEnv("SPECTRUM_PROJECT_ID"),
    spectrumSecretKey:
      process.env.SPECTRUM_SECRET_KEY ?? requireEnv("SPECTRUM_API_KEY"),
    myPhoneNumber: requireEnv("MY_PHONE_NUMBER"),
  };
}

function summarizeMessage(message: {
  id: string;
  platform: string;
  content: { type: string; text?: string };
  sender: { id: string };
  timestamp: Date;
}) {
  return {
    id: message.id,
    platform: message.platform,
    from: message.sender.id,
    contentType: message.content.type,
    text: message.content.type === "text" ? message.content.text ?? "" : "",
    timestamp: message.timestamp.toISOString(),
  };
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markSpaceAsRead(app: Awaited<ReturnType<typeof Spectrum>>, spaceId: string) {
  const platformEntry = app.__internal.platforms.get("iMessage");

  if (!platformEntry) {
    return;
  }

  const client = platformEntry.client as {
    chats?: {
      markRead: (chat: ReturnType<typeof chatGuid>) => Promise<void>;
    };
  } | Array<{
    chats: {
      markRead: (chat: ReturnType<typeof chatGuid>) => Promise<void>;
    };
  }>;

  const remote = Array.isArray(client) ? client[0] : client;

  if (!remote?.chats?.markRead) {
    return;
  }

  await remote.chats.markRead(chatGuid(spaceId));
}

async function markSpaceAsReadWithHumanDelay(
  app: Awaited<ReturnType<typeof Spectrum>>,
  spaceId: string,
) {
  const delayMs = randomInt(500, 1000);
  await sleep(delayMs);
  await markSpaceAsRead(app, spaceId);
  return delayMs;
}

async function main() {
  const config = loadConfig();

  const app = await Spectrum({
    projectId: config.spectrumProjectId,
    projectSecret: config.spectrumSecretKey,
    providers: [imessage.config()],
  });

  console.log("Spectrum iMessage bot started.");
  console.log(
    JSON.stringify(
      {
        spectrumProjectId: config.spectrumProjectId,
        spectrumSecretKeyConfigured: config.spectrumSecretKey.length > 0,
        myPhoneNumber: config.myPhoneNumber,
      },
      null,
      2,
    ),
  );

  try {
    const im = imessage(app);
    const me = await im.user(config.myPhoneNumber);
    const mySpace = await im.space(me);

    await mySpace.send("started");
    console.log("sent startup message", {
      to: config.myPhoneNumber,
      message: "started",
    });
  } catch (error) {
    console.error("startup send failed", error);
  }

  process.on("SIGINT", async () => {
    console.log("Shutting down Spectrum client...");
    await app.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("Shutting down Spectrum client...");
    await app.stop();
    process.exit(0);
  });

  for await (const [space, message] of app.messages) {
    console.log("[message]", summarizeMessage(message));

    if (message.platform !== "iMessage") {
      continue;
    }

    if (message.content.type !== "text") {
      continue;
    }

    const text = message.content.text.trim();

    if (!text) {
      continue;
    }

    try {
      const readDelayMs = await markSpaceAsReadWithHumanDelay(app, space.id);

      console.log("read", {
        spaceId: space.id,
        messageId: message.id,
        from: message.sender.id,
        readDelayMs,
      });
    } catch (error) {
      console.error("read failed", error);
    }
  }
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
