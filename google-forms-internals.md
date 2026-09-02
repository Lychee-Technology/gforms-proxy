# Inside Google Forms data

This note documents the parts of the Google Forms HTML that `scripts/gen-field-mapping.ts` relies on: the `FB_PUBLIC_LOAD_DATA_` payload, question nodes, type codes, options layout, and validation payloads. The format is reverse engineered from the script, not from any Google documentation.

## Locating the form payload
- The public form HTML contains a `<script>` with a global array: `var FB_PUBLIC_LOAD_DATA_ = [...]`.
- The script parses it with `JSON.parse(match[1])` and reads questions from `data[1][1]`, which is an array of question entries.

## Question entry shape (as used in the script)
For each item in `data[1][1]`:
- `field[1]`: label (question title), string.
- `field[2]`: help text/description, string or undefined.
- `field[3]`: type code (number), see mapping below.
- `field[4]`: `entryData` array containing IDs, options, required flag, and validation.

### `entryData` layout
`entryData[0]` is the main tuple:
- `[0]`: entry ID number (combined as `entry.<id>` in output). The parser accepts a finite number or a non-empty string here and in grid row tuples; a tuple with any other value fails generation, while an element with no `field[4]` at all (title/description block) is skipped.
- `[1]`: options array (varies by type). Each option can be:
  - a plain string,
  - an array where the first element is the option string,
  - an array of arrays where the first inner string is the option text,
  - or an object with an `option` string.
- `[2]`: required flag (truthy = required).
- `[3]` or `[4]`: validation payload (see below). The script checks `[3]` first, then `[4]`.

## Question type codes
Mapped in `QUESTION_TYPE_MAP`:
- `0` short_answer
- `1` paragraph
- `2` multiple_choice
- `3` checkboxes (Google's code 3 is actually dropdown; the map has 3 and 4 swapped, see #39)
- `4` dropdown (actually checkboxes, see #39)
- `5` linear_scale
- `6` title/description block — carries no entry, so the parser skips it; not in the map
- `7` multiple_choice_grid, refined to `checkbox_grid` by a per-entry flag (see below)
- `9` date, refined to `date_time` / `date_without_year` by per-entry flags
- `10` time, refined to `duration` by a per-entry flag
- `18` rating
- unknown/default: `unknown`

Source for the codes and flag positions: `python-gforms` (`gforms/elements_base.py`), cross-checked against the live payloads of the registered forms.

## Grid, date and time entries

A grid question (type code `7`) has one tuple per row in `field[4]`:

    [rowEntryId, columns, required, [rowLabel], null, null, null, null, null, null, null, [multichoice]]

- `[0]`: that row's entry ID — each row is submitted as its own `entry.<rowEntryId>` parameter.
- `[1]`: the columns, in the usual options layout (same for every row).
- `[2]`: required flag (same for every row).
- `[3][0]`: the row label.
- `[11][0]`: `1` for a checkbox grid (several columns per row, entry ID repeated per column), `0` for a multiple-choice grid.

A date question (code `9`) has `entryData[0][7] = [includesTime, includesYear]`. It is submitted as `entry.X_year`, `entry.X_month`, `entry.X_day` (plus `_hour` / `_minute` when it includes a time). The proxy supports only year-and-no-time dates; the other variants are refused by `scripts/field-support.ts` as `date_time` / `date_without_year` (ADR 0008).

A time question (code `10`) has `entryData[0][6] = [isDuration]`. It is submitted as `entry.X_hour`, `entry.X_minute` (plus `_second` for a duration). Durations are refused as `duration`.

## Validation payload format
`extractValidation` expects `entryData[0][3]` (fallback `[4]`) to be an array whose first item is `data`, also an array. Structure:
- `data[0]`: validation type code (mapped by `ValidationTypeMap`).
- `data[1]`: operator code (meaning depends on validation type).
- `data[2]`: values array (number or string, depending on operator).
- `data[3]`: optional custom error message (string).

### Validation type codes (`ValidationTypeMap`)
- `1` → `number`
- `2` → `text`
- `6` → `length`
- `4` → `regular_expression`

### Number validation operators (`numberValidationTypes`)
Code → operator:
- `1` `>`
- `2` `>=`
- `3` `<`
- `4` `<=`
- `5` `=`
- `6` `!=`
- `7` `between` (expects two values)
- `8` `not_between` (expects two values)
- `9` `is_number`
- `10` `is_whole_number`

Values:
- `between` / `not_between`: `data[2][0]` and `data[2][1]`.
- Other comparisons: `data[2][0]`.

### Text validation operators (`textValidationTypes`)
Code → operator:
- `102` `email` (semantic format check)
- `103` `url` (semantic format check)
- `100` `contains` (uses `data[2][0]` as substring)
- `101` `does_not_contain` (uses `data[2][0]` as substring)

### Length validation operators (`lengthValidationTypes`)
Code → operator:
- `203` `min` (uses `data[2][0]` as minimum length)
- `202` `max` (uses `data[2][0]` as maximum length)

### Regular expression operators (`regexValidationTypes`)
Code → operator:
- `301` `matches` (pattern in `data[2][0]`)
- `302` `does_not_match` (pattern in `data[2][0]`)
- `299` `contains` (pattern in `data[2][0]`)
- `300` `does_not_contain` (pattern in `data[2][0]`)

## How the script uses validation in JSON Schema
- Number rules map to `minimum` / `exclusiveMinimum` / `maximum` / `exclusiveMaximum` / `const` / `not` / `anyOf` and may force `type` to `number` or `integer` (`is_whole_number`).
- Length rules map to `minLength` / `maxLength` on string schemas.
- Text rules map to `format: email | uri` or to substring regexes via `pattern` / `not`.
- Regex rules map directly to `pattern` or `not: { pattern }`.
- Multiple patterns are combined under `allOf` to avoid overwriting existing `pattern`.
- Validation is only applied when compatible with the property's current type (e.g., string-only operators won't overwrite a non-string schema).
