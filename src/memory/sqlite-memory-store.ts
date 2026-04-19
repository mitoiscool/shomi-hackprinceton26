import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

type SqliteMemoryStoreOptions = {
  filename?: string;
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

function parseJsonArray(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toStoredMessage(row: Record<string, unknown>): StoredConversationMessage {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    role: row.role as ConversationRole,
    text: String(row.text),
    createdAt: new Date(String(row.created_at)),
    summarized: Number(row.summarized) === 1,
  };
}

function toStoredMemory(row: Record<string, unknown>): StoredMemory {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind as MemoryKind,
    content: String(row.content),
    references: parseJsonArray(row.references_json as string | null) as string[],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    embedding: parseJsonArray(row.embedding_json as string | null) as number[],
  };
}

function toStoredTransaction(row: Record<string, unknown>): StoredTransactionRecord {
  return {
    id: String(row.id),
    amount:
      row.amount === null || row.amount === undefined
        ? undefined
        : Number(row.amount),
    createdAt: new Date(String(row.created_at)),
    currency:
      row.currency === null || row.currency === undefined
        ? undefined
        : String(row.currency),
    description: String(row.description),
    embedding: parseJsonArray(row.embedding_json as string | null) as number[],
    merchant:
      row.merchant === null || row.merchant === undefined
        ? undefined
        : String(row.merchant),
    occurredAt:
      row.occurred_at === null || row.occurred_at === undefined
        ? undefined
        : new Date(String(row.occurred_at)),
    source:
      row.source === null || row.source === undefined
        ? undefined
        : String(row.source),
    title: String(row.title),
    updatedAt: new Date(String(row.updated_at)),
    userId: String(row.user_id),
  };
}

