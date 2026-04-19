import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import type { AgentRunContext, AgentTool } from "./tools.js";
import type {
  MemoryStore,
  StoredConversationMessage,
} from "../memory/types.js";

type MemoryToolOptions = {
  documentEmbeddings: GoogleGenerativeAIEmbeddings;
  model: ChatGoogleGenerativeAI;
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  recentMessageLimit?: number;
  store: MemoryStore;
};

function parseJsonStringArray(raw: string) {
  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function formatRecentMessage(message: StoredConversationMessage) {
  const role = message.role === "user" ? "user" : "assistant";
  return `${role}: ${message.text}`;
}

export class MemoryTool implements AgentTool {
  readonly name = "memory";
  private readonly documentEmbeddings: GoogleGenerativeAIEmbeddings;
  private readonly model: ChatGoogleGenerativeAI;
  private readonly queryEmbeddings: GoogleGenerativeAIEmbeddings;
  private readonly recentMessageLimit: number;
  private readonly store: MemoryStore;
  private readonly userQueues = new Map<string, Promise<void>>();

  constructor(options: MemoryToolOptions) {
    this.documentEmbeddings = options.documentEmbeddings;
    this.model = options.model;
    this.queryEmbeddings = options.queryEmbeddings;
    this.recentMessageLimit = options.recentMessageLimit ?? 8;
    this.store = options.store;
  }

  async beforeModel(context: AgentRunContext) {
    const recentMessages = await this.store.getRecentMessages(
      context.userId,
      this.recentMessageLimit,
    );

    context.chatHistory = recentMessages.map((message) =>
      message.role === "user"
        ? new HumanMessage(message.text)
        : new AIMessage(message.text),
    );
  }

  async afterModel(context: AgentRunContext, responseText: string) {
    const existing = this.userQueues.get(context.userId) ?? Promise.resolve();

    const queued = existing
      .catch(() => undefined)
      .then(async () => {
        const userMessage = await this.store.appendMessage(
          context.userId,
          "user",
          context.messageText,
        );
        const assistantMessage = await this.store.appendMessage(
          context.userId,
          "assistant",
          responseText,
        );
        context.persistedUserMessage = userMessage;
        context.persistedAssistantMessage = assistantMessage;

        await Promise.all([
          this.extractDurableFacts(context.userId, userMessage),
          this.refreshSummary(context.userId),
        ]);

        await this.extractDurableFacts(context.userId, assistantMessage);
      });

    this.userQueues.set(context.userId, queued);
    await queued;
  }

  private async extractDurableFacts(
    userId: string,
    message: StoredConversationMessage,
  ) {
    if (message.role !== "user") {
      return;
    }

    const response = await this.model.invoke([
      new HumanMessage(
        [
          "extract durable user purchase memory from this message",
          "only capture stable useful details like budget brand size style color shipping urgency location gift recipient or preferences",
          "return strict json array of strings",
          "return [] if there is nothing worth remembering",
          "",
          message.text,
        ].join("\n"),
      ),
    ]);

    const facts = parseJsonStringArray(response.text).slice(0, 3);

    for (const fact of facts) {
      const embedding = await this.documentEmbeddings.embedQuery(fact);
      await this.store.upsertMemory(userId, "fact", fact, [message.id], embedding);
    }
  }

  private async refreshSummary(userId: string) {
    const summarizable = await this.store.getSummarizableMessages(userId, 4, 8);

    if (summarizable.length < 6) {
      return;
    }

    const response = await this.model.invoke([
      new HumanMessage(
        [
          "summarize this conversation window for future retrieval",
          "focus on the users goals preferences constraints and current shopping context",
          "be concise and information dense",
          "",
          ...summarizable.map(formatRecentMessage),
        ].join("\n"),
      ),
    ]);

    const summary = response.text.trim();

    if (!summary) {
      return;
    }

    const references = summarizable.map((message) => message.id);
    const embedding = await this.documentEmbeddings.embedQuery(summary);

    await this.store.upsertMemory(
      userId,
      "summary",
      summary,
      references,
      embedding,
    );
    await this.store.markMessagesSummarized(userId, references);
  }
}
