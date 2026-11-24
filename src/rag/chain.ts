import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type pg from "pg";
import { config } from "../config.js";
import type { Embedder } from "./embeddings.js";
import { formatContext, retrieve, userHasVisibleFiles } from "./retrieval.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface QueryResult {
  answer: string;
  sources: string[];
}

export const NO_ANSWER = "Jag har tyvärr inte den informationen i de tillgängliga dokumenten.";

export const systemPrompt = () => `Du är en expert på ${config.knowledgeBaseName} för omsorgsverksamhet (personlig assistans).
Du svarar på frågor baserat ENBART på de dokument som ges som kontext nedan.

Instruktioner:
- Svara alltid på svenska om inte frågan ställs på ett annat språk.
- Referera till specifika dokument och avsnitt i ditt svar (t.ex. "Enligt D - 5. Rutin för kost...").
- Om kontexten innehåller delvis information, ge det du kan och notera vad som saknas.
- Om informationen inte finns i kontexten alls, säg tydligt att du inte har den informationen.
- Var konkret och hänvisa till rutinnamn och dokumentnummer när möjligt.

Kontext:
{context}`;

/** History goes into prompt templates, where a literal brace would be read as a variable. */
const escapeTemplate = (s: string) => s.replace(/\{/g, "{{").replace(/\}/g, "}}");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("");
}

async function rewriteQuery(
  llm: BaseChatModel,
  question: string,
  history: ChatMessage[]
): Promise<string> {
  const historyContext =
    history.length > 0
      ? `\nTidigare konversation:\n${history
          .slice(-4)
          .map((m) => `${m.role === "user" ? "Användare" : "Assistent"}: ${escapeTemplate(m.content)}`)
          .join("\n")}\n`
      : "";

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `Du är en sökassistent för dokument om ${config.knowledgeBaseName} inom omsorgsverksamhet.
Skriv om användarens fråga till en optimal sökfråga som matchar formellt svenskt fackspråk i policydokument.
${historyContext}
Regler:
- Behåll svenska termer och fackspråk
- Om frågan refererar till tidigare konversation (t.ex. "berätta mer", "det där"), lös referensen
- Expandera förkortningar
- Svara BARA med den omskrivna sökfrågan, inget annat`,
    ],
    ["human", "{question}"],
  ]);
  const result = await prompt.pipe(llm).invoke({ question });
  return textOf(result.content).trim();
}

export interface QueryDeps {
  db: pg.Pool;
  embedder: Embedder;
  llm: BaseChatModel;
}

export async function query(
  { db, embedder, llm }: QueryDeps,
  userId: string,
  question: string,
  history: ChatMessage[]
): Promise<QueryResult> {
  // Fail closed, and before any paid call.
  if (!(await userHasVisibleFiles(db, userId))) return { answer: NO_ANSWER, sources: [] };

  const rewritten = await rewriteQuery(llm, question, history);
  const docs = await retrieve(db, embedder, userId, rewritten);
  if (docs.length === 0) return { answer: NO_ANSWER, sources: [] };

  const messages: Array<["system" | "human" | "ai", string]> = [["system", systemPrompt()]];
  for (const m of history.slice(-5)) {
    messages.push([m.role === "user" ? "human" : "ai", escapeTemplate(m.content)]);
  }
  messages.push(["human", "{input}"]);

  const response = await ChatPromptTemplate.fromMessages(messages)
    .pipe(llm)
    .invoke({ context: formatContext(docs), input: question });

  const sources = [...new Set(docs.map((d) => d.metadata?.source).filter(Boolean) as string[])];
  return { answer: textOf(response.content), sources };
}
