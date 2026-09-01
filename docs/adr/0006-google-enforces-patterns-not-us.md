# ADR 0006: Google enforces `pattern`, not us

**Status:** Accepted
**Date:** 2026-08-28
**Source:** measurements taken against a live Google Form and against the matcher built for ADR 0005; recorded on issue #21 / PR #31

## Context

ADR 0002 evaluated a Google Forms `pattern` locally when it was semantically
compatible with JavaScript and safe to run on a backtracking engine. ADR 0005
replaced that syntactic safety heuristic with a backtracking-free matcher of
our own (`src/lib/re2/`), because the heuristic refused ordinary patterns like
`^(yes|no)$` and could not be widened without deciding regex ambiguity.

Both ADRs rest on the same premise, which nobody checked: that local evaluation
is worth having because it turns a rule violation into a fast, structured 400
instead of a round trip to Google. Two measurements, both taken after the
matcher was finished, dismantle that premise.

**Google enforces regex validation server-side, and rejects with 400.**
Measured against a live form carrying a `regular_expression` rule with
alternation, `.*(vancouver|canada).*`:

| Submission | `formResponse` status |
|---|---|
| Violates only the regex rule | **400** |
| Otherwise identical, satisfies the rule | **200**, response recorded |
| Missing a required answer | **400** |
| Violates `maxLength` | **400** |

Google is not a lenient backstop that accepts whatever the proxy forwards. It
is an authoritative validator that already checks exactly the rules the local
matcher was checking. Local evaluation was a second copy of a gate that
existed, was correct, and could not be bypassed.

**The matcher costs 75 times a free Worker's entire CPU budget.** Free
Cloudflare Workers allow 10 ms of CPU per request. The matcher's measured worst
case, within the bounds ADR 0005 designed for it, is ~751 ms per request. The
bounds are real — 10,000 input code points per request, 4000 instructions, 4000
class ranges — but they bound the cost at 75x what the platform permits. No
amount of tuning inside those bounds closes a two-order-of-magnitude gap. The
feature could not run where it was meant to run.

A duplicate of an authoritative check that the platform cannot afford to
execute has no case left.

## Decision

Remove local regex evaluation entirely. `validator.ts` no longer has a
`pattern` branch, and the following are deleted with it:

- `src/lib/re2/` — the parser, compiler, matcher, and the JavaScript-source
  renderer that served as its differential-testing oracle.
- `src/lib/pattern-policy.ts` and `scripts/validate-forms.ts` — a build-time
  gate that refused to onboard a form whose regex the matcher could not
  evaluate. It policed patterns nothing evaluates any more. With the policy
  gone, `validate-forms.ts` validated nothing, so the `deploy` script is now
  plain `wrangler deploy`.
- `--allow-unevaluable-patterns` and the `unevaluablePatternsAllowed` field on
  `FormDefinition` — the escape hatch from that gate. No registered definition
  carried the field, so no data migration was needed.
- The per-request code-point budget, the matcher cache, and the warn-once
  machinery in `validator.ts`, all of which existed only to make pattern
  matching affordable and quiet.

Two consequences of the removal are load-bearing and are decisions in their own
right.

**A `not` constraint carrying a `pattern` is skipped unconditionally.**
`schema.ts` emits `{ not: { pattern } }` for the `does_not_match` and
`does_not_contain` operators, and the `allOf` loop evaluates a `not` member by
running the inner schema and inverting the result. An unevaluated `pattern`
produces no inner errors for *any* value, which inverts into rejecting *every*
value — a total outage for any form with a "does not contain" rule. The guard
that ADR 0005 applied to unevaluable patterns is now unconditional: if the
not-schema carries a `pattern`, the whole constraint is skipped. This holds
however many other keys the not-schema carries, because a rejection would
require the value to match all of them, including the one nobody evaluated.

**A 400 from `formResponse` maps to a 400, not a 502.** Rejection by Google is
now the normal path for a violated regex rule, so it must not surface as
"Failed to submit to Google Forms" with a 502. `submitter.ts` already carries
the upstream status on `SubmissionError`; the route maps 400 to a 400 naming the
form's validation rules as the cause. 413 is the caller's payload by any reading
and so becomes a 400 too, but with its own message about the size of the
submission — pointing the caller at their field values when the request was
merely too large would be a wrong turn.
Google's rejection body is a 168 KB rendered HTML page, not
a machine-readable error, so no field-level detail is extracted from it —
parsing that page would be fragile in exactly the way the rest of the parser
already is, for a message the client can get from the schema.

