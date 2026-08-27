# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email and uri only), `pattern`, `minItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

Three known gaps where the generator emits constructs the validator does not fully check:

- `format: date` and `format: time` on date/time questions pass through unvalidated (#17).
- Grid questions become objects with a schema-valued `additionalProperties`, but the validator does not recurse into object entries, so grid values are only checked to be objects (#18).
- `pattern` values are copied from Google Forms, whose regex validation uses RE2 syntax. Patterns are evaluated only within a verified JavaScript-compatible RE2 subset: `re2-compat.ts` translates each pattern into JavaScript source with identical semantics (exact translations for `.` and `\s`/`\S`, whose default meanings differ between the engines) and returns null for anything outside the subset — inline flags, `\A`/`\z`, `\Q...\E`, `\p`, POSIX classes, digit escapes, non-BMP literals, and any construct not on the whitelist. A null-translated or uncompilable pattern is skipped with a logged warning rather than failing the request; a `not` constraint whose pattern is skipped is skipped entirely, since without evaluating the pattern a rejection can never be affirmed. Validation of such values is delegated to Google as the final judge (#5).

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
