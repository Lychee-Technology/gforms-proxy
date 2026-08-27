# ADR 0001: Bundle form definitions statically instead of using KV/D1

**Status:** Accepted
**Date:** 2026-05-23
**Source:** design spec "Form Submission Proxy" (2026-05-23); working copy in `docs/superpowers/specs/`, which is gitignored and local only

## Context

The submission proxy (`POST /api/v1/forms/:formId/responses`) must know, for each supported Google Form, its JSON Schema, its `entry.XXXXXXX` field IDs, and its `formResponse` URL. This data changes only when a form's structure changes, and the set of supported forms is small and curated. Cloudflare Workers offer several places to keep it: KV, D1, or the Worker bundle itself.

## Decision

Each supported form is described by a `FormDefinition` JSON file checked into `src/forms/<formId>.json` and bundled into the Worker at deploy time. A static registry (`src/forms/registry.ts`) maps form IDs to definitions via explicit JSON imports (`with { type: 'json' }`) and a `Map`. Registering a form is a manual, two-line code change (one import, one Map entry) followed by a deploy.

The `/schema` endpoints remain stateless and work on any public form; only the submission path requires pre-registration.

## Consequences

- The Worker needs no storage bindings and does no reads at runtime. A form definition is exactly as current as the last deploy, with no eventual-consistency questions to reason about.
- Form definitions are version controlled and reviewed alongside the code that consumes them.
- Adding or updating a form requires a deploy. That is acceptable: registering a form is a deliberate developer action that happens rarely (see ADR 0004 for the generation step).
- The Worker only submits to forms that were explicitly registered, so the registry doubles as an allowlist. Nobody can use the proxy to spam arbitrary Google Forms.
- If a Google Form's structure changes upstream, the bundled definition goes stale until someone regenerates and redeploys. Nothing at runtime detects the drift.
