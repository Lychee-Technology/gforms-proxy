# ADR 0004: CLI always writes FormDefinition to src/forms/&lt;formId&gt;.json

**Status:** Accepted
**Date:** 2026-05-24
**Source:** design spec "Auto-generate output path in gen-field-mapping.ts" (2026-05-24), superseding the `--out` flag from the "Form Submission Proxy" spec (2026-05-23); working copies in `docs/superpowers/specs/`

## Context

`scripts/gen-field-mapping.ts` originally had two output modes: without `--out` it printed the JSON Schema to stdout; with `--out <path>` it wrote a full `FormDefinition` file to an arbitrary path. But the file has exactly one correct destination, `src/forms/<formId>.json`, which is where the registry (ADR 0001) imports it from, and the script already learns the form ID from the fetched form. Asking the developer for a path only created a way to put the file in the wrong place. The stdout mode duplicated what the Worker's `/schema` endpoint already provides.

## Decision

Remove the `--out` flag and the stdout print mode. The script always writes the `FormDefinition` to `src/forms/<formId>.json`, computing the path from the fetched form's ID.

## Consequences

- Generation is a single command with no path decisions, and the output always lands where the registry expects it.
- Regenerating a form overwrites its existing definition in place. That makes refreshing a stale definition easy, but it also meant a routine regeneration could silently strip Turnstile protection, which is why `scripts/turnstile-guard.ts` was added later: regenerating a `turnstileEnabled: true` form without `--turnstile` aborts unless `--force` is passed.
- Inspecting a form's schema without writing a file is now done through the `/schema` endpoint (or by reading the generated JSON), not the CLI.
