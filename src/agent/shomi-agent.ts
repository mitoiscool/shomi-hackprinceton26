import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { SHOMI_PERSONALITY } from "../shomi-personality.js";
import { loadKnotConfig } from "../knot/config.js";
import { KnotClient } from "../knot/client.js";
import { KnotDemoStore } from "../knot/store.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import type { MemoryStore } from "../memory/types.js";
import type { AgentRunContext, AgentTool } from "./tools.js";
import { BasicInfoTool } from "./basic-info-tool.js";
import { createKnotAgentTools } from "./knot-agent-tools.js";
import { MemoryTool } from "./memory-tool.js";
import {
  createProductAgentTools,
  type ProductSearchResult,
} from "./product-agent-tools.js";
import { SummarySearchTool } from "./summary-search-tool.js";
import { TransactionHistoryTool } from "./transaction-history-tool.js";

type ShomiAgentOptions = {
  apiKey: string;
  contextCharLimit?: number;
  model?: string;
  systemInstruction?: string;
  tools?: AgentTool[];
  memoryStore?: MemoryStore;
};

type AgentResponse = {
  productResults: ProductSearchResult[];
  rawText: string;
  textParts: string[];
};

function splitTextMessages(text: string) {
  return text
    .split("<textbreak>")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function truncateForLog(value: unknown, limit = 100) {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function summarizeToolResultContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : "text" in part && typeof part.text === "string"
            ? part.text
            : JSON.stringify(part),
      )
      .join("");
  }

  return content;
}

export class ShomiAgent {
  private readonly contextCharLimit: number;
  private readonly knotClient: KnotClient;
  private readonly knotStore: KnotDemoStore;
  private readonly memoryStore: MemoryStore;
  private readonly model: ChatGoogleGenerativeAI;
  private readonly queryEmbeddings: GoogleGenerativeAIEmbeddings;
  private readonly tools: AgentTool[];
  private readonly systemInstruction: string;

