import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import type { AgentRunContext, AgentTool } from "./tools.js";
import type { MemoryStore, StoredTransactionRecord } from "../memory/types.js";

type TransactionHistoryToolOptions = {
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: MemoryStore;
};

function formatAmount(transaction: StoredTransactionRecord) {
  if (transaction.amount === undefined) {
    return "";
  }

  const currency = transaction.currency ?? "usd";
  return `${transaction.amount} ${currency}`;
}

function formatTransactionResults(transactions: StoredTransactionRecord[]) {
  if (transactions.length === 0) {
    return "";
  }

  const body = transactions
    .map((transaction, index) => {
      const parts = [
        transaction.title,
        transaction.merchant,
        formatAmount(transaction),
        transaction.occurredAt?.toISOString().slice(0, 10),
        transaction.description,
      ].filter((value): value is string => Boolean(value));

      return `${index + 1}\n${parts.join("\n")}`;
    })
    .join("\n\n");

  return `relevant transaction history\n${body}`;
}

export class TransactionHistoryTool implements AgentTool {
  readonly name = "transaction_history";
  private readonly queryEmbeddings: GoogleGenerativeAIEmbeddings;
  private readonly store: MemoryStore;

  constructor(options: TransactionHistoryToolOptions) {
    this.queryEmbeddings = options.queryEmbeddings;
    this.store = options.store;
  }

  async beforeModel(context: AgentRunContext) {
    const queryEmbedding = await this.queryEmbeddings.embedQuery(
      context.messageText,
    );
    const transactions = await this.store.searchTransactions(
      context.userId,
      queryEmbedding,
      5,
    );
    const section = formatTransactionResults(transactions);

    if (section) {
      context.promptSections.push(section);
    }
  }

  async afterModel() {}
}
