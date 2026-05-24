# Design: Auto-generate output path in gen-field-mapping.ts

## Summary

Remove the `--out` flag from `scripts/gen-field-mapping.ts`. The script will always write the generated `FormDefinition` JSON to `src/forms/<formId>.json`, with the path computed automatically from the fetched form ID.

## Changes

**`scripts/gen-field-mapping.ts`:**
- Remove `out` from `parseArgs` return type and argument parsing loop
- Update usage string to: `tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>]`
- Compute output path unconditionally after fetching: `path.resolve(process.cwd(), 'src/forms', rawData.formId + '.json')`
- Remove the `if (out) { ... } else { ... }` branch — file write is always performed
- Remove the stdout JSON schema print path

## Behaviour

Before: omitting `--out` printed the JSON schema to stdout; providing `--out <path>` wrote the full `FormDefinition` to that path.

After: the script always writes `FormDefinition` to `src/forms/<formId>.json`. The stdout schema-print mode is removed.
