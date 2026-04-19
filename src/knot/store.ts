import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  KnotMerchant,
  KnotPaymentMethod,
  KnotProduct,
  KnotProductType,
  KnotTransaction,
  PurchaseSearchHit,
  ShoppingOperationStatus,
  ShoppingOperationType,
  StoredKnotDevUser,
  StoredPaymentMethodProfile,
  StoredPurchaseRecord,
  StoredShoppingOperation,
} from "./types.js";

type StoreOptions = {
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

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function makeItemId(transactionId: string, product: KnotProduct) {
  const stableKey =
    product.external_id ?? `${product.name ?? "item"}:${product.url ?? ""}`;
  return crypto
    .createHash("sha256")
    .update(`${transactionId}:${stableKey}`)
    .digest("hex");
}

function makeProfileId(
  externalUserId: string,
  merchantId: number,
  method: KnotPaymentMethod,
) {
  return crypto
    .createHash("sha256")
    .update(
      [
        externalUserId,
        String(merchantId),
        method.type ?? "",
        method.brand ?? "",
        method.last_four ?? "",
        method.name ?? "",
      ].join(":"),
    )
    .digest("hex");
}

function randomConfirmationToken() {
  return crypto.randomBytes(3).toString("hex");
}

export class KnotDemoStore {
  private readonly db: DatabaseSync;

  constructor(options: StoreOptions = {}) {
    const filename =
      options.filename ?? path.join(process.cwd(), "data", "shomi.sqlite");

    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists knot_dev_users (
        app_user_id text not null,
        external_user_id text not null,
        environment text not null,
        seeded_merchants_json text not null,
        is_active integer not null default 1,
        created_at text not null,
        updated_at text not null,
        primary key (app_user_id, external_user_id)
      );

      create table if not exists knot_linked_accounts_cache (
        external_user_id text not null,
        merchant_id integer not null,
        merchant_name text,
        product_type text,
        connection_status text,
        raw_json text not null,
        updated_at text not null,
        primary key (external_user_id, merchant_id, product_type)
      );

      create table if not exists knot_sync_state (
        external_user_id text not null,
        merchant_id integer not null,
        next_cursor text,
        last_sync_at text,
        primary key (external_user_id, merchant_id)
      );

      create table if not exists knot_transactions (
        transaction_id text primary key,
        external_user_id text not null,
        merchant_id integer not null,
        merchant_name text,
        external_transaction_id text,
        occurred_at text,
        order_status text,
        currency text,
        total text,
        subtotal text,
        transaction_url text,
        raw_json text not null,
        embedded_text text not null,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_knot_transactions_user_merchant
        on knot_transactions (external_user_id, merchant_id, occurred_at);

      create table if not exists knot_items (
        item_id text primary key,
        transaction_id text not null,
        external_user_id text not null,
        merchant_id integer not null,
        item_external_id text,
        name text,
        description text,
        seller_name text,
        quantity integer,
        unit_price text,
        total_price text,
        product_url text,
        image_url text,
        eligibility_json text not null,
        raw_json text not null,
        embedded_text text not null,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_knot_items_transaction
        on knot_items (transaction_id);

      create table if not exists knot_purchase_embeddings (
        source_type text not null,
        source_id text not null,
        external_user_id text not null,
        merchant_id integer not null,
        transaction_id text not null,
        item_id text,
        citation_text text not null,
        embedding_json text not null,
        created_at text not null,
        updated_at text not null,
        primary key (source_type, source_id)
      );

      create table if not exists knot_payment_method_observations (
        observation_id text primary key,
        external_user_id text not null,
        merchant_id integer not null,
        transaction_id text not null,
        type text,
        brand text,
        last_four text,
        display_name text,
        transaction_amount text,
        observed_at text not null,
        raw_json text not null
      );

      create table if not exists knot_payment_method_profiles (
        profile_id text primary key,
        external_user_id text not null,
        merchant_id integer not null,
        type text,
        brand text,
        last_four text,
        display_name text,
        first_seen_at text not null,
        last_seen_at text not null,
        times_seen integer not null,
        last_transaction_id text,
        confidence_score real not null,
        is_inferred integer not null default 1,
        actionable integer not null default 0,
        updated_at text not null
      );

      create table if not exists knot_shopping_operations (
        operation_id text primary key,
        external_user_id text not null,
        merchant_id integer not null,
        operation_type text not null,
        status text not null,
        payload_json text not null,
        result_json text,
        confirmation_token text,
        error_code text,
        error_message text,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );

      create index if not exists idx_knot_shopping_operations_lookup
        on knot_shopping_operations (external_user_id, merchant_id, operation_type, created_at);

      create table if not exists knot_carts (
        external_user_id text not null,
        merchant_id integer not null,
        cart_json text not null,
        confirmation_token text,
        updated_at text not null,
        primary key (external_user_id, merchant_id)
      );

      create table if not exists knot_cart_items (
        external_user_id text not null,
        merchant_id integer not null,
        item_key text not null,
        product_external_id text,
        name text,
        quantity integer,
        fulfillment_id text,
        raw_json text not null,
        updated_at text not null,
        primary key (external_user_id, merchant_id, item_key)
      );

      create table if not exists knot_fulfillment_options (
        external_user_id text not null,
        merchant_id integer not null,
        option_id text not null,
        item_key text,
        raw_json text not null,
        updated_at text not null,
        primary key (external_user_id, merchant_id, option_id)
      );

      create table if not exists knot_checkout_results (
        operation_id text primary key,
        external_user_id text not null,
        merchant_id integer not null,
        status text not null,
        transaction_ids_json text not null,
        raw_json text not null,
        updated_at text not null
      );

      create table if not exists knot_webhook_events (
        webhook_id text primary key,
        event text not null,
        external_user_id text,
        merchant_id integer,
        payload_json text not null,
        received_at text not null
      );
    `);

    this.ensureColumns("knot_purchase_embeddings", [
      { name: "transaction_id", declaration: "text" },
      { name: "item_id", declaration: "text" },
      { name: "citation_text", declaration: "text" },
    ]);
    this.ensureColumns("knot_shopping_operations", [
      { name: "notified_at", declaration: "text" },
    ]);
  }

  private ensureColumns(
    tableName: string,
    columns: Array<{ declaration: string; name: string }>,
  ) {
    const existing = this.db
      .prepare(`pragma table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    const existingNames = new Set(existing.map((row) => row.name));

    for (const column of columns) {
      if (existingNames.has(column.name)) {
        continue;
      }

      this.db.exec(
        `alter table ${tableName} add column ${column.name} ${column.declaration}`,
      );
    }
  }

  resolveExternalUserId(appUserId: string, explicitExternalUserId?: string) {
    if (explicitExternalUserId) {
      return explicitExternalUserId;
    }

    const row = this.db
      .prepare(
        `
          select external_user_id
          from knot_dev_users
          where app_user_id = ? and is_active = 1
          order by updated_at desc
          limit 1
        `,
      )
      .get(appUserId) as { external_user_id: string } | undefined;

    return row?.external_user_id;
  }

  getAppUserIdForExternalUserId(externalUserId: string) {
    const row = this.db
      .prepare(
        `
          select app_user_id
          from knot_dev_users
          where external_user_id = ?
          order by updated_at desc
          limit 1
        `,
      )
      .get(externalUserId) as { app_user_id: string } | undefined;

    return row?.app_user_id;
  }

  upsertDevUser(params: {
    appUserId: string;
    environment: string;
    externalUserId: string;
    seededMerchants: Array<{ merchantId: number; productType: KnotProductType }>;
  }) {
    const now = new Date().toISOString();

    this.db
      .prepare(`update knot_dev_users set is_active = 0 where app_user_id = ?`)
      .run(params.appUserId);

    this.db
      .prepare(
        `
          insert into knot_dev_users (
            app_user_id,
            external_user_id,
            environment,
            seeded_merchants_json,
            is_active,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, 1, ?, ?)
          on conflict(app_user_id, external_user_id) do update set
            environment = excluded.environment,
            seeded_merchants_json = excluded.seeded_merchants_json,
            is_active = 1,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        params.appUserId,
        params.externalUserId,
        params.environment,
        JSON.stringify(params.seededMerchants),
        now,
        now,
      );
  }

  listSeededDevUsers(appUserId?: string) {
    const rows = (
      appUserId
        ? this.db
            .prepare(
              `
                select *
                from knot_dev_users
                where app_user_id = ?
                order by updated_at desc
              `,
            )
            .all(appUserId)
        : this.db
            .prepare(
              `
                select *
                from knot_dev_users
                order by updated_at desc
              `,
            )
            .all()
    ) as Record<string, unknown>[];

    return rows.map(
      (row): StoredKnotDevUser => ({
        appUserId: String(row.app_user_id),
        createdAt: new Date(String(row.created_at)),
        environment: row.environment as "development" | "production",
        externalUserId: String(row.external_user_id),
        isActive: Number(row.is_active) === 1,
        seededMerchants: parseJson(
          row.seeded_merchants_json as string | null,
          [],
        ) as Array<{ merchantId: number; productType: KnotProductType }>,
        updatedAt: new Date(String(row.updated_at)),
      }),
    );
  }

  upsertLinkedAccount(params: {
    connectionStatus?: string;
    externalUserId: string;
    merchantId: number;
    merchantName?: string;
    productType?: KnotProductType;
    raw: unknown;
  }) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_linked_accounts_cache (
            external_user_id,
            merchant_id,
            merchant_name,
            product_type,
            connection_status,
            raw_json,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(external_user_id, merchant_id, product_type) do update set
            merchant_name = excluded.merchant_name,
            connection_status = excluded.connection_status,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        params.externalUserId,
        params.merchantId,
        params.merchantName ?? null,
        params.productType ?? null,
        params.connectionStatus ?? null,
        JSON.stringify(params.raw),
        now,
      );
  }

  listLinkedMerchants(externalUserId: string, productType?: KnotProductType) {
    const rows = (
      productType
        ? this.db
            .prepare(
              `
                select *
                from knot_linked_accounts_cache
                where external_user_id = ? and product_type = ?
                order by merchant_name asc
              `,
            )
            .all(externalUserId, productType)
        : this.db
            .prepare(
              `
                select *
                from knot_linked_accounts_cache
                where external_user_id = ?
                order by merchant_name asc
              `,
            )
            .all(externalUserId)
    ) as Record<string, unknown>[];

    return rows.map((row) => ({
      connectionStatus:
        row.connection_status === null
          ? undefined
          : String(row.connection_status),
      merchantId: Number(row.merchant_id),
      merchantName:
        row.merchant_name === null ? undefined : String(row.merchant_name),
      productType:
        row.product_type === null
          ? undefined
          : (String(row.product_type) as KnotProductType),
      updatedAt: new Date(String(row.updated_at)),
    }));
  }

  getSyncCursor(externalUserId: string, merchantId: number) {
    const row = this.db
      .prepare(
        `
          select next_cursor
          from knot_sync_state
          where external_user_id = ? and merchant_id = ?
        `,
      )
      .get(externalUserId, merchantId) as { next_cursor: string | null } | undefined;

    return row?.next_cursor ?? null;
  }

  setSyncCursor(
    externalUserId: string,
    merchantId: number,
    nextCursor: string | null,
  ) {
    this.db
      .prepare(
        `
          insert into knot_sync_state (
            external_user_id,
            merchant_id,
            next_cursor,
            last_sync_at
          )
          values (?, ?, ?, ?)
          on conflict(external_user_id, merchant_id) do update set
            next_cursor = excluded.next_cursor,
            last_sync_at = excluded.last_sync_at
        `,
      )
      .run(externalUserId, merchantId, nextCursor, new Date().toISOString());
  }

  upsertTransaction(params: {
    embeddedText: string;
    externalUserId: string;
    merchant: KnotMerchant;
    transaction: KnotTransaction;
  }) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_transactions (
            transaction_id,
            external_user_id,
            merchant_id,
            merchant_name,
            external_transaction_id,
            occurred_at,
            order_status,
            currency,
            total,
            subtotal,
            transaction_url,
            raw_json,
            embedded_text,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(transaction_id) do update set
            merchant_name = excluded.merchant_name,
            external_transaction_id = excluded.external_transaction_id,
            occurred_at = excluded.occurred_at,
            order_status = excluded.order_status,
            currency = excluded.currency,
            total = excluded.total,
            subtotal = excluded.subtotal,
            transaction_url = excluded.transaction_url,
            raw_json = excluded.raw_json,
            embedded_text = excluded.embedded_text,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        params.transaction.id,
        params.externalUserId,
        params.merchant.id,
        params.merchant.name,
        params.transaction.external_id ?? null,
        params.transaction.datetime ?? null,
        params.transaction.order_status ?? null,
        params.transaction.price?.currency ?? null,
        params.transaction.price?.total ?? null,
        params.transaction.price?.sub_total ?? null,
        params.transaction.url ?? null,
        JSON.stringify(params.transaction),
        params.embeddedText,
        now,
        now,
      );
  }

  upsertItem(params: {
    embeddedText: string;
    externalUserId: string;
    merchantId: number;
    product: KnotProduct;
    transactionId: string;
  }) {
    const itemId = makeItemId(params.transactionId, params.product);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_items (
            item_id,
            transaction_id,
            external_user_id,
            merchant_id,
            item_external_id,
            name,
            description,
            seller_name,
            quantity,
            unit_price,
            total_price,
            product_url,
            image_url,
            eligibility_json,
            raw_json,
            embedded_text,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(item_id) do update set
            name = excluded.name,
            description = excluded.description,
            seller_name = excluded.seller_name,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            total_price = excluded.total_price,
            product_url = excluded.product_url,
            image_url = excluded.image_url,
            eligibility_json = excluded.eligibility_json,
            raw_json = excluded.raw_json,
            embedded_text = excluded.embedded_text,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        itemId,
        params.transactionId,
        params.externalUserId,
        params.merchantId,
        params.product.external_id ?? null,
        params.product.name ?? null,
        params.product.description ?? null,
        params.product.seller?.name ?? null,
        params.product.quantity ?? null,
        params.product.price?.unit_price ?? null,
        params.product.price?.total ?? null,
        params.product.url ?? null,
        params.product.image_url ?? null,
        JSON.stringify(params.product.eligibility ?? []),
        JSON.stringify(params.product),
        params.embeddedText,
        now,
        now,
      );

    return itemId;
  }

  upsertPurchaseEmbedding(params: {
    citationText: string;
    embedding: number[];
    externalUserId: string;
    itemId?: string;
    merchantId: number;
    sourceId: string;
    sourceType: "transaction" | "item";
    transactionId: string;
  }) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_purchase_embeddings (
            source_type,
            source_id,
            external_user_id,
            merchant_id,
            transaction_id,
            item_id,
            citation_text,
            embedding_json,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_type, source_id) do update set
            citation_text = excluded.citation_text,
            embedding_json = excluded.embedding_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        params.sourceType,
        params.sourceId,
        params.externalUserId,
        params.merchantId,
        params.transactionId,
        params.itemId ?? null,
        params.citationText,
        JSON.stringify(params.embedding),
        now,
        now,
      );
  }

  recordPaymentMethodObservations(params: {
    externalUserId: string;
    merchantId: number;
    observedAt?: string;
    paymentMethods: KnotPaymentMethod[];
    transactionId: string;
  }) {
    const observedAt = params.observedAt ?? new Date().toISOString();
    const statement = this.db.prepare(
      `
        insert into knot_payment_method_observations (
          observation_id,
          external_user_id,
          merchant_id,
          transaction_id,
          type,
          brand,
          last_four,
          display_name,
          transaction_amount,
          observed_at,
          raw_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(observation_id) do nothing
      `,
    );

    for (const method of params.paymentMethods) {
      const observationId = crypto
        .createHash("sha256")
        .update(
          [
            params.externalUserId,
            String(params.merchantId),
            params.transactionId,
            method.type ?? "",
            method.brand ?? "",
            method.last_four ?? "",
            method.name ?? "",
            method.transaction_amount ?? "",
          ].join(":"),
        )
        .digest("hex");

      statement.run(
        observationId,
        params.externalUserId,
        params.merchantId,
        params.transactionId,
        method.type ?? null,
        method.brand ?? null,
        method.last_four ?? null,
        method.name ?? null,
        method.transaction_amount ?? null,
        observedAt,
        JSON.stringify(method),
      );
    }
  }

  rebuildPaymentMethodProfiles(externalUserId: string, merchantId: number) {
    const rows = this.db
      .prepare(
        `
          select *
          from knot_payment_method_observations
          where external_user_id = ? and merchant_id = ?
          order by observed_at asc
        `,
      )
      .all(externalUserId, merchantId) as Record<string, unknown>[];

    const grouped = new Map<
      string,
      {
        lastTransactionId: string;
        method: KnotPaymentMethod;
        observedAt: string[];
      }
    >();

    for (const row of rows) {
      const method: KnotPaymentMethod = {
        brand: row.brand === null ? undefined : String(row.brand),
        last_four: row.last_four === null ? undefined : String(row.last_four),
        name:
          row.display_name === null ? undefined : String(row.display_name),
        type: row.type === null ? undefined : String(row.type),
      };
      const profileId = makeProfileId(externalUserId, merchantId, method);
      const existing = grouped.get(profileId);

      if (existing) {
        existing.observedAt.push(String(row.observed_at));
        existing.lastTransactionId = String(row.transaction_id);
        continue;
      }

      grouped.set(profileId, {
        lastTransactionId: String(row.transaction_id),
        method,
        observedAt: [String(row.observed_at)],
      });
    }

    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `
        insert into knot_payment_method_profiles (
          profile_id,
          external_user_id,
          merchant_id,
          type,
          brand,
          last_four,
          display_name,
          first_seen_at,
          last_seen_at,
          times_seen,
          last_transaction_id,
          confidence_score,
          is_inferred,
          actionable,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
        on conflict(profile_id) do update set
          first_seen_at = excluded.first_seen_at,
          last_seen_at = excluded.last_seen_at,
          times_seen = excluded.times_seen,
          last_transaction_id = excluded.last_transaction_id,
          confidence_score = excluded.confidence_score,
          updated_at = excluded.updated_at
      `,
    );

    for (const [profileId, value] of grouped.entries()) {
      const firstSeenAt = value.observedAt[0] ?? now;
      const lastSeenAt = value.observedAt[value.observedAt.length - 1] ?? now;
      const confidenceScore = Math.min(1, 0.3 + value.observedAt.length * 0.15);

      statement.run(
        profileId,
        externalUserId,
        merchantId,
        value.method.type ?? null,
        value.method.brand ?? null,
        value.method.last_four ?? null,
        value.method.name ?? null,
        firstSeenAt,
        lastSeenAt,
        value.observedAt.length,
        value.lastTransactionId,
        confidenceScore,
        now,
      );
    }
  }

  listPaymentMethodProfiles(externalUserId: string, merchantId?: number) {
    const rows = (
      typeof merchantId === "number"
        ? this.db
            .prepare(
              `
                select *
                from knot_payment_method_profiles
                where external_user_id = ? and merchant_id = ?
                order by confidence_score desc, last_seen_at desc
              `,
            )
            .all(externalUserId, merchantId)
        : this.db
            .prepare(
              `
                select *
                from knot_payment_method_profiles
                where external_user_id = ?
                order by confidence_score desc, last_seen_at desc
              `,
            )
            .all(externalUserId)
    ) as Record<string, unknown>[];

    return rows.map(
      (row): StoredPaymentMethodProfile => ({
        actionable: Number(row.actionable) === 1,
        brand: row.brand === null ? undefined : String(row.brand),
        confidenceScore: Number(row.confidence_score),
        displayName:
          row.display_name === null ? undefined : String(row.display_name),
        externalUserId: String(row.external_user_id),
        firstSeenAt: new Date(String(row.first_seen_at)),
        isInferred: Number(row.is_inferred) === 1,
        lastFour:
          row.last_four === null ? undefined : String(row.last_four),
        lastSeenAt: new Date(String(row.last_seen_at)),
        merchantId: Number(row.merchant_id),
        profileId: String(row.profile_id),
        timesSeen: Number(row.times_seen),
        type: row.type === null ? undefined : String(row.type),
      }),
    );
  }

  searchPurchases(
    externalUserId: string,
    queryEmbedding: number[],
    limit: number,
  ) {
    const rows = this.db
      .prepare(
        `
          select *
          from knot_purchase_embeddings
          where external_user_id = ?
        `,
      )
      .all(externalUserId) as Record<string, unknown>[];

    return rows
      .map((row) => ({
        citationText: String(row.citation_text),
        itemId: row.item_id === null ? undefined : String(row.item_id),
        merchantId: Number(row.merchant_id),
        score: cosineSimilarity(
          parseJson(row.embedding_json as string | null, [] as number[]),
          queryEmbedding,
        ),
        sourceId: String(row.source_id),
        sourceType: row.source_type as "transaction" | "item",
        transactionId: String(row.transaction_id),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit) satisfies PurchaseSearchHit[];
  }

  getPurchase(externalUserId: string, transactionId: string) {
    const transactionRow = this.db
      .prepare(
        `
          select *
          from knot_transactions
          where external_user_id = ? and transaction_id = ?
          limit 1
        `,
      )
      .get(externalUserId, transactionId) as Record<string, unknown> | undefined;

    if (!transactionRow) {
      return undefined;
    }

    const itemRows = this.db
      .prepare(
        `
          select *
          from knot_items
          where transaction_id = ?
          order by name asc
        `,
      )
      .all(transactionId) as Record<string, unknown>[];

    const transaction = parseJson(
      transactionRow.raw_json as string | null,
      {} as KnotTransaction,
    );

    return {
      currency:
        transactionRow.currency === null
          ? undefined
          : String(transactionRow.currency),
      externalTransactionId:
        transactionRow.external_transaction_id === null
          ? undefined
          : String(transactionRow.external_transaction_id),
      items: itemRows.map((row) => ({
        description:
          row.description === null ? undefined : String(row.description),
        eligibility: parseJson(row.eligibility_json as string | null, [] as string[]),
        externalId:
          row.item_external_id === null
            ? undefined
            : String(row.item_external_id),
        itemId: String(row.item_id),
        name: row.name === null ? undefined : String(row.name),
        quantity:
          row.quantity === null ? undefined : Number(row.quantity),
        sellerName:
          row.seller_name === null ? undefined : String(row.seller_name),
        totalPrice:
          row.total_price === null ? undefined : String(row.total_price),
        unitPrice:
          row.unit_price === null ? undefined : String(row.unit_price),
      })),
      merchantId: Number(transactionRow.merchant_id),
      merchantName:
        transactionRow.merchant_name === null
          ? undefined
          : String(transactionRow.merchant_name),
      occurredAt:
        transactionRow.occurred_at === null
          ? undefined
          : new Date(String(transactionRow.occurred_at)),
      orderStatus:
        transactionRow.order_status === null
          ? undefined
          : String(transactionRow.order_status),
      paymentMethods: transaction.payment_methods ?? [],
      title:
        transaction.products?.[0]?.name ??
        transactionRow.merchant_name?.toString() ??
        "purchase",
      total:
        transactionRow.total === null ? undefined : String(transactionRow.total),
      transactionId,
      transactionUrl:
        transactionRow.transaction_url === null
          ? undefined
          : String(transactionRow.transaction_url),
    } satisfies StoredPurchaseRecord;
  }

  createOperation(params: {
    confirmationToken?: string;
    externalUserId: string;
    merchantId: number;
    payload: unknown;
    type: ShoppingOperationType;
  }) {
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_shopping_operations (
            operation_id,
            external_user_id,
            merchant_id,
            operation_type,
            status,
            payload_json,
            result_json,
            confirmation_token,
            error_code,
            error_message,
            created_at,
            updated_at,
            completed_at
          )
          values (?, ?, ?, ?, 'pending', ?, null, ?, null, null, ?, ?, null)
        `,
      )
      .run(
        operationId,
        params.externalUserId,
        params.merchantId,
        params.type,
        JSON.stringify(params.payload),
        params.confirmationToken ?? null,
        now,
        now,
      );

    return operationId;
  }

  updateLatestPendingOperation(params: {
    errorCode?: string;
    errorMessage?: string;
    externalUserId: string;
    merchantId: number;
    result?: unknown;
    status: ShoppingOperationStatus;
    type: ShoppingOperationType;
  }) {
    const row = this.db
      .prepare(
        `
          select operation_id
          from knot_shopping_operations
          where external_user_id = ?
            and merchant_id = ?
            and operation_type = ?
            and status = 'pending'
          order by created_at desc
          limit 1
        `,
      )
      .get(
        params.externalUserId,
        params.merchantId,
        params.type,
      ) as { operation_id: string } | undefined;

    if (!row) {
      return undefined;
    }

    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          update knot_shopping_operations
          set
            status = ?,
            result_json = ?,
            error_code = ?,
            error_message = ?,
            updated_at = ?,
            completed_at = ?
          where operation_id = ?
        `,
      )
      .run(
        params.status,
        params.result ? JSON.stringify(params.result) : null,
        params.errorCode ?? null,
        params.errorMessage ?? null,
        now,
        params.status === "pending" ? null : now,
        row.operation_id,
      );

    return row.operation_id;
  }

  getLatestOperation(
    externalUserId: string,
    merchantId: number,
    type: ShoppingOperationType,
  ) {
    const row = this.db
      .prepare(
        `
          select *
          from knot_shopping_operations
          where external_user_id = ?
            and merchant_id = ?
            and operation_type = ?
          order by created_at desc
          limit 1
        `,
      )
      .get(externalUserId, merchantId, type) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    return {
      completedAt:
        row.completed_at === null ? undefined : new Date(String(row.completed_at)),
      confirmationToken:
        row.confirmation_token === null
          ? undefined
          : String(row.confirmation_token),
      createdAt: new Date(String(row.created_at)),
      errorCode:
        row.error_code === null ? undefined : String(row.error_code),
      errorMessage:
        row.error_message === null ? undefined : String(row.error_message),
      externalUserId: String(row.external_user_id),
      merchantId: Number(row.merchant_id),
      notifiedAt:
        row.notified_at === null || row.notified_at === undefined
          ? undefined
          : new Date(String(row.notified_at)),
      operationId: String(row.operation_id),
      payloadJson: String(row.payload_json),
      resultJson:
        row.result_json === null ? undefined : String(row.result_json),
      status: row.status as ShoppingOperationStatus,
      type: row.operation_type as ShoppingOperationType,
      updatedAt: new Date(String(row.updated_at)),
    } satisfies StoredShoppingOperation;
  }

  markOperationNotified(params: {
    externalUserId: string;
    merchantId: number;
    type: ShoppingOperationType;
  }) {
    this.db
      .prepare(
        `
          update knot_shopping_operations
          set notified_at = ?
          where operation_id = (
            select operation_id
            from knot_shopping_operations
            where external_user_id = ?
              and merchant_id = ?
              and operation_type = ?
            order by created_at desc
            limit 1
          )
        `,
      )
      .run(new Date().toISOString(), params.externalUserId, params.merchantId, params.type);
  }

  upsertCartSnapshot(
    externalUserId: string,
    merchantId: number,
    payload: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    const confirmationToken = randomConfirmationToken();

    this.db
      .prepare(
        `
          insert into knot_carts (
            external_user_id,
            merchant_id,
            cart_json,
            confirmation_token,
            updated_at
          )
          values (?, ?, ?, ?, ?)
          on conflict(external_user_id, merchant_id) do update set
            cart_json = excluded.cart_json,
            confirmation_token = excluded.confirmation_token,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        externalUserId,
        merchantId,
        JSON.stringify(payload),
        confirmationToken,
        now,
      );

    this.db
      .prepare(
        `
          delete from knot_cart_items
          where external_user_id = ? and merchant_id = ?
        `,
      )
      .run(externalUserId, merchantId);

    this.db
      .prepare(
        `
          delete from knot_fulfillment_options
          where external_user_id = ? and merchant_id = ?
        `,
      )
      .run(externalUserId, merchantId);

    const items = extractCartItems(payload);
    const itemStatement = this.db.prepare(
      `
        insert into knot_cart_items (
          external_user_id,
          merchant_id,
          item_key,
          product_external_id,
          name,
          quantity,
          fulfillment_id,
          raw_json,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const fulfillmentStatement = this.db.prepare(
      `
        insert into knot_fulfillment_options (
          external_user_id,
          merchant_id,
          option_id,
          item_key,
          raw_json,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?)
      `,
    );

    for (const item of items) {
      const itemRecord = item as Record<string, unknown> & {
        external_id?: string;
        fulfillment?: { id?: string };
        fulfillment_options?: Array<Record<string, unknown>>;
        id?: string;
        name?: string;
        quantity?: number;
      };
      const itemKey = String(
        itemRecord.external_id ??
          itemRecord.id ??
          crypto
            .createHash("sha256")
            .update(JSON.stringify(itemRecord))
            .digest("hex"),
      );

      itemStatement.run(
        externalUserId,
        merchantId,
        itemKey,
        itemRecord.external_id ?? null,
        itemRecord.name ?? null,
        typeof itemRecord.quantity === "number" ? itemRecord.quantity : null,
        itemRecord.fulfillment?.id ?? null,
        JSON.stringify(itemRecord),
        now,
      );

      const fulfillments = Array.isArray(itemRecord.fulfillment_options)
        ? itemRecord.fulfillment_options
        : [];

      for (const option of fulfillments) {
        const optionId = String(
          option.id ??
            crypto
              .createHash("sha256")
              .update(JSON.stringify(option))
              .digest("hex"),
        );

        fulfillmentStatement.run(
          externalUserId,
          merchantId,
          optionId,
          itemKey,
          JSON.stringify(option),
          now,
        );
      }
    }

    return confirmationToken;
  }

  getCartStatus(externalUserId: string, merchantId: number) {
    const operation = this.getLatestOperation(externalUserId, merchantId, "sync_cart");
    const cartRow = this.db
      .prepare(
        `
          select *
          from knot_carts
          where external_user_id = ? and merchant_id = ?
          limit 1
        `,
      )
      .get(externalUserId, merchantId) as Record<string, unknown> | undefined;

    return {
      cart:
        cartRow === undefined
          ? undefined
          : {
              confirmationToken:
                cartRow.confirmation_token === null
                  ? undefined
                  : String(cartRow.confirmation_token),
              raw: parseJson(cartRow.cart_json as string | null, {}),
              updatedAt: new Date(String(cartRow.updated_at)),
            },
      operation,
    };
  }

  getConfirmationToken(externalUserId: string, merchantId: number) {
    const row = this.db
      .prepare(
        `
          select confirmation_token
          from knot_carts
          where external_user_id = ? and merchant_id = ?
          limit 1
        `,
      )
      .get(externalUserId, merchantId) as
      | { confirmation_token: string | null }
      | undefined;

    return row?.confirmation_token ?? undefined;
  }

  storeCheckoutResult(params: {
    externalUserId: string;
    merchantId: number;
    operationId: string;
    payload: Record<string, unknown>;
    status: ShoppingOperationStatus;
    transactionIds: string[];
  }) {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          insert into knot_checkout_results (
            operation_id,
            external_user_id,
            merchant_id,
            status,
            transaction_ids_json,
            raw_json,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(operation_id) do update set
            status = excluded.status,
            transaction_ids_json = excluded.transaction_ids_json,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        params.operationId,
        params.externalUserId,
        params.merchantId,
        params.status,
        JSON.stringify(params.transactionIds),
        JSON.stringify(params.payload),
        now,
      );
  }

  getCheckoutStatus(externalUserId: string, merchantId: number) {
    const operation = this.getLatestOperation(externalUserId, merchantId, "checkout");
    const row = this.db
      .prepare(
        `
          select *
          from knot_checkout_results
          where external_user_id = ? and merchant_id = ?
          order by updated_at desc
          limit 1
        `,
      )
      .get(externalUserId, merchantId) as Record<string, unknown> | undefined;

    return {
      operation,
      result:
        row === undefined
          ? undefined
          : {
              raw: parseJson(row.raw_json as string | null, {}),
              status: String(row.status),
              transactionIds: parseJson(
                row.transaction_ids_json as string | null,
                [] as string[],
              ),
              updatedAt: new Date(String(row.updated_at)),
            },
    };
  }

  recordWebhookEvent(params: {
    event: string;
    externalUserId?: string;
    merchantId?: number;
    payload: unknown;
  }) {
    const webhookId = crypto
      .createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex");

    this.db
      .prepare(
        `
          insert into knot_webhook_events (
            webhook_id,
            event,
            external_user_id,
            merchant_id,
            payload_json,
            received_at
          )
          values (?, ?, ?, ?, ?, ?)
          on conflict(webhook_id) do nothing
        `,
      )
      .run(
        webhookId,
        params.event,
        params.externalUserId ?? null,
        params.merchantId ?? null,
        JSON.stringify(params.payload),
        new Date().toISOString(),
      );
  }

  getRecentWebhookEvents(limit = 10) {
    const rows = this.db
      .prepare(
        `
          select event, external_user_id, merchant_id, received_at
          from knot_webhook_events
          order by received_at desc
          limit ?
        `,
      )
      .all(limit) as Array<{
        event: string;
        external_user_id: string | null;
        merchant_id: number | null;
        received_at: string;
      }>;

    return rows.map((row) => ({
      event: row.event,
      externalUserId: row.external_user_id ?? undefined,
      merchantId: row.merchant_id ?? undefined,
      receivedAt: new Date(row.received_at),
    }));
  }
}

function extractCartItems(payload: Record<string, unknown>) {
  const directItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray((payload.cart as { items?: unknown[] } | undefined)?.items)
      ? ((payload.cart as { items?: unknown[] }).items ?? [])
      : Array.isArray((payload.data as { items?: unknown[] } | undefined)?.items)
        ? ((payload.data as { items?: unknown[] }).items ?? [])
        : Array.isArray(
              (
                payload.data as {
                  cart?: { items?: unknown[] };
                } | undefined
              )?.cart?.items,
            )
          ? ((payload.data as { cart?: { items?: unknown[] } }).cart?.items ?? [])
          : [];

  return directItems.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );
}

export function buildTransactionTitle(transaction: KnotTransaction, merchantName?: string) {
  return transaction.products?.[0]?.name ?? merchantName ?? "purchase";
}

export function buildProfileIdForTest(
  externalUserId: string,
  merchantId: number,
  method: KnotPaymentMethod,
) {
  return makeProfileId(externalUserId, merchantId, method);
}

export function buildItemIdForTest(transactionId: string, product: KnotProduct) {
  return makeItemId(transactionId, product);
}
