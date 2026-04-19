import type { StoredConversationMessage } from "../memory/types.js";
import type { BaseMessage } from "@langchain/core/messages";

export type AgentRunContext = {
  chatHistory: BaseMessage[];
  messageText: string;
  persistedAssistantMessage?: StoredConversationMessage;
  persistedUserMessage?: StoredConversationMessage;
  promptSections: string[];
  userId: string;
};

export interface AgentTool {
  name: string;
  beforeModel(context: AgentRunContext): Promise<void>;
  afterModel(context: AgentRunContext, responseText: string): Promise<void>;
}
