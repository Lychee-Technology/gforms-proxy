# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email and uri only), `minItems`, `maxItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

Three keywords are terminal for their property: a `type` mismatch stops further checks on that value; a `maxItems` violation stops before the `uniqueItems` dedupe, per-item `items` scan, and any `allOf`/`anyOf` combinators, so an oversized array costs one length comparison instead of work proportional to attacker-chosen length; and a `maxLength` violation stops before the `format` check and those same combinators, so an oversized string costs one comparison too.

Two known gaps where the generator emits constructs the validator does not fully check:

- `format: date` and `format: time` on date/time questions pass through unvalidated (#17).
- Grid questions become objects with a schema-valued `additionalProperties`, but the validator does not recurse into object entries, so grid values are only checked to be objects (#18).

`pattern` is emitted by `schema.ts` but is not evaluated here. Google Forms patterns are RE2, and Google enforces them server-side: a submission violating only a `regular_expression` rule is answered by `formResponse` with HTTP 400, while an otherwise identical valid one is answered 200 and recorded. That was measured against a live form, so "Google is the final judge" is verified behaviour rather than an assumption. Local evaluation of `pattern` was removed with the matcher that performed it; ADR 0006 records the measurements and the reasoning.

One consequence is load-bearing. `schema.ts` emits `{ not: { pattern } }` for `does_not_match` and `does_not_contain`, and the `allOf` loop evaluates a `not` member by running the inner schema and inverting the result. An unevaluated `pattern` yields no inner errors for any value, and inverting that would reject every submission to such a form. So a `not` constraint whose schema carries a `pattern` is skipped outright, however many other keys that schema carries.

There is correspondingly no build-time pattern gate: `pattern-policy.ts` and `pnpm validate:forms` are gone, and `pnpm run deploy` is plain `wrangler deploy`. A regex violation now reaches the client as a 400 relayed from Google, without field-level detail, rather than as a locally produced error naming the field (#5, ADR 0006).

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- No form can fail to deploy because of its regex. Nothing inspects a pattern at build time, and a pattern Google accepts is a pattern this proxy will forward.
- Because `maxLength` is terminal, a submitted string that is both too long and format-violating returns only the length error in the 400 `details`. No definition in `src/forms/` currently carries a `maxLength`, so nothing changes today; a consumer of `POST /api/v1/forms/:formId/responses` would see it the first time a registered form has a maximum-length rule.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
