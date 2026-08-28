# AGENTS.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Commands

```bash
pnpm test                                  # run all tests (vitest run)
pnpm vitest run src/lib/__tests__/schema.test.ts   # run a single test file
pnpm test:watch                            # vitest watch mode
pnpm typecheck                             # typecheck src (Workers types) and scripts (node types)
pnpm validate:forms                        # validate registered form definitions
pnpm dev                                   # wrangler dev (local Worker)
pnpm run deploy                            # validate registered forms, then run Wrangler deploy
pnpm cf-types                              # regenerate Cloudflare binding types
```

Use `pnpm run deploy`, not `pnpm deploy`, so the project deploy script validates every registered form before invoking Wrangler.

Generate a form definition (writes `src/forms/<formId>.json`):

```bash
pnpm exec tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>] [--turnstile] [--force] [--allow-unevaluable-patterns]
```

`--gemini-key` (or the `GEMINI_API_KEY` env var) enables Gemini-generated field keys and translations; without it, `buildFieldsMeta` falls back to mechanical `field_N` keys. `--turnstile` marks the form as Turnstile-protected. Regenerating a form whose existing JSON has `turnstileEnabled: true` without `--turnstile` aborts (the guard lives in `scripts/turnstile-guard.ts`); pass `--force` to strip protection intentionally.

`--allow-unevaluable-patterns` records `unevaluablePatternsAllowed: true` in the definition, which downgrades the pattern gate from an error to a warning for both the generator and `pnpm validate:forms`. Use it only when a form's regex is outside the supported RE2 subset and cannot be simplified: the affected field is then checked by Google alone.

## Architecture

A Cloudflare Worker (Hono app, entry `src/index.ts` per `wrangler.toml`) that fronts Google Forms. It does two things:

1. Live schema extraction: `GET/POST /schema` fetches any public Google Form, parses it, and returns a JSON Schema (Draft 2020-12). This path is stateless; nothing is registered.
2. Submission proxy: `POST /api/v1/forms/:formId/responses` accepts JSON for pre-registered forms only, validates it against the stored schema, optionally verifies a Cloudflare Turnstile token, then posts urlencoded data to Google's `formResponse` endpoint.

An offline generation step connects the two: `scripts/gen-field-mapping.ts` fetches a form, builds its `FormDefinition` (the schema plus a `fieldMap` from schema keys to `entry.XXXXXXX` IDs), and writes `src/forms/<formId>.json`. Registration is manual: add a JSON import (`with { type: 'json' }`) and a Map entry in `src/forms/registry.ts`, then deploy. Definitions are bundled into the Worker, not stored in KV or D1.

Data flows through `src/lib/`:

- `parser.ts` fetches the form HTML and extracts the `FB_PUBLIC_LOAD_DATA_` embedded array (question labels, type codes, options, required flags, validation rules). The reverse-engineered format is documented in `google-forms-internals.md`; the type-code and validation-code tables live in `types.ts`.
- `schema.ts` turns parsed data into the JSON Schema and fieldMap. Grid questions become nested objects; validation rules map to JSON Schema keywords.
- `validator.ts` is a hand-rolled validator for the JSON Schema subset that `schema.ts` emits (no ajv, so it runs fine on Workers). If `schema.ts` starts emitting a new keyword, `validator.ts` must learn it too. `pattern` checks are delegated to `re2/` and fail open: a pattern outside the supported subset is skipped with one cached warning, leaving Google as the final judge (ADR 0002).
- `re2/` parses a Google Forms (RE2) pattern into an AST and runs it on a Thompson NFA simulation — no backtracking, so execution is O(n·m) whatever the pattern's shape (ADR 0005). `re2/to-js-source.ts` renders the same AST as JavaScript RegExp source and exists only as the differential-testing oracle; nothing in the Worker imports it.
- `pattern-policy.ts` walks a schema for patterns `re2/` cannot evaluate. Build-time only (nothing in the Worker imports it); it lives in `src/lib/` because it depends on `re2/`.
- `submitter.ts` and `turnstile.ts` handle runtime submission and Turnstile siteverify. Turnstile applies only to definitions with `turnstileEnabled: true`; those schemas also require a `turnstile_token` property (spliced in by the generator), and the Worker needs the `TURNSTILE_SECRET_KEY` secret.
- `scripts/gemini.ts` makes build-time Gemini calls for field metadata and is never imported by the Worker.
- `scripts/validate-forms.ts` runs `pattern-policy.ts` over every definition in `src/forms/registry.ts`, honoring each definition's `unevaluablePatternsAllowed`; the generator refuses to write an undeployable definition unless `--allow-unevaluable-patterns` is passed, and `pnpm run deploy` runs this check before Wrangler.

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
