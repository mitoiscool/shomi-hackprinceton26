import type {
  KnotCartProductInput,
  KnotCheckoutPaymentMethod,
  KnotConfig,
  KnotDeliveryLocation,
  KnotDevelopmentLinkRequest,
  KnotMerchant,
  KnotMerchantAccount,
  KnotProductType,
  KnotSyncTransactionsResponse,
  KnotTransaction,
} from "./types.js";

export class KnotClient {
  private readonly config: KnotConfig;

  constructor(config: KnotConfig) {
    this.config = config;
  }

  private getAuthorizationHeader() {
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.secret}`,
      "utf8",
    ).toString("base64");

    return `Basic ${credentials}`;
  }

  private async request<T>(pathname: string, init?: RequestInit) {
    const response = await fetch(new URL(pathname, this.config.baseUrl), {
      ...init,
      headers: {
        Authorization: this.getAuthorizationHeader(),
        "Content-Type": "application/json",
        "Knot-Version": this.config.apiVersion,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        `knot request failed ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    }

    return (await response.json()) as T;
  }

  async linkDevelopmentAccount(payload: KnotDevelopmentLinkRequest) {
    return this.request<{ message: string }>("/development/accounts/link", {
      body: JSON.stringify(payload),
      method: "POST",
    });
  }

  async listMerchants(type: KnotProductType, search?: string) {
    const payload = search ? { search, type } : { type };
    const response = await this.request<KnotMerchant | KnotMerchant[]>(
      "/merchant/list",
      {
        body: JSON.stringify(payload),
        method: "POST",
      },
    );

    return Array.isArray(response) ? response : [response];
  }

  async getMerchantAccounts(
    externalUserId: string,
    type?: "transaction_link" | "card_switcher" | "vault",
  ) {
    const query = new URLSearchParams({
      external_user_id: externalUserId,
    });

    if (type) {
      query.set("type", type);
    }

    const response = await this.request<KnotMerchantAccount[] | KnotMerchantAccount>(
      `/accounts/get?${query.toString()}`,
      { method: "GET" },
    );

    return Array.isArray(response) ? response : [response];
  }

  async syncTransactions(params: {
    cursor?: string | null;
    externalUserId: string;
    limit?: number;
    merchantId: number;
  }) {
    return this.request<KnotSyncTransactionsResponse>("/transactions/sync", {
      body: JSON.stringify({
        cursor: params.cursor ?? undefined,
        external_user_id: params.externalUserId,
        limit: params.limit ?? 100,
        merchant_id: params.merchantId,
      }),
      method: "POST",
    });
  }

  async getTransactionById(transactionId: string) {
    return this.request<KnotTransaction>(`/transactions/${transactionId}`, {
      method: "GET",
    });
  }

  async syncCart(params: {
    deliveryLocation?: KnotDeliveryLocation;
    externalUserId: string;
    merchantId: number;
    products: KnotCartProductInput[];
    simulate?: "failed";
  }) {
    return this.request<{ message: string }>("/cart", {
      body: JSON.stringify({
        delivery_location: params.deliveryLocation,
        external_user_id: params.externalUserId,
        merchant_id: params.merchantId,
        products: params.products,
        simulate: params.simulate,
      }),
      method: "POST",
    });
  }

  async checkoutCart(params: {
    externalUserId: string;
    merchantId: number;
    paymentMethod?: KnotCheckoutPaymentMethod;
    simulate?: "failed";
  }) {
    return this.request<{ message: string }>("/cart/checkout", {
      body: JSON.stringify({
        external_user_id: params.externalUserId,
        merchant_id: params.merchantId,
        payment_method: params.paymentMethod,
        simulate: params.simulate,
      }),
      method: "POST",
    });
  }
}
