# AGENTS.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Commands

```bash
pnpm test                                  # run all tests (vitest run)
pnpm vitest run src/lib/__tests__/schema.test.ts   # run a single test file
pnpm test:watch                            # vitest watch mode
pnpm typecheck                             # typecheck src (Workers types) and scripts (node types)
pnpm dev                                   # wrangler dev (local Worker)
pnpm run deploy                            # wrangler deploy
pnpm cf-types                              # regenerate Cloudflare binding types
```

Use `pnpm run deploy`, not `pnpm deploy`: `deploy` is a project script, and `pnpm deploy` is pnpm's own unrelated command.

Generate a form definition (writes `src/forms/<formId>.json`):

```bash
pnpm exec tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>] [--turnstile] [--force]
```

`--gemini-key` (or the `GEMINI_API_KEY` env var) enables Gemini-generated field keys and translations; without it, `buildFieldsMeta` falls back to mechanical `field_N` keys. Grid row keys are always mechanical (`normalizeKey` of the row label, `row_N` fallback). The script refuses forms containing a date that includes a time, a date without a year, or a duration (`scripts/field-support.ts`, ADR 0008); grid, date and time questions themselves are supported. `--turnstile` marks the form as Turnstile-protected. Regenerating a form whose existing JSON has `turnstileEnabled: true` without `--turnstile` aborts (the guard lives in `scripts/turnstile-guard.ts`); pass `--force` to strip protection intentionally.

When the generated schema carries at least one `pattern`, the script prints a note to stderr saying how many fields carry regex validation and that Google, not this proxy, enforces those rules at submission time (ADR 0006). It is informational only: it never changes the exit status or blocks the write.

## Architecture

A Cloudflare Worker (Hono app, entry `src/index.ts` per `wrangler.toml`) that fronts Google Forms. It does two things:

1. Schema lookup: `GET /api/v1/forms/:formId/schema` returns a registered form's bundled JSON Schema (Draft 2020-12) from the registry, with no outbound request.
2. Submission proxy: `POST /api/v1/forms/:formId/responses` accepts JSON for pre-registered forms only, validates it against the stored schema, optionally verifies a Cloudflare Turnstile token, then posts urlencoded data to Google's `formResponse` endpoint. `hono/body-limit` caps the body at 64 KB and answers a JSON `413` above it.

Both routes serve registered forms only; anything else gets a JSON `404`. The Worker performs no live schema extraction and never fetches a caller-supplied URL — its only outbound requests go to Google's `formResponse` and Turnstile's siteverify (ADR 0007).

An offline generation step feeds both: `scripts/gen-field-mapping.ts` fetches a form, builds its `FormDefinition` (the schema plus a `fieldMap` from schema keys to `entry.XXXXXXX` IDs), and writes `src/forms/<formId>.json`. Registration is manual: add a JSON import (`with { type: 'json' }`) and a Map entry in `src/forms/registry.ts`, then deploy. Definitions are bundled into the Worker, not stored in KV or D1.

Data flows through `src/lib/`:

