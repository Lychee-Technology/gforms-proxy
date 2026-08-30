# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email, uri, date and time — the four values `schema.ts` emits), `minItems`, `maxItems`, `uniqueItems`, `additionalProperties` (`false` at the root, and the schema-valued form a grid object carries), `allOf`, `not`, `anyOf`

Three keywords are terminal for their property: a `type` mismatch stops further checks on that value; a `maxItems` violation stops before the `uniqueItems` dedupe, per-item `items` scan, and any `allOf`/`anyOf` combinators, so an oversized array costs one length comparison instead of work proportional to attacker-chosen length; and a `maxLength` violation stops before the `format` check and those same combinators, so an oversized string costs one comparison too.

`format: date` is RFC 3339 `full-date`: `YYYY-MM-DD`, plus a calendar check, so `2026-02-30` and a February 29 in a non-leap year are rejected rather than forwarded.

`format: time` deliberately is **not** Draft 2020-12's `time` (RFC 3339 `full-time`), which requires seconds and a UTC offset. It accepts `HH:MM` and nothing else. A Google Forms time answer is submitted as `entry.X_hour` / `entry.X_minute` (#23): there is no component to carry seconds or an offset, so accepting `09:30:15` or `14:30:00Z` would mean quietly dropping part of what the caller sent — the silent-corruption class #6 was opened about. A visible 400 naming the field is the better failure. If #23's submitter work ever adds a seconds component, this is the check that must widen with it. The goal here is to stop an arbitrary string reaching Google, not to become a conformant format registry (#17).

Neither format is reachable at runtime today: `assertSupportedFieldTypes` (`scripts/field-support.ts`) refuses to generate a definition containing a date or time question, so no bundled schema carries either value. The checks close the generator/validator coupling rule below on the same commit that `schema.ts` emits the keyword, rather than leaving it open until #23 lifts the guard.

The one known gap is now closed, leaving `pattern` below as the only construct `schema.ts` emits and this validator does not enforce — a deliberate delegation, not an oversight. Grid questions become objects with a schema-valued `additionalProperties`, and every entry of such a value is validated against that schema, with errors named `field.row` (#18). Recursion follows the schema rather than the payload: the inner schema for a grid is `{ type: 'string', enum: [...] }` and carries no `additionalProperties` of its own, so it terminates one level down however deeply a caller nests JSON.

Nested `properties` inside a property schema, and a boolean `additionalProperties` anywhere below the root, are deliberately unimplemented: the generator emits neither, and the coupling rule below asks this validator to track `schema.ts`, not JSON Schema at large.

Like the two formats above, grid checking is not reachable at runtime yet. `assertSupportedFieldTypes` still refuses to generate a definition containing a grid, and `submitter.ts` still refuses to serialize an object value, so submission remains the blocker (#23); the validator no longer is.

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
