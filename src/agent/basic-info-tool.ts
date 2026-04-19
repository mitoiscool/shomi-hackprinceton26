import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { AgentRunContext, AgentTool } from "./tools.js";
import type {
  BasicInfoKey,
  MemoryStore,
  StoredConversationMessage,
} from "../memory/types.js";

type BasicInfoToolOptions = {
  model: ChatGoogleGenerativeAI;
  store: MemoryStore;
};

type ExtractedBasicInfo = {
  key: BasicInfoKey;
  value: string;
};

function parseBasicInfoPayload(raw: string): ExtractedBasicInfo[] {
  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (value): value is { key?: string; value?: string } =>
          typeof value === "object" && value !== null,
      )
      .map((item) => ({
        key: String(item.key ?? "").trim() as BasicInfoKey,
        value: String(item.value ?? "").trim(),
      }))
      .filter(
        (item) =>
          item.value.length > 0 &&
          [
            "name",
            "location",
            "budget",
            "size",
            "brand_preference",
            "style_preference",
          ].includes(item.key),
      );
  } catch {
    return [];
  }
}

function formatBasicInfoSection(
  items: Awaited<ReturnType<MemoryStore["getBasicInfo"]>>,
) {
  if (items.length === 0) {
    return "";
  }

  const body = items.map((item) => `${item.key}: ${item.value}`).join("\n");
  return `basic user info\n${body}`;
}

export class BasicInfoTool implements AgentTool {
  readonly name = "basic_info";
  private readonly model: ChatGoogleGenerativeAI;
  private readonly store: MemoryStore;

  constructor(options: BasicInfoToolOptions) {
    this.model = options.model;
    this.store = options.store;
  }

  async beforeModel(context: AgentRunContext) {
    const basicInfo = await this.store.getBasicInfo(context.userId);
    const section = formatBasicInfoSection(basicInfo);

    if (section) {
      context.promptSections.push(section);
    }
  }

  async afterModel(context: AgentRunContext) {
    const sourceMessage = context.persistedUserMessage;

    if (!sourceMessage) {
      return;
    }

    const response = await this.model.invoke([
      new HumanMessage(
        [
          "extract only basic profile details from this user message",
          "allowed keys are name location budget size brand_preference style_preference",
          "return strict json array of objects with key and value",
          "return [] if nothing durable is present",
          "",
          sourceMessage.text,
        ].join("\n"),
      ),
    ]);

    const items = parseBasicInfoPayload(response.text).slice(0, 4);

    for (const item of items) {
      await this.store.upsertBasicInfo(
        context.userId,
        item.key,
        item.value,
        sourceMessage.id,
      );
    }
  }
}
