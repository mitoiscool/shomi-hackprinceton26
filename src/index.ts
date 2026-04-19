import dotenv from "dotenv";
import { chatGuid } from "@photon-ai/advanced-imessage";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { ShomiAgent } from "./agent/shomi-agent.js";
import { buildLabelledProductGif } from "./agent/product-gif-builder.js";

dotenv.config();

type AppConfig = {
  contextCharLimit: number;
  spectrumProjectId: string;
  spectrumSecretKey: string;
  geminiApiKey: string;
  geminiModel: string;
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
    contextCharLimit: Number(process.env.PROMPT_CONTEXT_LIMIT ?? "100000"),
    spectrumProjectId: requireEnv("SPECTRUM_PROJECT_ID"),
    spectrumSecretKey:
      process.env.SPECTRUM_SECRET_KEY ?? requireEnv("SPECTRUM_API_KEY"),
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
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

const TOOL_FAILURE_REPLY =
  "Caius messed something up, my tools are failing me rn. he should probably lock in";

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepForHumanReplyDelay() {
  const delayMs = randomInt(500, 1000);
  await sleep(delayMs);
  return delayMs;
}

type RemoteIMessageClient = {
  attachments?: {
    upload: (input: {
      data: Uint8Array;
      fileName: string;
      mimeType: string;
    }) => Promise<{
      guid: string;
    }>;
  };
  chats?: {
    markRead: (chat: ReturnType<typeof chatGuid>) => Promise<void>;
  };
  messages?: {
    send: (
      chat: ReturnType<typeof chatGuid>,
      text: string,
      options?: {
        attachment?: string;
        replyTo?: string;
      },
    ) => Promise<{
      guid: string;
    }>;
  };
};

function getRemoteIMessageClient(app: Awaited<ReturnType<typeof Spectrum>>) {
  const platformEntry = app.__internal.platforms.get("iMessage");

  if (!platformEntry) {
    return undefined;
  }

  const client = platformEntry.client as RemoteIMessageClient | RemoteIMessageClient[];
  return Array.isArray(client) ? client[0] : client;
}

async function markSpaceAsRead(app: Awaited<ReturnType<typeof Spectrum>>, spaceId: string) {
  const remote = getRemoteIMessageClient(app);

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

async function sendProductGifAndThreadedReply(
  app: Awaited<ReturnType<typeof Spectrum>>,
  spaceId: string,
  gifBytes: Uint8Array,
  fileName: string,
  mimeType: string,
  replyText: string,
) {
  const remote = getRemoteIMessageClient(app);

  if (!remote?.attachments?.upload || !remote?.messages?.send) {
    return false;
  }

  const attachment = await remote.attachments.upload({
    data: gifBytes,
    fileName,
    mimeType,
  });
  const imageReceipt = await remote.messages.send(chatGuid(spaceId), "", {
    attachment: attachment.guid,
  });

  await remote.messages.send(chatGuid(spaceId), replyText, {
    replyTo: imageReceipt.guid,
  });

  return true;
}

async function handleIncomingMessage(
  app: Awaited<ReturnType<typeof Spectrum>>,
  agent: ShomiAgent,
  space: {
    id: string;
    send: (...content: [string, ...string[]]) => Promise<void>;
  },
  message: {
    id: string;
    sender: { id: string };
  },
  text: string,
) {
  const readPromise = markSpaceAsReadWithHumanDelay(app, space.id);
  const response = await agent.respond(message.sender.id, text);
  const readDelayMs = await readPromise;
  const sentParts: string[] = [];
  const replyDelayMs: number[] = [];
  let sentAttachment = false;

  if (response.productResults.length > 0 && response.textParts.length > 0) {
    const frames = response.productResults
      .filter(
        (product): product is typeof product & { imageUrl: string } =>
          typeof product.imageUrl === "string" && product.imageUrl.length > 0,
      )
      .map((product, idx) => ({
        imageUrl: product.imageUrl,
        index: idx + 1,
      }));

    if (frames.length > 0) {
      try {
        const gif = await buildLabelledProductGif(frames);

        if (gif) {
          const delayMs = await sleepForHumanReplyDelay();
          const threaded = await sendProductGifAndThreadedReply(
            app,
            space.id,
            gif.data,
            gif.fileName,
            gif.mimeType,
            response.textParts[0]!,
          );

          if (threaded) {
            sentAttachment = true;
            sentParts.push(response.textParts[0]!);
            replyDelayMs.push(delayMs);
          }
        }
      } catch (error) {
        console.error("product gif send failed", {
          error,
          spaceId: space.id,
        });
      }
    }
  }

  const remainingParts = sentAttachment
    ? response.textParts.slice(1)
    : response.textParts;

  for (const part of remainingParts) {
    const delayMs = await sleepForHumanReplyDelay();
    await space.send(part);
    sentParts.push(part);
    replyDelayMs.push(delayMs);
  }

  console.log("replied", {
    spaceId: space.id,
    messageId: message.id,
    from: message.sender.id,
    reply: response.rawText,
    sentAttachment,
    sentParts,
    readDelayMs,
    replyDelayMs,
  });
}

async function main() {
  const config = loadConfig();
  const agent = new ShomiAgent({
    apiKey: config.geminiApiKey,
    contextCharLimit: config.contextCharLimit,
    model: config.geminiModel,
  });

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
        contextCharLimit: config.contextCharLimit,
        geminiModel: config.geminiModel,
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

    void handleIncomingMessage(app, agent, space, message, text).catch(async (error) => {
      console.error("message handler failed", {
        spaceId: space.id,
        messageId: message.id,
        from: message.sender.id,
        error,
      });

      try {
        await sleepForHumanReplyDelay();
        await space.send(TOOL_FAILURE_REPLY);
      } catch (sendError) {
        console.error("failed to send fallback reply", {
          spaceId: space.id,
          messageId: message.id,
          from: message.sender.id,
          error: sendError,
        });
      }
    });
  }
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
