# ADR 0004: CLI always writes FormDefinition to src/forms/&lt;formId&gt;.json

**Status:** Accepted
**Date:** 2026-05-24
**Source:** design spec "Auto-generate output path in gen-field-mapping.ts" (2026-05-24), superseding the `--out` flag from the "Form Submission Proxy" spec (2026-05-23); working copies in `docs/superpowers/specs/`

## Context

`scripts/gen-field-mapping.ts` originally had two output modes: without `--out` it printed the JSON Schema to stdout; with `--out <path>` it wrote a full `FormDefinition` file to an arbitrary path. But the file has exactly one correct destination, `src/forms/<formId>.json`, which is where the registry (ADR 0001) imports it from, and the script already learns the form ID from the fetched form. Asking the developer for a path only created a way to put the file in the wrong place. The stdout mode duplicated what the Worker's `/schema` endpoint already provided at the time.

## Decision

Remove the `--out` flag and the stdout print mode. The script always writes the `FormDefinition` to `src/forms/<formId>.json`, computing the path from the fetched form's ID.

## Consequences

- Generation is a single command with no path decisions, and the output always lands where the registry expects it.
- Regenerating a form overwrites its existing definition in place. That makes refreshing a stale definition easy, but it also means a re-run can drop anything the previous run added on purpose; the regeneration guard for Turnstile-protected forms exists for that reason (see [ADR 0009](0009-turnstile-per-form-opt-in.md)).
- Inspecting a form's schema without writing a file is now done through the `/schema` endpoint (or by reading the generated JSON), not the CLI.

> **Amended 2026-08-28 by [ADR 0007](0007-no-live-schema-extraction-at-runtime.md):** the `/schema` endpoint no longer exists, so there is no longer any way to inspect an *unregistered* form's schema without running this script. A registered form's schema is read from `GET /api/v1/forms/:formId/schema` or from `src/forms/<formId>.json` directly. The decision recorded here — one fixed output path, no stdout mode — is unchanged; only the alternative it pointed at is gone.
