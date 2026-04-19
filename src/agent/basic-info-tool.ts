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

const ALLOWED_BASIC_INFO_KEYS: BasicInfoKey[] = [
  "name",
  "location",
  "budget",
  "size",
  "brand_preference",
  "style_preference",
  "first_name",
  "last_name",
  "phone",
  "address_line1",
  "address_line2",
  "address_city",
  "address_region",
  "address_postal_code",
  "address_country",
];

function normalizeBasicInfoValue(key: BasicInfoKey, value: string) {
  const trimmed = value.trim();

  if (key === "phone") {
    const digits = trimmed.replace(/[^\d+]/g, "");

    if (digits.startsWith("+")) {
      return digits;
    }

    if (digits.length === 10) {
      return `+1${digits}`;
    }

    if (digits.length === 11 && digits.startsWith("1")) {
      return `+${digits}`;
    }

    return trimmed;
  }

  if (key === "address_region" || key === "address_country") {
    return trimmed.toUpperCase();
  }

  return trimmed;
}

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
      .map((item) => {
        const key = String(item.key ?? "").trim() as BasicInfoKey;
        const value = normalizeBasicInfoValue(key, String(item.value ?? ""));

        return { key, value };
      })
      .filter(
        (item) =>
          item.value.length > 0 && ALLOWED_BASIC_INFO_KEYS.includes(item.key),
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
          "extract only durable profile details from this user message",
          "allowed keys: name, location, budget, size, brand_preference, style_preference, first_name, last_name, phone, address_line1, address_line2, address_city, address_region, address_postal_code, address_country",
          "rules:",
          "- phone must be in E.164 format (+1XXXXXXXXXX for US). if user gives 10 digits assume US and prepend +1",
          "- address_region must be a 2-letter ISO 3166-2 subdivision code (e.g. NJ, CA)",
          "- address_country must be a 2-letter ISO 3166-1 alpha-2 code (e.g. US). default to US if a US-style zip or state is given",
          "- address_line1 and address_line2 must each be 46 characters or fewer",
          "- address_postal_code must be 5 to 10 characters",
          "- if the user gives a single street line, use address_line1",
          "- do not invent missing fields. only extract what the user actually stated",
          "return a strict json array of objects with key and value. return [] if nothing durable is present",
          "",
          sourceMessage.text,
        ].join("\n"),
      ),
    ]);

    const items = parseBasicInfoPayload(response.text).slice(0, 12);

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
