# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email and uri only), `pattern`, `minItems`, `maxItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

Three keywords are terminal for their property: a `type` mismatch stops further checks on that value; a `maxItems` violation stops before the `uniqueItems` dedupe, per-item `items` scan, and any `allOf`/`anyOf` combinators, so an oversized array costs one length comparison instead of work proportional to attacker-chosen length; and a `maxLength` violation stops before the `format` and `pattern` checks and those same combinators, so an oversized string stops at `maxLength` before the pattern check, whose cost is linear in that same attacker-chosen length.

Two known gaps where the generator emits constructs the validator does not fully check:

- `format: date` and `format: time` on date/time questions pass through unvalidated (#17).
- Grid questions become objects with a schema-valued `additionalProperties`, but the validator does not recurse into object entries, so grid values are only checked to be objects (#18).

`pattern` values are copied from Google Forms, whose regex validation uses RE2 syntax. `re2/` evaluates only a subset that it can model faithfully: it parses the pattern into an AST and runs it on a matcher of our own, so no translation into a JavaScript `RegExp` is involved. Semantics that differ between the engines are resolved in the parser rather than passed through: `.` is any code point except `\n`, and `\s`/`\S` are RE2's ASCII class, which excludes `\v`. Both the pattern and the input are iterated as code points, so every construct is code-point-atomic and a non-BMP literal is one atom; lone surrogates are rejected.

Execution safety is no longer a property of the pattern. Patterns run on a backtracking-free matcher we own (`src/lib/re2/`), so alternation, multiple quantifiers, and quantified groups are all accepted; ADR 0005 records that decision and the remaining semantic limits. Patterns outside the supported subset return no matcher, as before.

Patterns the matcher cannot evaluate are rejected before a definition is written by the generator and rejected again for every registered form by `pnpm validate:forms`, unless the definition records `unevaluablePatternsAllowed: true`, which downgrades both gates to a warning; `pnpm run deploy` runs that validation before Wrangler. The deploy script inlines the check (`pnpm validate:forms && wrangler deploy`) rather than using a `predeploy` hook, because pnpm only honors pre-scripts when `enable-pre-post-scripts` is on, and that setting varies by user config and pnpm version. The runtime validator's cached fail-open path remains only as defense when those gates are bypassed: it logs once, skips an unevaluable pattern rather than failing the request, and skips an enclosing `not` constraint because a rejection cannot be affirmed without evaluating its pattern. Google remains the final judge in that bypass case (#5).

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- Registered forms with patterns outside the supported semantic subset cannot deploy through the documented `pnpm run deploy` path unless the definition records `unevaluablePatternsAllowed: true`, which downgrades the gate to a warning. Direct Wrangler invocation bypasses the gate entirely.
- Because `maxLength` is terminal, a submitted string that is both too long and pattern-violating now returns only the length error in the 400 `details`, where it previously returned both. No definition in `src/forms/` currently carries a `maxLength`, so nothing changes today; a consumer of `POST /api/v1/forms/:formId/responses` would see it the first time a registered form has a maximum-length rule.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
