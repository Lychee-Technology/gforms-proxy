# ADR 0002: Hand-rolled JSON Schema validator instead of ajv

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`, which is gitignored and local only

## Context

The submission endpoint validates request bodies against each form's JSON Schema (Draft 2020-12) before forwarding to Google. The obvious choice is ajv, but ajv compiles schemas to JavaScript with `new Function`, which Cloudflare Workers disallow (no runtime code generation). ajv's pre-compilation workflow and the interpreting validators that could replace it would add build complexity or a large dependency, all to validate schemas whose shape we fully control: every schema is produced by our own `schema.ts`.

## Decision

Write a purpose-built validator (`src/lib/validator.ts`) with no external dependencies that supports exactly the keyword subset `schema.ts` emits:

`type`, `required`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `format` (email, uri), `pattern`, `minItems`, `uniqueItems`, `allOf`, `not`, `anyOf`

It returns a flat list of `{ field, message }` errors, which the route surfaces as a 400 response with structured `details`.

## Consequences

- Validation runs on Workers with zero dependencies and no schema-compilation step.
- The validator is not a general-purpose JSON Schema implementation. It is coupled to the generator: whenever `schema.ts` starts emitting a new keyword, `validator.ts` must learn it in the same change, with tests. `AGENTS.md` also records this rule.
- Error messages are our own format, written for API consumers, rather than ajv's error objects.
- The validator ignores keywords it does not recognize instead of rejecting them, so code review, not the runtime, enforces the coupling rule above.
