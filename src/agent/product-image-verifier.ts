import { HumanMessage } from "@langchain/core/messages";
import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export type FetchedProductImage = {
  bytes: Uint8Array;
  mimeType: string;
};

export type VerifyProductImageOptions = {
  imageBytes: Uint8Array;
  mimeType: string;
  model: ChatGoogleGenerativeAI;
  productName: string;
  query: string;
  timeoutMs?: number;
};

const VERIFIER_TIMEOUT_MS = 4_000;

export async function fetchProductImage(
  imageUrl: string,
  timeoutMs = 4_000,
): Promise<FetchedProductImage | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(imageUrl, { signal: controller.signal });

    if (!response.ok) {
      return undefined;
    }

    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mimeType };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("verifier timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function verifyProductImage(
  options: VerifyProductImageOptions,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? VERIFIER_TIMEOUT_MS;
  const base64 = Buffer.from(options.imageBytes).toString("base64");
  const dataUrl = `data:${options.mimeType};base64,${base64}`;

  const promptText = [
    "you are a strict shopping product image checker",
    "the user is searching for: " + options.query,
    "the candidate product is named: " + options.productName,
    "look at the attached product photo and decide if it visually matches the user's search",
    "pay attention to color, type of item, and any other obvious attributes mentioned in the search",
    "reply with a single lowercase token: yes if it matches, no if it does not match or you are unsure",
    "do not output anything else",
  ].join("\n");

  const message = new HumanMessage({
    content: [
      { type: "text", text: promptText },
      { type: "image_url", image_url: dataUrl },
    ],
  });

  try {
    const response = await withTimeout(options.model.invoke([message]), timeoutMs);
    const raw = typeof response.text === "string" ? response.text : "";
    return raw.trim().toLowerCase().startsWith("yes");
  } catch {
    return false;
  }
}
