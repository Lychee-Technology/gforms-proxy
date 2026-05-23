import { GoogleGenAI } from '@google/genai';
import type { FieldMeta } from '../src/lib/types.js';
import { buildFieldsMeta } from '../src/lib/schema.js';

const GEMINI_MODEL = 'gemini-2.0-flash';

const normalizeKey = (value: string, fallbackLabel: string): string => {
  const try1 = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (try1) return try1;
  const try2 = fallbackLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return try2 || 'field';
};

const parseGeminiText = <T>(text: string): T => {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as T;
};

const buildGeminiPrompt = (questions: string[]) =>
  [
    'You are generating concise metadata for Google Forms questions.',
    'Return ONLY a JSON array; each element corresponds to the matching input question in order.',
    'Each element must have "title", "key", and "translated".',
    'title: concise English (<= 6 words), human-readable summary.',
    'key: snake_case, ASCII letters/numbers/underscores only, 3-30 chars, derived from meaning.',
    'translated: a faithful English translation of the original question (not shortened).',
    'No explanations or extra fields.',
    'Questions:',
    ...questions.map((q, idx) => `${idx + 1}. ${q}`),
  ].join('\n');

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
      contents: [{ role: 'user', parts: [{ text: buildGeminiPrompt(questions) }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise, <=6 word English summary.' },
              key: { type: 'string', description: 'snake_case, 3-30 chars.' },
              translated: { type: 'string', description: 'Faithful English translation.' },
            },
            required: ['title', 'key', 'translated'],
          },
        },
      },
    });

    const text = result?.text;
    if (!text) throw new Error('Empty Gemini response');

    const parsed = parseGeminiText<Array<Record<string, unknown>>>(text);
    return questions.map((q, idx) => {
      const item = parsed[idx] ?? {};
      const title =
        typeof item['title'] === 'string' && item['title'].trim() ? item['title'].trim() : q;
      const key = normalizeKey(typeof item['key'] === 'string' ? item['key'] : title, q);
      const translated =
        typeof item['translated'] === 'string' && item['translated'].trim()
          ? item['translated'].trim()
          : q;
      return { title, key, translated };
    });
  } catch {
    return buildFieldsMeta(questions);
  }
}

/**
 * Translates a form title to English using Gemini AI.
 * Returns the original title when apiKey is absent or translation fails.
 */
export async function translateFormTitleWithGemini(
  title: string,
  apiKey: string | null,
): Promise<string> {
  if (!apiKey) return title;

  try {
    const client = new GoogleGenAI({ apiKey });
    const result = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Translate the following Google Form title into clear English.',
                'Return JSON with a single property "translated".',
                'No explanations.',
                `Title: ${title}`,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { translated: { type: 'string' } },
          required: ['translated'],
        },
      },
    });

    const text = result?.text;
    if (!text) throw new Error('Empty Gemini response');
    const parsed = parseGeminiText<Record<string, unknown>>(text);
    const translated =
      typeof parsed['translated'] === 'string' && parsed['translated'].trim()
        ? parsed['translated'].trim()
        : title;
    return translated;
  } catch {
    return title;
  }
}
