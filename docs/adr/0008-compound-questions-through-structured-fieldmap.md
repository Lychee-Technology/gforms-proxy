# ADR 0008: Compound questions map through structured fieldMap entries

**Status:** Accepted
**Date:** 2026-09-01
**Source:** design spec "Grid, Date and Time Support" (2026-09-01), posted on issue #23; working copy in `docs/superpowers/specs/`

## Context

Google Forms submits a grid as one `entry.<rowId>` parameter per row, a date
as `entry.X_year` / `entry.X_month` / `entry.X_day`, and a time as
`entry.X_hour` / `entry.X_minute`. ADR 0003's `fieldMap` mapped one schema key
to one entry ID, so none of these could be submitted; #6 made the generator
refuse them and the submitter reject object values rather than send
`[object Object]`.

The layout and the wire format were verified against `python-gforms`
(`gforms/elements_base.py`, exercised against live forms) and the live
payloads of the registered forms. A grid (type code 7) carries one entry
tuple per row with the row label at index 3 and a checkbox flag at index 11; a
date (code 9) carries `[includesTime, includesYear]` at index 7; a time (code
10) carries `[isDuration]` at index 6. `google-forms-internals.md` has the
details.

## Decision

A `fieldMap` value is a `FieldMapping`: the original string, or
`{ kind: 'date' | 'time', entryId }`, or `{ kind: 'grid', rows }` where
`rows` maps a row key to that row's entry ID. The mapping carries the kind
because the submitter cannot infer it from the value: a short-answer string
`"2026-01-05"` goes out verbatim, a date must be split.

A grid property schema names its rows under `properties`, marks them all
`required` when the question is, and closes the object with
`additionalProperties: false`, so `GET /schema` tells a consumer exactly what
to send and an unknown row is a 400 rather than a silent drop. Row keys are
`normalizeKey(rowLabel, 'row_N')`, deduplicated inside the grid, derived by
one helper (`resolveRowKeys`) shared by the schema and the fieldMap. A
checkbox grid gives each row the checkboxes shape (array, `uniqueItems`,
`maxItems`).

The submitter encodes dates and times as plain integers (`2026`, `1`, `5`),
which is what Google's own client sends.

Three variants have no representation in the format vocabulary and stay
refused at generation time under their own labels: `date_time`,
`date_without_year`, `duration`. `format: date` and `format: time` (ADR 0002)
have no component for the extra or missing parts, and adding formats for them
is a separate decision.

## Consequences

- Grid, date and time questions work end-to-end; `UNSUPPORTED_TYPE_LABELS`
  shrinks to the three variants above.
- The validator handles `properties`, `required` and `additionalProperties:
  false` below the root (ADR 0002 amended). Depth still follows the schema:
  one level for a grid.
- Existing definitions are unaffected: a string mapping means what it always
  did, and both bundled definitions carry only strings.
- Row keys are mechanical, not Gemini-generated; a row label with no ASCII
  becomes `row_N`.
- Not yet verified against a live grid form; the encodings follow
  `python-gforms`, which is. A smoke test against a throwaway form is the
  follow-up before relying on this in production.
