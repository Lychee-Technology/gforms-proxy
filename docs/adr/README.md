# Architecture Decision Records

These ADRs record the decisions made in the project's design specs, whose working copies live in `docs/superpowers/specs/`. Per `AGENTS.md`, `docs/` is where decisions become durable; the ADRs stand on their own without the specs. Each one covers a single decision, the context at the time, and what followed from it.

| ADR | Decision |
|-----|----------|
| [0001](0001-static-bundled-form-registry.md) | Bundle form definitions statically instead of using KV/D1 |
| [0002](0002-hand-rolled-json-schema-validator.md) | Hand-rolled JSON Schema validator instead of ajv |
| [0003](0003-fieldmap-decouples-schema-keys-from-entry-ids.md) | Decouple schema keys from Google entry IDs via fieldMap |
| [0004](0004-cli-writes-form-definition-to-fixed-path.md) | CLI always writes FormDefinition to `src/forms/<formId>.json` |
| [0005](0005-backtracking-free-pattern-matcher.md) | Backtracking-free matcher for Google Forms patterns (superseded by 0006) |
| [0006](0006-google-enforces-patterns-not-us.md) | Google enforces `pattern`, not us |
| [0007](0007-no-live-schema-extraction-at-runtime.md) | Worker serves registered forms only; no live schema extraction |
| [0008](0008-compound-questions-through-structured-fieldmap.md) | Grid, date and time questions map through structured `fieldMap` entries |
| [0009](0009-turnstile-per-form-opt-in.md) | Turnstile is a per-form opt-in, verified by the Worker and guarded on regeneration |

To add an ADR: copy the format (Status / Date / Source, then Context / Decision / Consequences), take the next number, and add a row here.

When a new ADR invalidates a *statement* in an older one without overturning its decision, leave the original text alone and add a dated amendment note beside it (`> **Amended <date> by ADR NNNN:** …`), as ADRs 0001, 0004 and 0006 carry for ADR 0007. Change an ADR's `Status` to `Superseded by ADR NNNN` only when the whole decision is replaced, as ADR 0005 was by 0006.
