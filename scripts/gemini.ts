import { GoogleGenAI } from "@google/genai";
import type { FieldMeta } from "../src/lib/types.js";
import { buildFieldsMeta, normalizeKey } from "../src/lib/schema.js";

const GEMINI_MODEL = "gemini-3.1-flash-lite";

const parseGeminiText = <T>(text: string): T => {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned) as T;
};

const buildGeminiPrompt = (questions: string[]) =>
  [
    "You are generating concise metadata for Google Forms questions.",
    "Return ONLY a JSON array; each element corresponds to the matching input question in order.",
    'Each element must have "title", "key", and "translated".',
    "title: concise English (<= 6 words), human-readable summary.",
    "key: snake_case, ASCII letters/numbers/underscores only, 3-30 chars, derived from meaning.",
    "translated: a faithful English translation of the original question (not shortened).",
    "No explanations or extra fields.",
    "Questions:",
    ...questions.map((q, idx) => `${idx + 1}. ${q}`),
  ].join("\n");

/**
 * Builds field metadata using Gemini AI enrichment.
 * Falls back to `buildFieldsMeta` (field_N keys) when apiKey is absent.
 */
export async function buildFieldsMetaWithGemini(
  questions: string[],
  apiKey: string | null,
): Promise<FieldMeta[]> {
  if (!apiKey || !questions.length) return buildFieldsMeta(questions);

  try {
    const client = new GoogleGenAI({ apiKey });
    const result = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        { role: "user", parts: [{ text: buildGeminiPrompt(questions) }] },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Concise, <=6 word English summary.",
              },
              key: { type: "string", description: "snake_case, 3-30 chars." },
              translated: {
                type: "string",
                description: "Faithful English translation.",
              },
            },
            required: ["title", "key", "translated"],
          },
        },
      },
    });

    const text = result?.text;
    if (!text) throw new Error("Empty Gemini response");

    const parsed = parseGeminiText<Array<Record<string, unknown>>>(text);
    return questions.map((q, idx) => {
      const item = parsed[idx] ?? {};
      const title =
        typeof item["title"] === "string" && item["title"].trim()
          ? item["title"].trim()
          : q;
      const key = normalizeKey(
        typeof item["key"] === "string" ? item["key"] : title,
        q,
      );
      const translated =
        typeof item["translated"] === "string" && item["translated"].trim()
          ? item["translated"].trim()
          : q;
      return { title, key, translated };
    });
  } catch {
    return buildFieldsMeta(questions);
  }
}
