import { tool } from "@langchain/core/tools";
import type { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { z } from "zod";
import type { MemoryStore } from "../memory/types.js";
import {
  fetchProductImage,
  verifyProductImage,
} from "./product-image-verifier.js";

export type ProductSearchResult = {
  availabilityStatus?: string;
  brand?: string;
  categoryPath?: string;
  imageUrl?: string;
  merchantProductId: string;
  name: string;
  offerType?: string;
  priceCurrent?: number;
  priceWas?: number;
  productUrl?: string;
};

type CreateProductAgentToolsOptions = {
  model: ChatGoogleGenerativeAI;
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: MemoryStore;
  userMessageText: string;
};

const CANDIDATE_LIMIT = 5;
const VERIFIED_LIMIT = 3;

function formatProductUrl(canonicalUrl?: string) {
  if (!canonicalUrl) {
    return undefined;
  }

  if (canonicalUrl.startsWith("http://") || canonicalUrl.startsWith("https://")) {
    return canonicalUrl;
  }

  return `https://www.walmart.com${canonicalUrl}`;
}

export function createProductAgentTools(options: CreateProductAgentToolsOptions) {
  return [
    tool(
      async (input) => {
        const queryEmbedding = await options.queryEmbeddings.embedQuery(input.query);
        const products = await options.store.searchMerchantProducts(
          "walmart",
          queryEmbedding,
          CANDIDATE_LIMIT,
        );

        const candidates: ProductSearchResult[] = products.map((product) => ({
          availabilityStatus: product.availabilityStatus,
          brand: product.brand,
          categoryPath: product.categoryPath,
          imageUrl: product.imageUrl,
          merchantProductId: product.merchantProductId,
          name: product.name,
          offerType: product.offerType,
          priceCurrent: product.priceCurrent,
          priceWas: product.priceWas,
          productUrl: formatProductUrl(product.canonicalUrl),
        }));

        const verifications = await Promise.all(
          candidates.map(async (candidate) => {
            if (!candidate.imageUrl) {
              return false;
            }

            const fetched = await fetchProductImage(candidate.imageUrl);

            if (!fetched) {
              return false;
            }

            return verifyProductImage({
              imageBytes: fetched.bytes,
              mimeType: fetched.mimeType,
              model: options.model,
              productName: candidate.name,
              query: options.userMessageText,
            });
          }),
        );

        const verified: ProductSearchResult[] = [];
        for (let i = 0; i < candidates.length && verified.length < VERIFIED_LIMIT; i += 1) {
          if (verifications[i]) {
            verified.push(candidates[i]!);
          }
        }

        console.log("[search_walmart_products] verification", {
          query: input.query,
          candidatesConsidered: candidates.length,
          verifiedCount: verified.length,
        });

        if (verified.length === 0) {
          return JSON.stringify({
            merchant: "walmart",
            note:
              "no products visually matched the user's request. consider calling this tool again with broader or alternative search parameters such as a different color a dropped constraint or synonyms before telling the user nothing was found",
            products: [],
            resultCount: 0,
          });
        }

        return JSON.stringify({
          merchant: "walmart",
          products: verified,
          resultCount: verified.length,
        });
      },
      {
        description:
          "search walmart products semantically and return up to 3 visually verified matches with price image and product url use this whenever the user wants to find buy compare or browse products",
        name: "search_walmart_products",
        schema: z.object({
          query: z.string().min(1),
        }),
      },
    ),
  ];
}
