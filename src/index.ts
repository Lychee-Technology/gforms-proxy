import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
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

// A registered form's schema is already bundled into the Worker (ADR 0001), so
// serving it costs Google nothing. The Worker performs no live schema
// extraction at all — that is the offline generator's job (ADR 0007).
//
// Deliberately no Cache-Control: a bundled schema changes only on deploy, so a
// TTL would buy a stale window after every deploy in exchange for saving a
// request answered from memory (ADR 0007).
app.get('/api/v1/forms/:formId/schema', (c) => {
  const definition = registry.get(c.req.param('formId'));
  if (!definition) return c.json({ error: 'Form not found' }, 404);
  return c.json(definition.schema);
});

// A free Cloudflare Worker gets 10 ms of CPU per request. Everything the
// submission route does after this point is linear in the request body, and
// without a cap the caller picks the multiplier: `JSON.parse` below, the
// `additionalProperties: false` key walk (its error objects are capped at 100
// since #35, but the walk over the keys is still linear),
// `uniqueItems`' `JSON.stringify` per array element, `EMAIL_RE` / `URI_RE`
// over each string, and `encodeURIComponent` over every value in
// `submitter.ts`. None of those is superlinear — this is not a ReDoS cliff —
// but 10 ms is the entire budget, so the size of the input is the only thing
// left to bound (issue #29).
//
// `maxLength` and `maxItems` are terminal in `validator.ts` and do bound a
// field, but only when the generator emitted them; neither registered form
// carries a `maxLength` today. This bounds the request whether or not they
// are there.
//
// 64 KB is roughly nine times the largest bundled schema and far above any
// plausible form response. Hono's default over-limit response is plain text,
// which would put the one non-JSON error in an API where every error is JSON
// (ADR 0007), so `onError` supplies it.
//
// Route middleware, not `app.use('*')`: the schema route carries no body, and
// a POST to an unmatched path never reads one. One consequence is that an
// oversized body aimed at an unregistered formId is refused here rather than
// by the handler's 404. That discloses nothing — the 413 is identical for a
// registered and an unregistered ID.
const submissionBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});

app.post('/api/v1/forms/:formId/responses', submissionBodyLimit, async (c) => {
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

// Every error this API emits is JSON; Hono's default 404 is plain text, which
// would make an unmatched route the one response a client has to parse
// differently. "Not found" (no such route) stays distinct from "Form not
// found" (route matched, form unregistered).
//
// This covers real requests only. A CORS preflight is answered by the cors()
// middleware above before routing, so OPTIONS is 204 on every path, matched or
// not — deliberately, since a route-aware preflight would tell any origin
// whether a formId is registered. The request that follows it still lands
// here.
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