  constructor(options: ShomiAgentOptions) {
    const memoryStore = options.memoryStore ?? new SqliteMemoryStore();
    const modelName = options.model ?? "gemini-2.5-flash";
    this.memoryStore = memoryStore;

    this.model = new ChatGoogleGenerativeAI({
      apiKey: options.apiKey,
      maxRetries: 2,
      model: modelName,
      temperature: 0.8,
    });

    const queryEmbeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: options.apiKey,
      model: "gemini-embedding-001",
      taskType: TaskType.RETRIEVAL_QUERY,
    });

    const documentEmbeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: options.apiKey,
      model: "gemini-embedding-001",
      taskType: TaskType.RETRIEVAL_DOCUMENT,
    });

    this.systemInstruction = options.systemInstruction ?? SHOMI_PERSONALITY;
    this.contextCharLimit = options.contextCharLimit ?? 100_000;
    this.queryEmbeddings = queryEmbeddings;
    const knotConfig = loadKnotConfig();
    this.knotClient = new KnotClient(knotConfig);
    this.knotStore = new KnotDemoStore({
      filename: knotConfig.sqlitePath,
    });
    this.tools =
      options.tools ??
      [
        new MemoryTool({
          documentEmbeddings,
          model: this.model,
          queryEmbeddings,
          store: memoryStore,
        }),
        new BasicInfoTool({
          model: this.model,
          store: memoryStore,
        }),
        new SummarySearchTool({
          queryEmbeddings,
          store: memoryStore,
        }),
        new TransactionHistoryTool({
          queryEmbeddings,
          store: memoryStore,
        }),
      ];
  }

  private buildPromptMessages(context: AgentRunContext) {
    const baseSystemText = [
      this.systemInstruction,
      "",
      "when the user asks to find compare browse or buy products call search_walmart_products before answering",
      "",
      "here is retrieved memory and rag context if relevant",
      context.promptSections.join("\n\n") || "no additional memory context",
    ].join("\n");

    const userMessage = new HumanMessage(context.messageText);
    let systemText = baseSystemText;
    let chatHistory = [...context.chatHistory];

    const estimateChars = (messages: BaseMessage[]) =>
      messages.reduce((total, message) => total + message.text.length, 0);

    const buildMessages = () => [
      new SystemMessage(systemText),
      ...chatHistory,
      userMessage,
    ];

    while (chatHistory.length > 0 && estimateChars(buildMessages()) > this.contextCharLimit) {
      chatHistory = chatHistory.slice(1);
    }

    if (estimateChars(buildMessages()) > this.contextCharLimit) {
      const reserved = estimateChars([userMessage]) + 2_000;
      const available = Math.max(2_000, this.contextCharLimit - reserved);
      systemText = systemText.slice(0, available);
    }

    return buildMessages();
  }

  private async invokeWithActionTools(context: AgentRunContext) {
    const actionTools = createKnotAgentTools({
      client: this.knotClient,
      config: loadKnotConfig(),
      queryEmbeddings: this.queryEmbeddings,
      store: this.knotStore,
      userId: context.userId,
      userMessageText: context.messageText,
    });
    const productTools = createProductAgentTools({
      queryEmbeddings: this.queryEmbeddings,
      store: this.memoryStore,
    });
    const allActionTools = [...actionTools, ...productTools];
    const modelWithTools = this.model.bindTools(allActionTools);
    const messages = this.buildPromptMessages(context);
    let latestProductResults: ProductSearchResult[] = [];

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const response = await modelWithTools.invoke(messages);
      messages.push(response);

      const toolCalls = response.tool_calls ?? [];

      if (toolCalls.length === 0) {
        return {
          productResults: latestProductResults,
          rawText: response.text.trim(),
        };
      }

      for (const toolCall of toolCalls) {
        const matchingTool = allActionTools.find((tool) => tool.name === toolCall.name);

        if (!matchingTool) {
          throw new Error(`Unknown action tool requested: ${toolCall.name}`);
        }

        console.log("[tool-call]", {
          args: truncateForLog(toolCall.args),
          name: toolCall.name,
        });

        const toolResult = await (
          matchingTool as {
            invoke: (input: unknown) => Promise<BaseMessage>;
          }
        ).invoke(toolCall);

        console.log("[tool-response]", {
          name: toolCall.name,
          response: truncateForLog(summarizeToolResultContent(toolResult.content)),
        });

        if (toolCall.name === "search_walmart_products") {
          const raw = toolResult.content;
          const text =
            typeof raw === "string"
              ? raw
              : Array.isArray(raw)
                ? raw
                    .map((part) =>
                      typeof part === "string"
                        ? part
                        : "text" in part && typeof part.text === "string"
                          ? part.text
                          : "",
                    )
                    .join("")
                : "";

          try {
            const parsed = JSON.parse(text) as {
              products?: ProductSearchResult[];
            };
            latestProductResults = parsed.products ?? [];
          } catch {
            latestProductResults = [];
          }
        }

        messages.push(toolResult);
      }
    }

    throw new Error("shomi exceeded the maximum tool iterations");
  }

  async respond(userId: string, messageText: string): Promise<AgentResponse> {
    const context: AgentRunContext = {
      chatHistory: [],
      messageText,
      promptSections: [],
      userId,
    };

    for (const tool of this.tools) {
      await tool.beforeModel(context);
    }

    const result = await this.invokeWithActionTools(context);
    const rawText = typeof result === "string" ? result : result.rawText;
    const productResults =
      typeof result === "string" ? [] : (result.productResults ?? []);

    if (!rawText) {
      throw new Error("Shomi returned an empty response.");
    }

    for (const tool of this.tools) {
      await tool.afterModel(context, rawText);
    }

    return {
      productResults,
      rawText,
      textParts: splitTextMessages(rawText),
    };
  }
}
