import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { TaskType } from "@google/generative-ai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";

type WalmartCategoryPathNode = {
  name?: string;
};

type WalmartProduct = {
  availabilityStatus?: string;
  badges?: {
    flags?: Array<{
      text?: string;
    }>;
  };
  brand?: string;
  canonicalUrl?: string;
  category?: {
    categoryPathId?: string;
    path?: WalmartCategoryPathNode[];
  };
  id?: string;
  imageInfo?: {
    allImages?: Array<{
      url?: string;
    }>;
    thumbnailUrl?: string;
  };
  name?: string;
  offerId?: string;
  offerType?: string;
  priceInfo?: {
    currentPrice?: {
      price?: number;
    };
    wasPrice?: {
      price?: number;
    };
  };
  shortDescription?: string;
};

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .map((word) =>
      word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function getCategoryPath(product: WalmartProduct) {
  return (product.category?.path ?? [])
    .map((node) => node.name?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" > ");
}

function getBadgeText(product: WalmartProduct) {
  return (product.badges?.flags ?? [])
    .map((flag) => flag.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

function buildSearchText(product: WalmartProduct) {
  const sections = [
    `title: ${product.name?.trim() ?? "unknown"}`,
    `brand: ${product.brand?.trim() ?? "unknown"}`,
    `merchant: walmart`,
    `category: ${getCategoryPath(product) || "unknown"}`,
    `availability: ${product.availabilityStatus?.trim() ?? "unknown"}`,
    `price: ${product.priceInfo?.currentPrice?.price ?? "unknown"}`,
  ];

  const badges = getBadgeText(product);

  if (badges) {
    sections.push(`badges: ${badges}`);
  }

  if (product.shortDescription?.trim()) {
    sections.push(`description: ${product.shortDescription.trim()}`);
  }

  return sections.join("\n");
}

function getImageUrl(product: WalmartProduct) {
  return (
    product.imageInfo?.thumbnailUrl ??
    product.imageInfo?.allImages?.find((image) => image.url)?.url
  );
}

function resolveDefaultFilename() {
  const candidates = [
    path.join(process.cwd(), "data", "walmartdatav3large.json"),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));

  if (!existing) {
    throw new Error(
      `Could not find a Walmart dataset. Checked: ${candidates.join(", ")}`,
    );
  }

  return existing;
}

async function main() {
  const apiKey = getRequiredEnv("GEMINI_API_KEY");
  const filename = process.argv[2] ?? resolveDefaultFilename();
  const raw = fs.readFileSync(filename, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${filename}`);
  }

  const products = parsed as WalmartProduct[];
  const store = new SqliteMemoryStore();
  const documentEmbeddings = new GoogleGenerativeAIEmbeddings({
    apiKey,
    model: "gemini-embedding-001",
    taskType: TaskType.RETRIEVAL_DOCUMENT,
  });

  let inserted = 0;

  for (const product of products) {
    if (!product.id || !product.name) {
      continue;
    }

    const searchText = buildSearchText(product);
    const [embedding] = await documentEmbeddings.embedDocuments([searchText]);

    await store.upsertMerchantProduct({
      merchant: "walmart",
      merchantProductId: String(product.id),
      canonicalUrl: product.canonicalUrl,
      name: product.name.trim(),
      brand: product.brand?.trim(),
      categoryPathId: product.category?.categoryPathId,
      categoryPath: getCategoryPath(product) || undefined,
      availabilityStatus: product.availabilityStatus?.trim(),
      priceCurrent: product.priceInfo?.currentPrice?.price,
      priceWas: product.priceInfo?.wasPrice?.price,
      imageUrl: getImageUrl(product),
      offerId: product.offerId,
      offerType: product.offerType,
      searchText,
      embedding,
      rawJson: JSON.stringify(product),
    });

    inserted += 1;
  }

  console.log(
    `seeded ${inserted} walmart ${toTitleCase(
      path.basename(filename).includes("hoodie") ? "hoodies" : "products",
    )} into data/shomi.sqlite`,
  );
}

main().catch((error) => {
  console.error("failed to import walmart products", error);
  process.exitCode = 1;
});
