import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { fetchAndParseForm, FormFetchError, FormParseError } from './lib/parser.js';
import { buildJsonSchema } from './lib/schema.js';
import registry from './forms/registry.js';
import { validate } from './lib/validator.js';
import { submitToGoogleForms, SubmissionError } from './lib/submitter.js';

export interface Env {
  GEMINI_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Public API — any origin may call this service; GEMINI_API_KEY stays server-side only
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

app.post('/api/v1/forms/:formId/responses', async (c) => {
  const formId = c.req.param('formId');
  const definition = registry.get(formId);
  if (!definition) return c.json({ error: 'Form not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = validate(body, definition.schema);
  if (errors.length > 0) {
    return c.json({ error: 'Validation failed', details: errors }, 400);
  }

  try {
    await submitToGoogleForms(definition.submissionUrl, definition.fieldMap, body);
  } catch (err) {
    if (err instanceof SubmissionError) {
      return c.json({ error: 'Failed to submit to Google Forms' }, 502);
    }
    console.error('Unexpected submission error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ success: true });
});

export default app;
