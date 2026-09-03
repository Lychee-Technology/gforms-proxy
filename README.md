# Google Forms Proxy

A Cloudflare Worker that puts a JSON Schema API in front of Google Forms, so programs and LLMs can read a form's structure and submit responses without ever touching Google's UI.

## Use cases

### Website for small business

For 99% of small businesses, a website can run on Cloudflare Pages, but it almost always needs a form for customer interaction. Paying for form hosting is hard to justify when Google Forms already does the job, and embedding a Google Form directly makes the site feel cheap.

A one-off generation step reads the form's HTML, extracts its structure, and converts the fields into a JSON Schema, which is bundled into the Worker. The site then reads that schema and posts answers back through a clean JSON API, and never embeds Google Forms at all.

### Use AI to fill the forms

The same schema makes forms fillable by AI. The generator parses a form's HTML into questions, types, options, and validation rules, and expresses them as a JSON Schema (Draft 2020-12). An LLM such as Gemini can then translate the questions to English, generate concise metadata (titles, keys, translations), and map user data onto the form's fields; the schema validates the result before anything is submitted.

## How it works

Parsing happens offline, in the generator — the Worker itself never fetches a Google Form (see `docs/adr/0007-no-live-schema-extraction-at-runtime.md`). The generator fetches the form's HTML and locates the `FB_PUBLIC_LOAD_DATA_` global variable, then parses the question entries embedded in it. For each question it extracts the label and help text, the field type (short answer, paragraph, multiple choice, checkboxes, dropdown, linear scale, date, time, grids), the options for choice-based questions, the required flag, and any validation rules (number ranges, text patterns, length limits, regex).

From that it generates a JSON Schema: types and constraints per field, validation rules mapped to JSON Schema keywords, required field declarations, and the form's metadata (title, description, ID). That schema, plus a `fieldMap` from schema keys to Google entry IDs, is what the Worker serves and validates against.

## Supported question types

| Type Code | Type | JSON Schema Type |
|-----------|------|------------------|
| 0 | short_answer | string |
| 1 | paragraph | string |
| 2 | multiple_choice | string (enum) |
| 3 | dropdown | string (enum) |
| 4 | checkboxes | array of strings (enum) |
| 5 | linear_scale | integer (range) |
| 7 | multiple_choice_grid | object, one string (enum) property per row |
| 7 | checkbox_grid | object, one array of strings (enum) property per row |
| 9 | date | string (date format) |
| 10 | time | string (time format) |
| 18 | rating | string (not yet mapped to integer, see #43) |

Both grid variants share code 7; a per-row flag in the entry tuple tells them apart (see `google-forms-internals.md`). Code 6 is a title/description block with no entry and is skipped.

## Validation rules supported

### Number validation
- `>` / `>=` / `<` / `<=` / `=` / `!=`
- `between` / `not_between`
- `is_number` / `is_whole_number`

### Text validation
- `email` format
- `url` format
- `contains` / `does_not_contain` substring

### Length validation
- `min` / `max` length

### Regex validation
- `matches` / `does_not_match`
- `contains` / `does_not_contain`

## Usage

### Generate and register a form definition

Generate a form definition (writes `src/forms/<formId>.json`):

```bash
pnpm exec tsx scripts/gen-field-mapping.ts --url <viewform_url> [--gemini-key <key>] [--turnstile] [--force]
```

`--gemini-key` (or the `GEMINI_API_KEY` env var) enables Gemini-generated field keys and translations; without it, field keys fall back to mechanical `field_N` names. `--turnstile` marks the form as Turnstile-protected. If you regenerate a Turnstile-protected form without that flag, the script aborts unless you pass `--force`.

If the generated schema carries any regex validation, the script prints a note saying how many fields it affects: Google enforces those rules at submission time, not this proxy, so a violating value comes back as a 400 from the submission endpoint instead of being caught locally.

To let the Worker accept submissions for the form, register it: add a JSON import and a `Map` entry in `src/forms/registry.ts`, then deploy (see `docs/adr/0001-static-bundled-form-registry.md`).

### API

The Worker serves registered forms only. It has two routes; anything else answers `404` with `{ "error": "Not found" }`. CORS preflights are the one exception: `OPTIONS` is answered by the CORS middleware before routing and returns `204` on any path, since a route-aware preflight would reveal whether a `formId` is registered. The real request that follows still gets the 404.

`GET /api/v1/forms/:formId/schema` returns the registered form's JSON Schema (Draft 2020-12) straight from the bundle, making no request to Google. Responses:

- `200`: the JSON Schema object itself. For a Turnstile-protected form the schema includes a required `turnstile_token` property — it describes the body you POST to this proxy, not the Google Form
- `404`: the `formId` is not registered

`POST /api/v1/forms/:formId/responses` accepts a JSON body for a pre-registered form, validates it against the stored schema, verifies Turnstile when the definition requires it, and forwards the data to Google's `formResponse` endpoint. The body is capped at 64 KB — far above any plausible form response, and low enough that no caller can size the work the Worker does inside its CPU budget. Responses:

- `200`: `{ "success": true }` once Google accepts the submission
- `400`: `{ "error": "Validation failed", "details": [{ "field": "...", "message": "..." }] }` when the body violates the schema. `details` holds at most 100 errors; when more were found it ends with one extra entry, `{ "field": "(root)", "message": "additional errors omitted" }`, and does not say how many. An invalid JSON body, a missing/non-string `turnstile_token`, or a rejected Turnstile token also gets a 400. Two more cases reach a 400 without any `details` array, carrying only `{ "error": "..." }`: a field value this proxy cannot serialize (the message names the field), and a submission Google itself rejects — Google answers `formResponse` with a rendered HTML page rather than machine-readable errors, so there is no field-level detail to pass on. A regex rule is enforced by Google, not here, so a violation arrives this way (see `docs/adr/0006-google-enforces-patterns-not-us.md`). Google answering 413 also becomes a 400, with a message about the size of the payload rather than the form's validation rules
- `404`: the `formId` is not registered
- `413`: `{ "error": "Request body too large" }` when the body exceeds 64 KB. This is the proxy's own cap and is checked before anything else, so an oversized body gets a 413 even when the `formId` is not registered. Not to be confused with the 400 above, which is Google rejecting a payload this proxy already accepted
- `502`: Google did not accept the request for a reason that is not the caller's payload — any other 4xx (the message names the upstream status; the form may be unavailable, restricted, or rate limited) — or the submission failed outright, on a Google 5xx or a network failure
- `503`: `{ "error": "Turnstile verification is temporarily unavailable" }` when Turnstile verification cannot be performed — the `TURNSTILE_SECRET_KEY` secret is not configured, or the siteverify service is unreachable or misbehaving

## Output example

The generator writes a `FormDefinition`: the form's JSON Schema plus a `fieldMap` from schema keys to Google entry IDs. Property `title` holds the question text; entry IDs appear only in `fieldMap` (see `docs/adr/0003-fieldmap-decouples-schema-keys-from-entry-ids.md`):

```json
{
  "formId": "1FAIpQLSd...",
  "submissionUrl": "https://docs.google.com/forms/d/e/1FAIpQLSd.../formResponse",
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Form Title",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "field_name": {
        "title": "Question text",
        "description": "Question text",
        "type": "string",
        "minLength": 1
      }
    },
    "required": ["field_name"]
  },
  "fieldMap": {
    "field_name": "entry.123456789"
  }
}
```

## Project structure

- `scripts/gen-field-mapping.ts` - parses a Google Form and writes its `FormDefinition`
- `google-forms-internals.md` - notes on Google Forms' HTML structure and the parsing logic
