import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { unavailable } from "../http/errors.js";
import { ragConfig } from "./config.js";

let chatModel: BaseChatModel | undefined;
let draftModel: ChatAnthropic | undefined;

/** The chat model. Throws a 503 when its API key is not configured. */
export function getChatModel(): BaseChatModel {
  if (chatModel) return chatModel;
  if (ragConfig.llmProvider === "anthropic") {
    if (!ragConfig.anthropicApiKey) throw unavailable("AI chat is not configured: ANTHROPIC_API_KEY is missing");
    chatModel = new ChatAnthropic({
      model: ragConfig.anthropicModel,
      apiKey: ragConfig.anthropicApiKey,
      temperature: 0,
    });
  } else {
    if (!ragConfig.openaiApiKey) throw unavailable("AI chat is not configured: OPENAI_API_KEY is missing");
    chatModel = new ChatOpenAI({
      model: ragConfig.openaiChatModel,
      apiKey: ragConfig.openaiApiKey,
      temperature: 0,
    });
  }
  return chatModel;
}

/** The drafting model (always Anthropic). Throws a 503 when its key is not configured. */
export function getDraftModel(): ChatAnthropic {
  if (draftModel) return draftModel;
  if (!ragConfig.anthropicApiKey) throw unavailable("AI drafting is not configured: ANTHROPIC_API_KEY is missing");
  draftModel = new ChatAnthropic({
    model: ragConfig.draftModel,
    apiKey: ragConfig.anthropicApiKey,
    maxTokens: 8192,
    // Newer Claude models reject {type: "disabled"} (LangChain's default) and
    // expect "between_tools": no upfront thinking, only short notes between
    // tool calls. Not yet in the installed SDK's types, hence the cast.
    thinking: { type: "between_tools" } as never,
  });
  return draftModel;
}
