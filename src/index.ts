import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { fetchAndParseForm, FormFetchError, FormParseError } from './lib/parser.js';
import { buildJsonSchema } from './lib/schema.js';
import registry from './forms/registry.js';
import { validate } from './lib/validator.js';
import { submitToGoogleForms, SubmissionError } from './lib/submitter.js';
import { verifyTurnstile, TurnstileError, TurnstileServiceError } from './lib/turnstile.js';

export interface Env {
  TURNSTILE_SECRET_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

// Public API — any origin may call this service
app.use('*', cors());

app.get('/', (c) =>
  c.json({ status: 'ok', endpoints: ['GET /schema?url=...', 'POST /schema { url }'] }),
);

app.get('/schema', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing required query parameter: url' }, 400);
  return handleSchema(url, c);
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
  return handleSchema(body.url, c);
});

async function handleSchema(url: string, c: Context<{ Bindings: Env }>) {
  try {
    const rawData = await fetchAndParseForm(url);
    const schema = buildJsonSchema(rawData);
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

  if (definition.turnstileEnabled) {
    const token = body['turnstile_token'];
    if (typeof token !== 'string' || token === '') {
      return c.json({ error: 'Missing or invalid turnstile_token' }, 400);
    }
    const remoteIp = c.req.header('CF-Connecting-IP');
    try {
      await verifyTurnstile(token, c.env.TURNSTILE_SECRET_KEY, remoteIp);
    } catch (err) {
      if (err instanceof TurnstileError) {
        return c.json({ error: 'Turnstile verification failed' }, 400);
      }
      if (err instanceof TurnstileServiceError) {
        console.error('Turnstile service error:', err.message);
        return c.json({ error: 'Turnstile verification is temporarily unavailable' }, 503);
      }
      console.error('Unexpected Turnstile error:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }

  try {
    await submitToGoogleForms(definition.submissionUrl, definition.fieldMap, body);
  } catch (err) {
    if (err instanceof SubmissionError) {
      // A value this proxy itself refused to serialize never reached Google.
      // Its message names the offending field, which is the whole point of it,
      // so pass it through rather than guessing at Google's validation rules.
      if (err.kind === 'invalid-value') {
        return c.json({ error: err.message }, 400);
      }

      const status = err.statusCode;

      // Google validates the submission itself and answers 400 when it rejects
      // one — a regex rule this proxy no longer checks locally, a missing
      // required answer, an over-length value (ADR 0006). That is the client's
      // fault, not an upstream failure, so it must not surface as a 502.
      // Google's body is a rendered HTML page, not a machine-readable error, so
      // there is no field-level detail to pass on.
      if (status === 400) {
        return c.json(
          {
            error:
              'Google Forms rejected the submission. Check the values against ' +
              "the form's validation rules.",
          },
          400,
        );
      }

      // 413 is the caller's payload by any reading, so it is a 400 too — but
      // the fault is the size of the request, not the content of any field.
      // Sending the caller off to audit their values would be a wrong turn.
      if (status === 413) {
        return c.json(
          {
            error:
              'The submission was too large for Google Forms to accept. ' +
              'Send a smaller payload.',
          },
          400,
        );
      }

      // Any other 4xx is about the form, not the payload: 403 restricted, 404
      // deleted or unpublished, 410 gone, 429 rate limited. Telling the caller
      // to check their values would send them after a fault that is not theirs,
      // so this stays a 502 and names Google's status — it is not sensitive,
      // and without it these cases are indistinguishable from the outside.
      if (status !== undefined && status >= 400 && status < 500) {
        return c.json(
          {
            error:
              `Google Forms did not accept the request (upstream HTTP ${status}). ` +
              'The form may be unavailable, restricted, or rate limited.',
          },
          502,
        );
      }

      return c.json({ error: 'Failed to submit to Google Forms' }, 502);
    }
    console.error('Unexpected submission error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ success: true });
});

export default app;