- `parser.ts` and `schema.ts` are build-time only: `scripts/gen-field-mapping.ts` is their sole importer, and the Worker does not bundle them (ADR 0007). `validateFormUrl` there guards a CLI run, not a public endpoint.
- `parser.ts` fetches the form HTML and extracts the `FB_PUBLIC_LOAD_DATA_` embedded array (question labels, type codes, options, required flags, validation rules). The reverse-engineered format is documented in `google-forms-internals.md`; the type-code and validation-code tables live in `types.ts`.
- `schema.ts` turns parsed data into the JSON Schema and fieldMap. Grid questions become closed objects with one named property per row (`resolveRowKeys` is shared with the fieldMap so the two agree); validation rules map to JSON Schema keywords. A fieldMap value is a `FieldMapping`: a plain `entry.X` string, or a `date` / `time` / `grid` object carrying what the submitter needs (ADR 0008).
- `validator.ts` is a hand-rolled validator for the JSON Schema subset that `schema.ts` emits (no ajv, so it runs fine on Workers). `properties`, `required` and `additionalProperties: false` are handled at the root and on grid objects through one shared routine; errors below the root are named `field.row`. If `schema.ts` starts emitting a new keyword, `validator.ts` must learn it too. The exception is `pattern`, which is deliberately not evaluated: Google enforces regex rules server-side and answers 400 when a submission violates one (ADR 0006). A `not` constraint whose schema carries a `pattern` is skipped outright, because inverting an unevaluated pattern would reject every submission to that form. Errors are collected through one sink with a budget of `MAX_VALIDATION_ERRORS` (100): the first error past it stops the payload-driven loops (`additionalProperties` keys, array `items`, the `properties` descent), and `validate` appends a single `(root)` / `additional errors omitted` marker only when something was actually dropped, with no count (#35). The `not` / `anyOf` probes use a sink of their own with a budget of one.
- `submitter.ts` and `turnstile.ts` handle runtime submission and Turnstile siteverify. The submitter switches on the `FieldMapping`: a string is one `entry.X` parameter (arrays repeat it), a `date` mapping splits `YYYY-MM-DD` into `entry.X_year/_month/_day`, a `time` mapping splits `HH:MM` into `entry.X_hour/_minute`, and a `grid` mapping sends one parameter per answered row under that row's entry ID. Any value of the wrong shape is an `invalid-value` error raised before any fetch, which the route answers as a 400. Turnstile applies only to definitions with `turnstileEnabled: true`; those schemas also require a `turnstile_token` property (spliced in by the generator), and the Worker needs the `TURNSTILE_SECRET_KEY` secret.
- The 64 KB body cap on the submission route is a CPU bound, not a correctness one. A free Worker gets 10 ms of CPU per request, and everything the route does after the cap is linear in the body: `JSON.parse`, the `additionalProperties: false` key walk, `uniqueItems`' `JSON.stringify` per element, the `format` regexes, and `encodeURIComponent` in `submitter.ts`. None is superlinear; the cap exists so the caller does not choose the multiplier. `maxLength` / `maxItems` bound a single field, and only when the generator emitted them — this bounds the whole request either way. Any new per-value work on this route inherits the same bound, so keep it that way rather than adding a second one. The validator's error budget (#35) is not that second bound: it caps the *response*, not the CPU. Without it the 400 `details` array was one entry per unknown key, so a 64 KB body could draw a 500 KB reply; with it the reply is sized by the schema. The CPU spent walking the body is still bounded only by the 64 KB cap, and the budget merely lets the walk stop early once the answer is settled, the way `maxItems` and `maxLength` already do for one field.
- `fetch-timeout.ts` holds `FETCH_TIMEOUT_MS` (10s) and `isTimeoutError`. Every outbound fetch in the project — the generator's form fetch, the submitter, and Turnstile siteverify — aborts after that deadline and maps the abort onto its own module's existing error class, so a hanging upstream still surfaces as 502/503 rather than an unhandled 500. Add the signal to any new outbound fetch.
- `scripts/gemini.ts` makes build-time Gemini calls for field metadata and is never imported by the Worker.

ESM throughout: relative imports use `.js` extensions even in `.ts` files.

Tests live in `src/lib/__tests__/` and `scripts/__tests__/` (vitest with its default config, so any `*.test.ts` is picked up). Design specs and implementation plans for past features are in `docs/superpowers/`.

## Non-code artifacts

Anything a task produces that is not code (design docs, specs, plans, research notes, assessments) must end up on GitHub, not just on disk.

- Write non-code artifacts in English by default.
- Post the artifact as a comment on the relevant issue. If the work has no issue yet, create one first; if the artifact is about changes already under review, post it to the PR instead.
- Post the full content, not a summary or a file path. Several child repos keep planning notes in gitignored local directories (for example `__ref__/plan/` in `ltbase.api`, see #497); a local working copy is fine, but it is invisible to everyone else and does not survive the branch.
- Do not force-add gitignored planning files to make them shareable. The issue comment is the sharing mechanism.
- Say in the comment which artifact it is and where the working copy lives, so a later reader knows whether they are looking at a plan, a spec, or a review.
- Anything that must become a durable repository convention still belongs in that repo's `docs/` (an ADR, runbook, or reference page). The issue comment records the thinking; `docs/` records the decision.

## PR rules

- Do not merge a PR unless I explicitly ask you to.
- When reviewing a PR, post everything (findings, spec and standards checks, assessment, observations, verification, summary) as one comment on the PR.
- When I ask you to merge a PR, squash-merge by default unless I ask for something else.
- After a PR is merged, clean up local branches and worktrees, fast-forward main, then update and close related issues.

## Git conventions

Never include AI attribution in commit messages, PR titles, or PR descriptions, in any form. That means no

- `Co-Authored-By: Claude`
- `Generated with ...` footers
- sign-offs or footers naming an LLM or AI agent (OpenAI, GPT, Claude, Anthropic, and the like)

When squash-merging, write a clean commit message that describes only the change itself.
