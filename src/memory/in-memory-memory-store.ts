import crypto from "node:crypto";
import type {
  BasicInfoKey,
  ConversationRole,
  MemoryKind,
  MemoryStore,
  StoredBasicInfo,
  StoredConversationMessage,
  StoredMerchantProduct,
  StoredMemory,
  StoredTransactionRecord,
} from "./types.js";

type ConversationState = {
  basicInfo: StoredBasicInfo[];
  merchantProducts: StoredMerchantProduct[];
  memories: StoredMemory[];
  messages: StoredConversationMessage[];
  transactions: StoredTransactionRecord[];
};

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  const size = Math.min(left.length, right.length);

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly conversations = new Map<string, ConversationState>();

  private getConversation(userId: string): ConversationState {
    const existing = this.conversations.get(userId);

    if (existing) {
      return existing;
    }

    const created: ConversationState = {
      basicInfo: [],
      merchantProducts: [],
      memories: [],
      messages: [],
      transactions: [],
    };

    this.conversations.set(userId, created);
    return created;
  }

  async appendMessage(userId: string, role: ConversationRole, text: string) {
    const conversation = this.getConversation(userId);
    const message: StoredConversationMessage = {
      id: crypto.randomUUID(),
      userId,
      role,
      text,
      createdAt: new Date(),
      summarized: false,
    };

    conversation.messages.push(message);
    return message;
  }

  async getRecentMessages(userId: string, limit: number) {
    const conversation = this.getConversation(userId);
    return conversation.messages.slice(-limit);
  }

  async getLatestSummary(userId: string) {
    const conversation = this.getConversation(userId);
    return conversation.memories
      .filter((memory) => memory.kind === "summary")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  async searchMemories(userId: string, queryEmbedding: number[], limit: number) {
    const conversation = this.getConversation(userId);

    return conversation.memories
      .map((memory) => ({
        memory,
        score: cosineSimilarity(memory.embedding, queryEmbedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  async upsertMemory(
    userId: string,
    kind: MemoryKind,
    content: string,
    references: string[],
    embedding: number[],
  ) {
    const normalizedContent = content.trim().toLowerCase();
    const conversation = this.getConversation(userId);
    const existing = conversation.memories.find(
      (memory) =>
        memory.kind === kind &&
        memory.content.trim().toLowerCase() === normalizedContent,
    );

    if (existing) {
      existing.references = Array.from(
        new Set([...existing.references, ...references]),
      );
      existing.embedding = embedding;
      existing.updatedAt = new Date();
      return existing;
    }

    const memory: StoredMemory = {
      id: crypto.randomUUID(),
      userId,
      kind,
      content: content.trim(),
      references: Array.from(new Set(references)),
      createdAt: new Date(),
      updatedAt: new Date(),
      embedding,
    };

    conversation.memories.push(memory);
    return memory;
  }

  async getSummarizableMessages(
    userId: string,
    keepRecent: number,
    batchSize: number,
  ) {
    const conversation = this.getConversation(userId);
    const unsummarized = conversation.messages.filter((message) => !message.summarized);
    const eligible = unsummarized.slice(0, Math.max(0, unsummarized.length - keepRecent));
    return eligible.slice(0, batchSize);
  }

  async markMessagesSummarized(userId: string, messageIds: string[]) {
    const conversation = this.getConversation(userId);
    const ids = new Set(messageIds);

    for (const message of conversation.messages) {
      if (ids.has(message.id)) {
        message.summarized = true;
      }
    }
  }

  async getBasicInfo(userId: string) {
    const conversation = this.getConversation(userId);
    return [...conversation.basicInfo];
  }

  async upsertBasicInfo(
    userId: string,
    key: BasicInfoKey,
    value: string,
    sourceMessageId?: string,
  ) {
    const conversation = this.getConversation(userId);
    const existing = conversation.basicInfo.find((item) => item.key === key);

    if (existing) {
      existing.value = value.trim();
      existing.sourceMessageId = sourceMessageId;
      existing.updatedAt = new Date();
      return existing;
    }

    const info: StoredBasicInfo = {
      key,
      userId,
      value: value.trim(),
      sourceMessageId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    conversation.basicInfo.push(info);
    return info;
  }

  async searchSummaryMemories(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ) {
    const conversation = this.getConversation(userId);

    return conversation.memories
      .filter((memory) => memory.kind === "summary")
      .map((memory) => ({
        memory,
        score: cosineSimilarity(memory.embedding, queryEmbedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  async searchTransactions(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ) {
    const conversation = this.getConversation(userId);

    return conversation.transactions
      .map((transaction) => ({
        score: cosineSimilarity(transaction.embedding, queryEmbedding),
        transaction,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.transaction);
  }

  async upsertTransaction(
    userId: string,
    transaction: Omit<
      StoredTransactionRecord,
      "createdAt" | "embedding" | "id" | "updatedAt" | "userId"
    >,
    embedding: number[],
  ) {
    const conversation = this.getConversation(userId);
    const existing = conversation.transactions.find(
      (item) =>
        item.title.trim().toLowerCase() === transaction.title.trim().toLowerCase() &&
        item.description.trim().toLowerCase() ===
          transaction.description.trim().toLowerCase(),
    );

    if (existing) {
      existing.amount = transaction.amount;
      existing.currency = transaction.currency;
      existing.embedding = embedding;
      existing.merchant = transaction.merchant;
      existing.occurredAt = transaction.occurredAt;
      existing.source = transaction.source;
      existing.updatedAt = new Date();
      return existing;
    }

    const stored: StoredTransactionRecord = {
      id: crypto.randomUUID(),
      amount: transaction.amount,
      createdAt: new Date(),
      currency: transaction.currency,
      description: transaction.description,
      embedding,
      merchant: transaction.merchant,
      occurredAt: transaction.occurredAt,
      source: transaction.source,
      title: transaction.title,
      updatedAt: new Date(),
      userId,
    };

    conversation.transactions.push(stored);
    return stored;
  }

  async searchMerchantProducts(
    merchant: string,
    queryEmbedding: number[],
    limit: number,
    options?: {
      categoryPathIncludes?: string;
    },
  ) {
    const normalizedMerchant = merchant.trim().toLowerCase();
    const categoryFilter = options?.categoryPathIncludes?.trim().toLowerCase();
    const allProducts = Array.from(this.conversations.values()).flatMap(
      (conversation) => conversation.merchantProducts,
    );

    return allProducts
      .filter((product) => product.merchant.trim().toLowerCase() === normalizedMerchant)
      .filter((product) => {
        if (!categoryFilter) {
          return true;
        }

        return product.categoryPath?.toLowerCase().includes(categoryFilter) ?? false;
      })
      .map((product) => ({
        product,
        score: cosineSimilarity(product.embedding, queryEmbedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.product);
  }

  async upsertMerchantProduct(
    product: Omit<StoredMerchantProduct, "createdAt" | "id" | "updatedAt">,
  ) {
    const conversation = this.getConversation(`merchant:${product.merchant}`);
    const existing = conversation.merchantProducts.find(
      (item) =>
        item.merchant.trim().toLowerCase() === product.merchant.trim().toLowerCase() &&
        item.merchantProductId.trim().toLowerCase() ===
          product.merchantProductId.trim().toLowerCase(),
    );

    if (existing) {
      existing.availabilityStatus = product.availabilityStatus;
      existing.brand = product.brand;
      existing.canonicalUrl = product.canonicalUrl;
      existing.categoryPath = product.categoryPath;
      existing.categoryPathId = product.categoryPathId;
      existing.embedding = product.embedding;
      existing.imageUrl = product.imageUrl;
      existing.name = product.name;
      existing.offerId = product.offerId;
      existing.offerType = product.offerType;
      existing.priceCurrent = product.priceCurrent;
      existing.priceWas = product.priceWas;
      existing.rawJson = product.rawJson;
      existing.searchText = product.searchText;
      existing.updatedAt = new Date();
      return existing;
    }

    const stored: StoredMerchantProduct = {
      ...product,
      createdAt: new Date(),
      id: crypto.randomUUID(),
      updatedAt: new Date(),
    };

    conversation.merchantProducts.push(stored);
    return stored;
  }
}
