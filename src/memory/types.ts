export type ConversationRole = "user" | "assistant";
export type MemoryKind = "fact" | "summary";
export type BasicInfoKey =
  | "name"
  | "location"
  | "budget"
  | "size"
  | "brand_preference"
  | "style_preference"
  | "first_name"
  | "last_name"
  | "phone"
  | "address_line1"
  | "address_line2"
  | "address_city"
  | "address_region"
  | "address_postal_code"
  | "address_country";

export type StoredConversationMessage = {
  id: string;
  userId: string;
  role: ConversationRole;
  text: string;
  createdAt: Date;
  summarized: boolean;
};

export type StoredMemory = {
  id: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  references: string[];
  createdAt: Date;
  updatedAt: Date;
  embedding: number[];
};

export type PromptMemoryContext = {
  recentMessages: StoredConversationMessage[];
  latestSummary?: StoredMemory;
  relevantMemories: StoredMemory[];
};

export type StoredBasicInfo = {
  key: BasicInfoKey;
  userId: string;
  value: string;
  sourceMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredTransactionRecord = {
  id: string;
  amount?: number;
  createdAt: Date;
  currency?: string;
  description: string;
  embedding: number[];
  merchant?: string;
  occurredAt?: Date;
  source?: string;
  title: string;
  updatedAt: Date;
  userId: string;
};

export type StoredMerchantProduct = {
  id: string;
  merchant: string;
  merchantProductId: string;
  canonicalUrl?: string;
  name: string;
  brand?: string;
  categoryPathId?: string;
  categoryPath?: string;
  availabilityStatus?: string;
  priceCurrent?: number;
  priceWas?: number;
  imageUrl?: string;
  offerId?: string;
  offerType?: string;
  searchText: string;
  embedding: number[];
  rawJson: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface MemoryStore {
  appendMessage(
    userId: string,
    role: ConversationRole,
    text: string,
  ): Promise<StoredConversationMessage>;
  getRecentMessages(
    userId: string,
    limit: number,
  ): Promise<StoredConversationMessage[]>;
  getLatestSummary(userId: string): Promise<StoredMemory | undefined>;
  searchMemories(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ): Promise<StoredMemory[]>;
  upsertMemory(
    userId: string,
    kind: MemoryKind,
    content: string,
    references: string[],
    embedding: number[],
  ): Promise<StoredMemory>;
  getSummarizableMessages(
    userId: string,
    keepRecent: number,
    batchSize: number,
  ): Promise<StoredConversationMessage[]>;
  markMessagesSummarized(userId: string, messageIds: string[]): Promise<void>;
  getBasicInfo(userId: string): Promise<StoredBasicInfo[]>;
  upsertBasicInfo(
    userId: string,
    key: BasicInfoKey,
    value: string,
    sourceMessageId?: string,
  ): Promise<StoredBasicInfo>;
  searchSummaryMemories(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ): Promise<StoredMemory[]>;
  searchTransactions(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ): Promise<StoredTransactionRecord[]>;
  upsertTransaction(
    userId: string,
    transaction: Omit<
      StoredTransactionRecord,
      "createdAt" | "embedding" | "id" | "updatedAt" | "userId"
    >,
    embedding: number[],
  ): Promise<StoredTransactionRecord>;
  searchMerchantProducts(
    merchant: string,
    queryEmbedding: number[],
    limit: number,
    options?: {
      categoryPathIncludes?: string;
    },
  ): Promise<StoredMerchantProduct[]>;
  upsertMerchantProduct(
    product: Omit<StoredMerchantProduct, "createdAt" | "id" | "updatedAt">,
  ): Promise<StoredMerchantProduct>;
}