function toStoredMerchantProduct(
  row: Record<string, unknown>,
): StoredMerchantProduct {
  return {
    id: String(row.id),
    merchant: String(row.merchant),
    merchantProductId: String(row.merchant_product_id),
    canonicalUrl:
      row.canonical_url === null || row.canonical_url === undefined
        ? undefined
        : String(row.canonical_url),
    name: String(row.name),
    brand:
      row.brand === null || row.brand === undefined ? undefined : String(row.brand),
    categoryPathId:
      row.category_path_id === null || row.category_path_id === undefined
        ? undefined
        : String(row.category_path_id),
    categoryPath:
      row.category_path === null || row.category_path === undefined
        ? undefined
        : String(row.category_path),
    availabilityStatus:
      row.availability_status === null || row.availability_status === undefined
        ? undefined
        : String(row.availability_status),
    priceCurrent:
      row.price_current === null || row.price_current === undefined
        ? undefined
        : Number(row.price_current),
    priceWas:
      row.price_was === null || row.price_was === undefined
        ? undefined
        : Number(row.price_was),
    imageUrl:
      row.image_url === null || row.image_url === undefined
        ? undefined
        : String(row.image_url),
    offerId:
      row.offer_id === null || row.offer_id === undefined
        ? undefined
        : String(row.offer_id),
    offerType:
      row.offer_type === null || row.offer_type === undefined
        ? undefined
        : String(row.offer_type),
    searchText: String(row.search_text),
    embedding: parseJsonArray(row.embedding_json as string | null) as number[],
    rawJson: String(row.raw_json),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteMemoryStoreOptions = {}) {
    const filename =
      options.filename ?? path.join(process.cwd(), "data", "shomi.sqlite");

    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists messages (
        id text primary key,
        user_id text not null,
        role text not null,
        text text not null,
        created_at text not null,
        summarized integer not null default 0
      );

      create index if not exists idx_messages_user_created_at
        on messages (user_id, created_at);

      create table if not exists memories (
        id text primary key,
        user_id text not null,
        kind text not null,
        content text not null,
        references_json text not null,
        embedding_json text not null,
        content_normalized text not null,
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists idx_memories_user_kind_content
        on memories (user_id, kind, content_normalized);

      create table if not exists basic_info (
        user_id text not null,
        key text not null,
        value text not null,
        source_message_id text,
        created_at text not null,
        updated_at text not null,
        primary key (user_id, key)
      );

      create table if not exists transactions (
        id text primary key,
        user_id text not null,
        title text not null,
        description text not null,
        merchant text,
        amount real,
        currency text,
        source text,
        occurred_at text,
        embedding_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_transactions_user_created_at
        on transactions (user_id, created_at);

      create table if not exists merchant_products (
        id text primary key,
        merchant text not null,
        merchant_product_id text not null,
        canonical_url text,
        name text not null,
        brand text,
        category_path_id text,
        category_path text,
        availability_status text,
        price_current real,
        price_was real,
        image_url text,
        offer_id text,
        offer_type text,
        search_text text not null,
        embedding_json text not null,
        raw_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists idx_merchant_products_merchant_product_id
        on merchant_products (merchant, merchant_product_id);

      create index if not exists idx_merchant_products_merchant_category
        on merchant_products (merchant, category_path);
    `);
  }

  async appendMessage(userId: string, role: ConversationRole, text: string) {
    const message: StoredConversationMessage = {
      id: crypto.randomUUID(),
      userId,
      role,
      text,
      createdAt: new Date(),
      summarized: false,
    };

    this.db
      .prepare(
        `
          insert into messages (id, user_id, role, text, created_at, summarized)
          values (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        message.userId,
        message.role,
        message.text,
        message.createdAt.toISOString(),
        0,
      );

    return message;
  }

  async getRecentMessages(userId: string, limit: number) {
    const rows = this.db
      .prepare(
        `
          select id, user_id, role, text, created_at, summarized
          from messages
          where user_id = ?
          order by created_at desc
          limit ?
        `,
      )
      .all(userId, limit) as Record<string, unknown>[];

    return rows.map(toStoredMessage).reverse();
  }

  async getLatestSummary(userId: string) {
    const row = this.db
      .prepare(
        `
          select id, user_id, kind, content, references_json, embedding_json, created_at, updated_at
          from memories
          where user_id = ? and kind = 'summary'
          order by updated_at desc
          limit 1
        `,
      )
      .get(userId) as Record<string, unknown> | undefined;

    return row ? toStoredMemory(row) : undefined;
  }

  async searchMemories(userId: string, queryEmbedding: number[], limit: number) {
    const rows = this.db
      .prepare(
        `
          select id, user_id, kind, content, references_json, embedding_json, created_at, updated_at
          from memories
          where user_id = ?
        `,
      )
      .all(userId) as Record<string, unknown>[];

    return rows
      .map(toStoredMemory)
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
    const normalized = content.trim().toLowerCase();
    const existing = this.db
      .prepare(
        `
          select id, user_id, kind, content, references_json, embedding_json, created_at, updated_at
          from memories
          where user_id = ? and kind = ? and content_normalized = ?
          limit 1
        `,
      )
      .get(userId, kind, normalized) as Record<string, unknown> | undefined;

    if (existing) {
      const stored = toStoredMemory(existing);
      const mergedReferences = Array.from(
        new Set([...stored.references, ...references]),
      );
      const updatedAt = new Date();

      this.db
        .prepare(
          `
            update memories
            set references_json = ?, embedding_json = ?, updated_at = ?
            where id = ?
          `,
        )
        .run(
          JSON.stringify(mergedReferences),
          JSON.stringify(embedding),
          updatedAt.toISOString(),
          stored.id,
        );

      return {
        ...stored,
        references: mergedReferences,
        embedding,
        updatedAt,
      };
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

    this.db
      .prepare(
        `
          insert into memories (
            id,
            user_id,
            kind,
            content,
            references_json,
            embedding_json,
            content_normalized,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        memory.id,
        memory.userId,
        memory.kind,
        memory.content,
        JSON.stringify(memory.references),
        JSON.stringify(memory.embedding),
        normalized,
        memory.createdAt.toISOString(),
        memory.updatedAt.toISOString(),
      );

    return memory;
  }

  async getSummarizableMessages(
    userId: string,
    keepRecent: number,
    batchSize: number,
  ) {
    const rows = this.db
      .prepare(
        `
          select id, user_id, role, text, created_at, summarized
          from messages
          where user_id = ? and summarized = 0
          order by created_at asc
        `,
      )
      .all(userId) as Record<string, unknown>[];

    const unsummarized = rows.map(toStoredMessage);
    const eligible = unsummarized.slice(
      0,
      Math.max(0, unsummarized.length - keepRecent),
    );

    return eligible.slice(0, batchSize);
  }

  async markMessagesSummarized(userId: string, messageIds: string[]) {
    if (messageIds.length === 0) {
      return;
    }

    const statement = this.db.prepare(
      `update messages set summarized = 1 where user_id = ? and id = ?`,
    );

    this.db.exec("begin");

    try {
      for (const id of messageIds) {
        statement.run(userId, id);
      }

      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async getBasicInfo(userId: string) {
    const rows = this.db
      .prepare(
        `
          select user_id, key, value, source_message_id, created_at, updated_at
          from basic_info
          where user_id = ?
          order by key asc
        `,
      )
      .all(userId) as Record<string, unknown>[];

    return rows.map(
      (row): StoredBasicInfo => ({
        key: row.key as BasicInfoKey,
        userId: String(row.user_id),
        value: String(row.value),
        sourceMessageId:
          row.source_message_id === null
            ? undefined
            : String(row.source_message_id),
        createdAt: new Date(String(row.created_at)),
        updatedAt: new Date(String(row.updated_at)),
      }),
    );
  }

  async upsertBasicInfo(
    userId: string,
    key: BasicInfoKey,
    value: string,
    sourceMessageId?: string,
  ) {
    const existing = this.db
      .prepare(
        `
          select user_id, key, value, source_message_id, created_at, updated_at
          from basic_info
          where user_id = ? and key = ?
          limit 1
        `,
      )
      .get(userId, key) as Record<string, unknown> | undefined;

    const now = new Date();

    if (existing) {
      this.db
        .prepare(
          `
            update basic_info
            set value = ?, source_message_id = ?, updated_at = ?
            where user_id = ? and key = ?
          `,
        )
        .run(value.trim(), sourceMessageId ?? null, now.toISOString(), userId, key);

      return {
        key,
        userId,
        value: value.trim(),
        sourceMessageId,
        createdAt: new Date(String(existing.created_at)),
        updatedAt: now,
      };
    }

    this.db
      .prepare(
        `
          insert into basic_info (
            user_id,
            key,
            value,
            source_message_id,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        userId,
        key,
        value.trim(),
        sourceMessageId ?? null,
        now.toISOString(),
        now.toISOString(),
      );

    return {
      key,
      userId,
      value: value.trim(),
      sourceMessageId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async searchSummaryMemories(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ) {
    const rows = this.db
      .prepare(
        `
          select id, user_id, kind, content, references_json, embedding_json, created_at, updated_at
          from memories
          where user_id = ? and kind = 'summary'
        `,
      )
      .all(userId) as Record<string, unknown>[];

    return rows
      .map(toStoredMemory)
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
    const rows = this.db
      .prepare(
        `
          select
            id,
            user_id,
            title,
            description,
            merchant,
            amount,
            currency,
            source,
            occurred_at,
            embedding_json,
            created_at,
            updated_at
          from transactions
          where user_id = ?
        `,
      )
      .all(userId) as Record<string, unknown>[];

    return rows
      .map(toStoredTransaction)
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
    const existing = this.db
      .prepare(
        `
          select
            id,
            user_id,
            title,
            description,
            merchant,
            amount,
            currency,
            source,
            occurred_at,
            embedding_json,
            created_at,
            updated_at
          from transactions
          where user_id = ? and title = ? and description = ?
          limit 1
        `,
      )
      .get(userId, transaction.title, transaction.description) as
      | Record<string, unknown>
      | undefined;

    const now = new Date();

    if (existing) {
      const stored = toStoredTransaction(existing);

      this.db
        .prepare(
          `
            update transactions
            set merchant = ?, amount = ?, currency = ?, source = ?, occurred_at = ?, embedding_json = ?, updated_at = ?
            where id = ?
          `,
        )
        .run(
          transaction.merchant ?? null,
          transaction.amount ?? null,
          transaction.currency ?? null,
          transaction.source ?? null,
          transaction.occurredAt?.toISOString() ?? null,
          JSON.stringify(embedding),
          now.toISOString(),
          stored.id,
        );

      return {
        ...stored,
        amount: transaction.amount,
        currency: transaction.currency,
        embedding,
        merchant: transaction.merchant,
        occurredAt: transaction.occurredAt,
        source: transaction.source,
        updatedAt: now,
      };
    }

    const stored: StoredTransactionRecord = {
      id: crypto.randomUUID(),
      amount: transaction.amount,
      createdAt: now,
      currency: transaction.currency,
      description: transaction.description,
      embedding,
      merchant: transaction.merchant,
      occurredAt: transaction.occurredAt,
      source: transaction.source,
      title: transaction.title,
      updatedAt: now,
      userId,
    };

    this.db
      .prepare(
        `
          insert into transactions (
            id,
            user_id,
            title,
            description,
            merchant,
            amount,
            currency,
            source,
            occurred_at,
            embedding_json,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        stored.id,
        stored.userId,
        stored.title,
        stored.description,
        stored.merchant ?? null,
        stored.amount ?? null,
        stored.currency ?? null,
        stored.source ?? null,
        stored.occurredAt?.toISOString() ?? null,
        JSON.stringify(stored.embedding),
        stored.createdAt.toISOString(),
        stored.updatedAt.toISOString(),
      );

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
    const categoryFilter = options?.categoryPathIncludes?.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `
          select
            id,
            merchant,
            merchant_product_id,
            canonical_url,
            name,
            brand,
            category_path_id,
            category_path,
            availability_status,
            price_current,
            price_was,
            image_url,
            offer_id,
            offer_type,
            search_text,
            embedding_json,
            raw_json,
            created_at,
            updated_at
          from merchant_products
          where lower(merchant) = lower(?)
        `,
      )
      .all(merchant) as Record<string, unknown>[];

    return rows
      .map(toStoredMerchantProduct)
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
    const existing = this.db
      .prepare(
        `
          select
            id,
            merchant,
            merchant_product_id,
            canonical_url,
            name,
            brand,
            category_path_id,
            category_path,
            availability_status,
            price_current,
            price_was,
            image_url,
            offer_id,
            offer_type,
            search_text,
            embedding_json,
            raw_json,
            created_at,
            updated_at
          from merchant_products
          where lower(merchant) = lower(?) and merchant_product_id = ?
          limit 1
        `,
      )
      .get(product.merchant, product.merchantProductId) as
      | Record<string, unknown>
      | undefined;

    const now = new Date();

    if (existing) {
      const stored = toStoredMerchantProduct(existing);

      this.db
        .prepare(
          `
            update merchant_products
            set
              canonical_url = ?,
              name = ?,
              brand = ?,
              category_path_id = ?,
              category_path = ?,
              availability_status = ?,
              price_current = ?,
              price_was = ?,
              image_url = ?,
              offer_id = ?,
              offer_type = ?,
              search_text = ?,
              embedding_json = ?,
              raw_json = ?,
              updated_at = ?
            where id = ?
          `,
        )
        .run(
          product.canonicalUrl ?? null,
          product.name,
          product.brand ?? null,
          product.categoryPathId ?? null,
          product.categoryPath ?? null,
          product.availabilityStatus ?? null,
          product.priceCurrent ?? null,
          product.priceWas ?? null,
          product.imageUrl ?? null,
          product.offerId ?? null,
          product.offerType ?? null,
          product.searchText,
          JSON.stringify(product.embedding),
          product.rawJson,
          now.toISOString(),
          stored.id,
        );

      return {
        ...stored,
        ...product,
        updatedAt: now,
      };
    }

    const stored: StoredMerchantProduct = {
      ...product,
      createdAt: now,
      id: crypto.randomUUID(),
      updatedAt: now,
    };

    this.db
      .prepare(
        `
          insert into merchant_products (
            id,
            merchant,
            merchant_product_id,
            canonical_url,
            name,
            brand,
            category_path_id,
            category_path,
            availability_status,
            price_current,
            price_was,
            image_url,
            offer_id,
            offer_type,
            search_text,
            embedding_json,
            raw_json,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        stored.id,
        stored.merchant,
        stored.merchantProductId,
        stored.canonicalUrl ?? null,
        stored.name,
        stored.brand ?? null,
        stored.categoryPathId ?? null,
        stored.categoryPath ?? null,
        stored.availabilityStatus ?? null,
        stored.priceCurrent ?? null,
        stored.priceWas ?? null,
        stored.imageUrl ?? null,
        stored.offerId ?? null,
        stored.offerType ?? null,
        stored.searchText,
        JSON.stringify(stored.embedding),
        stored.rawJson,
        stored.createdAt.toISOString(),
        stored.updatedAt.toISOString(),
      );

    return stored;
  }
}
