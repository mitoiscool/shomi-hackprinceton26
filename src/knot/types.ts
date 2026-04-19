export type KnotEnvironment = "development" | "production";
export type KnotProductType =
  | "transaction_link"
  | "shopping"
  | "card_switcher"
  | "vault";

export type KnotConfig = {
  apiVersion: string;
  baseUrl: string;
  clientId: string;
  dataDir: string;
  defaultExternalUserId?: string;
  environment: KnotEnvironment;
  geminiApiKey: string;
  secret: string;
  sqlitePath: string;
  walmartMerchantId: number;
  webhookPath: string;
  webhookPort: number;
};

export type KnotMerchant = {
  id: number;
  name: string;
  category?: string;
  logo?: string;
};

export type KnotMerchantAccount = {
  connection?: {
    scopes?: Array<{ type?: string }>;
    status?: "connected" | "disconnected" | string;
  };
  lifecycle?: {
    status?: string | null;
  };
  merchant?: KnotMerchant;
};

export type KnotTransactionPrice = {
  currency?: string;
  sub_total?: string;
  total?: string;
};

export type KnotPaymentMethod = {
  brand?: string;
  last_four?: string;
  name?: string;
  transaction_amount?: string;
  type?: string;
};

export type KnotProduct = {
  description?: string;
  eligibility?: string[];
  external_id?: string | null;
  image_url?: string | null;
  name?: string;
  price?: {
    sub_total?: string;
    total?: string;
    unit_price?: string;
  };
  quantity?: number;
  seller?: {
    name?: string;
    url?: string | null;
  } | null;
  url?: string | null;
};

export type KnotTransaction = {
  datetime?: string;
  external_id?: string | null;
  id: string;
  order_status?: string;
  payment_methods?: KnotPaymentMethod[];
  price?: KnotTransactionPrice;
  products?: KnotProduct[];
  shipping?: unknown;
  url?: string | null;
};

export type KnotSyncTransactionsResponse = {
  limit: number;
  merchant: KnotMerchant;
  next_cursor: string | null;
  transactions: KnotTransaction[];
};

export type KnotDevelopmentLinkRequest =
  | {
      external_user_id: string;
      merchant_id: number;
      transactions: {
        new: boolean;
        updated?: boolean;
      };
    }
  | {
      external_user_id: string;
      merchant_id: number;
    };

export type KnotDeliveryLocation = {
  address: {
    city: string;
    country: string;
    line1: string;
    line2?: string;
    postal_code: string;
    region: string;
  };
  first_name: string;
  last_name: string;
  phone_number: string;
  set_as_default?: boolean;
};

export type KnotCartProductInput = {
  external_id: string;
  fulfillment?: {
    id: string;
  };
};

export type KnotCheckoutPaymentMethod = {
  id: string;
  is_single_use: boolean;
  jwe: string;
};

export type KnotWebhookPayload = {
  data?: Record<string, unknown>;
  event: string;
  external_user_id?: string;
  merchant?: {
    id?: number;
    name?: string;
  };
  timestamp?: number;
  transactions?: Array<{ id?: string }>;
  [key: string]: unknown;
};

export type StoredKnotDevUser = {
  appUserId: string;
  createdAt: Date;
  environment: KnotEnvironment;
  externalUserId: string;
  isActive: boolean;
  seededMerchants: Array<{ merchantId: number; productType: KnotProductType }>;
  updatedAt: Date;
};

export type PurchaseSearchHit = {
  citationText: string;
  itemId?: string;
  merchantId: number;
  score: number;
  sourceId: string;
  sourceType: "transaction" | "item";
  transactionId: string;
};

export type StoredPaymentMethodProfile = {
  actionable: boolean;
  brand?: string;
  confidenceScore: number;
  displayName?: string;
  externalUserId: string;
  firstSeenAt: Date;
  isInferred: boolean;
  lastFour?: string;
  lastSeenAt: Date;
  merchantId: number;
  profileId: string;
  timesSeen: number;
  type?: string;
};

export type StoredPurchaseRecord = {
  currency?: string;
  externalTransactionId?: string;
  merchantId: number;
  merchantName?: string;
  occurredAt?: Date;
  orderStatus?: string;
  paymentMethods: KnotPaymentMethod[];
  title: string;
  total?: string;
  transactionId: string;
  transactionUrl?: string;
  items: Array<{
    description?: string;
    eligibility: string[];
    externalId?: string;
    itemId: string;
    name?: string;
    quantity?: number;
    sellerName?: string;
    totalPrice?: string;
    unitPrice?: string;
  }>;
};

export type ShoppingOperationType = "seed" | "sync_cart" | "checkout";
export type ShoppingOperationStatus = "pending" | "succeeded" | "failed";

export type StoredShoppingOperation = {
  completedAt?: Date;
  confirmationToken?: string;
  createdAt: Date;
  errorCode?: string;
  errorMessage?: string;
  externalUserId: string;
  merchantId: number;
  notifiedAt?: Date;
  operationId: string;
  payloadJson: string;
  resultJson?: string;
  status: ShoppingOperationStatus;
  type: ShoppingOperationType;
  updatedAt: Date;
};
