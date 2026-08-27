# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies, targeting the keyword subset `schema.ts` emits. It currently validates:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email and uri only), `pattern`, `minItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

Two known gaps where the generator emits constructs the validator does not fully check:

- `format: date` and `format: time` on date/time questions pass through unvalidated (#17).
- Grid questions become objects with a schema-valued `additionalProperties`, but the validator does not recurse into object entries, so grid values are only checked to be objects (#18).

`pattern` values are copied from Google Forms, whose regex validation uses RE2 syntax. `re2-compat.ts` evaluates only a subset that is both semantically compatible with RE2 and safe to execute with JavaScript's native backtracking engine. It translates `.` and `\s`/`\S`, whose default meanings differ between the engines, and escapes literal punctuation that JavaScript's `u` flag rejects. The `u` flag makes all constructs operate on whole code points; compatible non-BMP literals are preserved as well-formed surrogate pairs and treated as one atom, while lone surrogates are rejected.

Native execution safety rejects every unescaped alternation outside a character class; escaped `\|` and `[|]` remain literals. It further limits each pattern to at most one repetition, which must quantify a simple atom rather than a group. An unbounded repetition (`*`, `+`, or `{n,}`) is accepted only with a leading `^`. Counted repetitions use RE2's decimal grammar (no leading zeroes except `0`) and maximum bound of 1000; brace forms outside that grammar remain literal text. Patterns outside the semantic or execution-safe subset return null, including unsupported RE2 syntax, alternation, and patterns with nested, grouped, multiple, excessively large, or insufficiently anchored repetitions.

Unsupported, unsafe, or uncompilable patterns are rejected before a definition is written by the generator and rejected again for every registered form by `pnpm validate:forms`; `pnpm run deploy` runs that validation before Wrangler. The runtime validator's cached fail-open path remains only as defense when those gates are bypassed: it logs once, skips an unevaluable pattern rather than failing the request, and skips an enclosing `not` constraint because a rejection cannot be affirmed without evaluating its pattern. Google remains the final judge in that bypass case (#5).

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- Registered forms with patterns outside the verified semantic and native-execution-safe subset cannot deploy through the documented `pnpm run deploy` path. Direct Wrangler invocation bypasses this gate. The subset intentionally trades some local validation coverage for predictable Worker execution and agreement with Google.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
