# ADR 0009: Turnstile is a per-form opt-in, verified by the Worker and guarded on regeneration

**Status:** Accepted
**Date:** 2026-09-02
**Source:** issue #16. The decisions were made in commit `e54b334` (2026-05-24, Turnstile verification and the first protected form), then refined by #11 / PR #12 (regeneration guard), PR #13 (reserved `turnstile_token` key) and #4 / PR #19 (failure classification). None of them had a design spec; this ADR records them after the fact.

## Context

The submission endpoint is public and unauthenticated, and one of the
registered forms is a public contact form on a marketing site. Without a
bot check, anything that can POST JSON can fill that form. Cloudflare
Turnstile fits the deployment: the site renders the widget, the Worker
verifies the resulting token against Cloudflare's siteverify endpoint, and
no CAPTCHA state has to live anywhere.

Not every registered form wants this. Of the two registered at the time of
writing, only the contact form is protected; the other is submitted from a
context that renders no widget, and forcing a token on it would break that
caller for no gain. So the question was where the "this form is protected" fact lives, how
a caller learns that a token is expected, how verification failures are
reported, and what happens to the protection when a definition is
regenerated, given that ADR 0004 makes regeneration overwrite the file in
place.

## Decision

**Protection is a property of the form definition.** `FormDefinition` has an
optional `turnstileEnabled` flag, set by the generator when `--turnstile` is
passed and absent otherwise. The flag travels with the definition into the
bundle (ADR 0001), so the Worker needs no separate list of protected forms and
a form's protection is visible in the same file as its schema.

**The schema tells the caller.** When `--turnstile` is passed, the generator
splices a required string property `turnstile_token` into the generated
schema. `GET /api/v1/forms/:formId/schema` therefore describes the body the
proxy accepts, which for a protected form is one property wider than the
Google form itself. The key is reserved: `schema.ts` seeds its key
deduplication with `turnstile_token`, so a form question whose generated key
would collide is renamed (`turnstile_token_2`) and can never shadow the
token.

**The Worker verifies at request time.** For a definition with
`turnstileEnabled: true`, the route runs after schema validation and before
the Google submission: it requires a non-empty string `turnstile_token`
(checked directly, not only through the schema, so the two cannot drift),
then POSTs it with the `TURNSTILE_SECRET_KEY` secret and the caller's
`CF-Connecting-IP` to siteverify (`src/lib/turnstile.ts`). The secret is a
Worker secret, never part of a definition.

Failures are split by who is at fault:

- A token that siteverify rejects is a `TurnstileError`, answered as **400**.
  The `error-codes` array is logged.
- A verification that could not be performed is a `TurnstileServiceError`,
  answered as **503**: the secret is unset or empty, siteverify is
  unreachable or times out (`fetch-timeout.ts`), answers non-2xx, returns
  non-JSON, or returns a payload whose `success` is not a boolean. None of
  these blames the token, because it may well have been valid.

Verification runs after schema validation so a malformed body never costs a
siteverify round trip, and before submission so a rejected token never
reaches Google.

**Regeneration cannot strip protection silently.** Because the generator
overwrites `src/forms/<formId>.json` in place (ADR 0004), a routine re-run
without `--turnstile` would drop both the flag and the schema splice, and
the diff would look like any other regeneration. `scripts/turnstile-guard.ts`
therefore reads the existing file before anything else: if it carries
`turnstileEnabled: true` and neither `--turnstile` nor `--force` was passed,
the script aborts with a message naming both flags. `--force` is the
deliberate way to strip protection. The guard runs before the form is fetched,
since the form ID comes from the URL alone. An existing file that is not
valid JSON is waved through, because there is no protection to preserve; a
file that cannot be read is an error, because there might be.

## Alternatives considered

- **Turnstile on every form.** Rejected: callers without a widget would be
  locked out, and forms that are not publicly linked gain nothing.
- **A list of protected form IDs in Worker configuration** (an env var or a
  constant in `src/index.ts`). Rejected: the schema splice and the flag must
  agree, and keeping both in the definition makes that agreement a property of
  one generated file rather than of two places edited by hand.
- **Deriving "protected" from the presence of `turnstile_token` in the
  schema** instead of a flag. Rejected: the flag is what a reader and the
  guard look for, and PR #19 made the route tolerate the two drifting rather
  than depend on one implying the other.
- **Letting the guard warn instead of abort.** Rejected: a warning on stderr
  during a routine regeneration is exactly the kind of signal that gets
  missed, and the cost of the abort is one flag on the command line.

## Consequences

- A protected form is onboarded with `--turnstile` and served with the
  `TURNSTILE_SECRET_KEY` secret set; a deploy that forgets the secret answers
  503 with a logged configuration error instead of failing every token as
  invalid.
- Callers of a protected form must render the Turnstile widget and send its
  token as `turnstile_token`; the served schema says so.
- `turnstile_token` is not available as a field key for any form, protected
  or not.
- Regenerating a protected form requires `--turnstile` on every run, or
  `--force` to strip protection on purpose; there is no silent third
  outcome.
- Every submission to a protected form costs one outbound request to
  siteverify in addition to the one to Google, both bounded by
  `FETCH_TIMEOUT_MS`.
- The Worker still holds no per-request state; siteverify's own replay
  protection is what makes a token single-use.
