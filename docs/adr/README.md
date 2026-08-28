# Architecture Decision Records

These ADRs record the decisions made in the project's design specs, whose working copies live in `docs/superpowers/specs/`. Per `AGENTS.md`, `docs/` is where decisions become durable; the ADRs stand on their own without the specs. Each one covers a single decision, the context at the time, and what followed from it.

| ADR | Decision |
|-----|----------|
| [0001](0001-static-bundled-form-registry.md) | Bundle form definitions statically instead of using KV/D1 |
| [0002](0002-hand-rolled-json-schema-validator.md) | Hand-rolled JSON Schema validator instead of ajv |
| [0003](0003-fieldmap-decouples-schema-keys-from-entry-ids.md) | Decouple schema keys from Google entry IDs via fieldMap |
| [0004](0004-cli-writes-form-definition-to-fixed-path.md) | CLI always writes FormDefinition to `src/forms/<formId>.json` |
| [0005](0005-backtracking-free-pattern-matcher.md) | Backtracking-free matcher for Google Forms patterns |

To add an ADR: copy the format (Status / Date / Source, then Context / Decision / Consequences), take the next number, and add a row here.
