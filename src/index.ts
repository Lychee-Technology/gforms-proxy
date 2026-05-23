import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { fetchAndParseForm, FormFetchError, FormParseError } from './lib/parser.js';
import { buildJsonSchema } from './lib/schema.js';

export interface Env {
  GEMINI_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({ status: 'ok', endpoints: ['GET /schema?url=...', 'POST /schema { url }'] }),
);

app.get('/schema', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required query parameter: url' }, 400);
  return handleSchema(url, c.env.GEMINI_API_KEY ?? null, c);
});

app.post('/schema', async (c) => {
  let body: { url?: unknown };
  try {
    body = await c.req.json<{ url?: unknown }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.url !== 'string' || !body.url) {
    return c.json({ error: 'Body field "url" must be a non-empty string' }, 400);
  }
  return handleSchema(body.url, c.env.GEMINI_API_KEY ?? null, c);
});

async function handleSchema(
  url: string,
  geminiApiKey: string | null,
  c: Context<{ Bindings: Env }>,
) {
  try {
    const rawData = await fetchAndParseForm(url);
    const schema = await buildJsonSchema(rawData, geminiApiKey);
    return c.json(schema);
  } catch (err) {
    if (err instanceof FormParseError) return c.json({ error: err.message }, 400);
    if (err instanceof FormFetchError) {
      return c.json({ error: err.message }, err.statusCode === 404 ? 404 : 502);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

export default app;
