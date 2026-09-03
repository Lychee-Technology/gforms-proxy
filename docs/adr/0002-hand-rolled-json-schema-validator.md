# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `properties`, `required`, `additionalProperties: false` (the three object keywords, at the root and on grid objects alike), `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email, uri, date and time — the four values `schema.ts` emits), `minItems`, `maxItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

Three keywords are terminal for their property: a `type` mismatch stops further checks on that value; a `maxItems` violation stops before the `uniqueItems` dedupe, per-item `items` scan, and any `allOf`/`anyOf` combinators, so an oversized array costs one length comparison instead of work proportional to attacker-chosen length; and a `maxLength` violation stops before the `format` check and those same combinators, so an oversized string costs one comparison too.

`format: date` is RFC 3339 `full-date`: `YYYY-MM-DD`, plus a calendar check, so `2026-02-30` and a February 29 in a non-leap year are rejected rather than forwarded.

`format: time` deliberately is **not** Draft 2020-12's `time` (RFC 3339 `full-time`), which requires seconds and a UTC offset. It accepts `HH:MM` and nothing else. A Google Forms time answer is submitted as `entry.X_hour` / `entry.X_minute` (#23): there is no component to carry seconds or an offset, so accepting `09:30:15` or `14:30:00Z` would mean quietly dropping part of what the caller sent — the silent-corruption class #6 was opened about. A visible 400 naming the field is the better failure. If #23's submitter work ever adds a seconds component, this is the check that must widen with it. The goal here is to stop an arbitrary string reaching Google, not to become a conformant format registry (#17).

Neither format is reachable at runtime today: `assertSupportedFieldTypes` (`scripts/field-support.ts`) refuses to generate a definition containing a date or time question, so no bundled schema carries either value. The checks close the generator/validator coupling rule below on the same commit that `schema.ts` emits the keyword, rather than leaving it open until #23 lifts the guard.

The one known gap is now closed, leaving `pattern` below as the only construct `schema.ts` emits and this validator does not enforce — a deliberate delegation, not an oversight. Grid questions become objects with a schema-valued `additionalProperties`, and every entry of such a value is validated against that schema, with errors named `field.row` (#18). Recursion follows the schema rather than the payload: the inner schema for a grid is `{ type: 'string', enum: [...] }` and carries no `additionalProperties` of its own, so it terminates one level down however deeply a caller nests JSON.

Nested `properties` inside a property schema, and a boolean `additionalProperties` anywhere below the root, are deliberately unimplemented: the generator emits neither, and the coupling rule below asks this validator to track `schema.ts`, not JSON Schema at large. Note the direction of that deviation — a nested `additionalProperties: false` reads here as "entries unchecked", where JSON Schema reads it as "no entry allowed", so it is permissive rather than strict. Only `validate` honours `false`, and only at the root. A test pins the deviation so making `schema.ts` emit the nested form has to come through here.

> **Amended 2026-09-01 by [ADR 0008](0008-compound-questions-through-structured-fieldmap.md):** no longer true. A grid is now emitted with named rows under `properties`, `required`, and `additionalProperties: false`, and the validator applies those three keywords to any object value with their JSON Schema meaning, through the same routine the root uses. The schema-valued `additionalProperties` form is no longer emitted or evaluated. Depth still follows the schema.

Like the two formats above, grid checking is not reachable at runtime yet. `assertSupportedFieldTypes` still refuses to generate a definition containing a grid, and `submitter.ts` still refuses to serialize an object value, so submission remains the blocker (#23); the validator no longer is.

> **Amended 2026-09-01 by [ADR 0008](0008-compound-questions-through-structured-fieldmap.md):** grids, `format: date` and `format: time` are now reachable: the generator accepts those questions and the submitter encodes them. The `HH:MM` decision above stands; a duration question (the one Google variant with seconds) is refused at generation instead.

`pattern` is emitted by `schema.ts` but is not evaluated here. Google Forms patterns are RE2, and Google enforces them server-side: a submission violating only a `regular_expression` rule is answered by `formResponse` with HTTP 400, while an otherwise identical valid one is answered 200 and recorded. That was measured against a live form, so "Google is the final judge" is verified behaviour rather than an assumption. Local evaluation of `pattern` was removed with the matcher that performed it; ADR 0006 records the measurements and the reasoning.

One consequence is load-bearing. `schema.ts` emits `{ not: { pattern } }` for `does_not_match` and `does_not_contain`, and the `allOf` loop evaluates a `not` member by running the inner schema and inverting the result. An unevaluated `pattern` yields no inner errors for any value, and inverting that would reject every submission to such a form. So a `not` constraint whose schema carries a `pattern` is skipped outright, however many other keys that schema carries.

There is correspondingly no build-time pattern gate: `pattern-policy.ts` and `pnpm validate:forms` are gone, and `pnpm run deploy` is plain `wrangler deploy`. A regex violation now reaches the client as a 400 relayed from Google, without field-level detail, rather than as a locally produced error naming the field (#5, ADR 0006).

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

> **Amended 2026-09-02 (#35):** the list is capped. Most error sources are bounded by the schema, but two are bounded by the payload: `additionalProperties: false` yields one error per unknown key, and `items` one per offending element (bounded today only because the generator emits `maxItems` on every array, #7). A 64 KB body of two-byte keys was measured at 8,359 errors and a 500 KB response, so the *response* was sized by the request rather than by the schema. `validate()` now collects at most `MAX_VALIDATION_ERRORS` (100) errors through one sink; the first error past the budget stops the payload-driven loops, and a single marker `{ field: '(root)', message: 'additional errors omitted' }` is appended only when something really was dropped, so a body producing exactly 100 errors gets all of them and no marker. The marker carries no count of what was omitted, deliberately: counting means finishing the walk, and the budget exists to stop early. The `not` and `anyOf` probes ask only whether a sub-schema produced any error, so they run on a sink of their own with a budget of one and neither spend nor are cut short by the caller's. The `maxItems` / `maxLength` terminal returns above bound the work on one *field*; this bounds the *list*, and it is not the second CPU bound that `AGENTS.md` warns against, because CPU is already bounded by the 64 KB cap and this changes only what is returned.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- No form can fail to deploy because of its regex. Nothing inspects a pattern at build time, and a pattern Google accepts is a pattern this proxy will forward.
- Because `maxLength` is terminal, a submitted string that is both too long and format-violating returns only the length error in the 400 `details`. No definition in `src/forms/` currently carries a `maxLength`, so nothing changes today; a consumer of `POST /api/v1/forms/:formId/responses` would see it the first time a registered form has a maximum-length rule.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- A 400 `details` array holds at most 101 entries: 100 errors, then the `(root)` marker when more were found (#35). A consumer that wants every error for a body with more than 100 problems has to fix the first 100 and resubmit; no form has anywhere near that many properties, so in practice the cap is reached only by a body that is mostly unknown keys.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
