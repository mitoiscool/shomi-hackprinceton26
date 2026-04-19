import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import type { AgentRunContext, AgentTool } from "./tools.js";
import type { MemoryStore, StoredMemory } from "../memory/types.js";

type SummarySearchToolOptions = {
  queryEmbeddings: GoogleGenerativeAIEmbeddings;
  store: MemoryStore;
};

function formatSummaryResults(summaries: StoredMemory[]) {
  if (summaries.length === 0) {
    return "";
  }

  const body = summaries
    .map((summary, index) => {
      const refs =
        summary.references.length > 0
          ? ` refs ${summary.references.join(" ")}`
          : "";

      return `${index + 1}${refs}\n${summary.content}`;
    })
    .join("\n\n");

  return `relevant summary history\n${body}`;
}

export class SummarySearchTool implements AgentTool {
  readonly name = "summary_search";
  private readonly queryEmbeddings: GoogleGenerativeAIEmbeddings;
  private readonly store: MemoryStore;

  constructor(options: SummarySearchToolOptions) {
    this.queryEmbeddings = options.queryEmbeddings;
    this.store = options.store;
  }

  async beforeModel(context: AgentRunContext) {
    const queryEmbedding = await this.queryEmbeddings.embedQuery(
      context.messageText,
    );
    const summaries = await this.store.searchSummaryMemories(
      context.userId,
      queryEmbedding,
      3,
    );
    const section = formatSummaryResults(summaries);

    if (section) {
      context.promptSections.push(section);
    }
  }

  async afterModel() {}
}