The rest of the 4xx range is not attributable to the payload: 403 is a
restricted form, 404 a deleted or unpublished one, 410 gone, 429 rate limited.
Answering those with the validation wording would send the caller after a fault
that is not theirs, so they stay 502 and name Google's status in the message —
it is not sensitive, and without it these cases are indistinguishable from the
outside. 5xx and network failures are unchanged. Separately, a value this proxy
itself refuses to serialize never reaches Google at all; that error is tagged
`kind: 'invalid-value'` and answered with a 400 carrying its own message, which
names the offending field.

`schema.ts` is unchanged and still emits `pattern`. `GET/POST /schema` is a
description of the form's real validation rules for API consumers, and those
rules still exist and are still enforced — by Google. We stop enforcing
`pattern`; we do not stop describing it.

> **Amended 2026-08-28 by [ADR 0007](0007-no-live-schema-extraction-at-runtime.md):** `GET/POST /schema` no longer exists. The reasoning above is unaffected — `schema.ts` still emits `pattern`, and the schema that still carries it is now served from the bundle by `GET /api/v1/forms/:formId/schema`. We still describe what we no longer enforce; only the route that does the describing changed.

Every other validator keyword stays: `type`, `required`, `enum`, `const`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`,
`maxLength`, `format`, `minItems`, `maxItems`, `uniqueItems`, `allOf`, `not`,
`anyOf`. They are microseconds of work on the shapes `schema.ts` emits and
none of the reasoning above touches them. That list is the subset as of this
ADR's date, not a running inventory of the validator: it has since learned
`format: date` and `format: time` (#17) and schema-valued
`additionalProperties` (#18), and [ADR 0002](0002-hand-rolled-json-schema-validator.md)
carries the current one. The claim that survives is the one this ADR is about
— `pattern` is the only keyword it removed. `maxLength` stays terminal for its
property: it was introduced to bound matcher input, but it is independently
correct, since an oversized string is already invalid and scanning it further
is work proportional to an attacker-chosen length.

## Consequences

- A regex violation is now reported after a round trip to Google, as a 400
  without field-level detail, where it was previously a fast local error naming
  the field and the pattern. This is the real cost of the decision. It is
  smaller than it looks: the round trip was already on the success path, and
  the schema tells a client what the rule is before it submits.
- No form can be un-onboardable because of its regex any more. The generator
  writes a definition for any pattern Google accepts, and the deploy path has
  no pattern gate to bypass or to override.
- Validation is uniformly cheap. Nothing in the validator is proportional to
  more than the request body, so the 10 ms budget is no longer in question.
- ADR 0005 is superseded and ADR 0002's pattern paragraphs are rewritten. ADR
  0005 stays in the tree as the record of what was built and why, so that this
  ADR reads as a reversal with evidence rather than as an absence.
- The verification is manual and unrepeatable in CI: it was a submission to a
  live Google Form, which is why nobody had run it. The 400/200 results above
  are the record. If Google ever stops validating server-side, submissions
  would be accepted that the form's own rules forbid — a behaviour change
  visible in the responses sheet, not in this repository.

### The lesson

This feature was escalated three times without anyone re-checking whether it
was needed. #5 restricted patterns to a backtracking-safe subset; #20 fixed the
semantic divergence that subset introduced; #21 built a matcher because the
subset was too narrow to onboard ordinary forms; and the branch that followed
bounded the matcher's cost because the matcher was unbounded. Each step fixed
the collateral damage of the previous one, and each step was a correct fix to
the problem it was given.

The problem none of them was given was whether Google already did this. The
experiment that answered it — submit a violating response to a real form, look
at the status code — takes ten minutes and was run only after roughly 3,700
lines of matcher, policy, budget and tests existed. The same is true of the
10 ms CPU limit, which is a documented number about the target platform and was
never checked against a measurement of the thing being built.

The rule worth keeping: before building a validator for a system that validates
itself, submit one bad request to that system and read the response. Before
building anything with a cost model, compare the model's own numbers against
the platform's limits.
