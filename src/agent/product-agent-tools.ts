import { tool } from "@langchain/core/tools";
import type { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { z } from "zod";
import type { MemoryStore } from "../memory/types.js";

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
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: MemoryStore;
};

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
          3,
        );
        const normalizedProducts: ProductSearchResult[] = products.map((product) => ({
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

        return JSON.stringify({
          merchant: "walmart",
          products: normalizedProducts,
          resultCount: normalizedProducts.length,
        });
      },
      {
        description:
          "search walmart products semantically and return the 3 most relevant matches with price image and product url use this whenever the user wants to find buy compare or browse products",
        name: "search_walmart_products",
        schema: z.object({
          query: z.string().min(1),
        }),
      },
    ),
  ];
}
