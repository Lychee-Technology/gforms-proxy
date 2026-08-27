# Google Forms Proxy

A Cloudflare Worker that puts a JSON Schema API in front of Google Forms, so programs and LLMs can read a form's structure and submit responses without ever touching Google's UI.

## Use cases

### Website for small business

For 99% of small businesses, a website can run on Cloudflare Pages, but it almost always needs a form for customer interaction. Paying for form hosting is hard to justify when Google Forms already does the job, and embedding a Google Form directly makes the site feel cheap.

This proxy fetches the form's HTML, extracts its structure, converts the fields into a JSON Schema, and puts a clean API in front, so the website never embeds Google Forms at all.

### Use AI to fill the forms

The same schema makes forms fillable by AI. The proxy parses a form's HTML into questions, types, options, and validation rules, and expresses them as a JSON Schema (Draft 2020-12). An LLM such as Gemini can then translate the questions to English, generate concise metadata (titles, keys, translations), and map user data onto the form's fields; the schema validates the result before anything is submitted.

## How it works

The proxy fetches the form's HTML and locates the `FB_PUBLIC_LOAD_DATA_` global variable, then parses the question entries embedded in it. For each question it extracts the label and help text, the field type (short answer, paragraph, multiple choice, checkboxes, dropdown, linear scale, date, time, grids), the options for choice-based questions, the required flag, and any validation rules (number ranges, text patterns, length limits, regex).

From that it generates a JSON Schema: types and constraints per field, validation rules mapped to JSON Schema keywords, required field declarations, and the form's metadata (title, description, ID).

## Supported question types

| Type Code | Type | JSON Schema Type |
|-----------|------|------------------|
| 0 | short_answer | string |
| 1 | paragraph | string |
| 2 | multiple_choice | string (enum) |
| 3 | checkboxes | array of strings (enum) |
| 4 | dropdown | string (enum) |
| 5 | linear_scale | integer (range) |
| 6 | grid | object |
| 7 | multiple_choice_grid | object |
| 8 | date | string (date format) |
| 9 | time | string (time format) |
| 18 | rating | integer |

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

To let the Worker accept submissions for the form, register it: add a JSON import and a `Map` entry in `src/forms/registry.ts`, then deploy (see `docs/adr/0001-static-bundled-form-registry.md`).

### API

`GET /schema?url=<viewform_url>` (or `POST /schema` with body `{ "url": "..." }`) fetches any public Google Form and returns its JSON Schema (Draft 2020-12). This path is stateless and needs no registration.

`POST /api/v1/forms/:formId/responses` accepts a JSON body for a pre-registered form, validates it against the stored schema, verifies Turnstile when the definition requires it, and forwards the data to Google's `formResponse` endpoint. Responses:

- `200`: `{ "success": true }` once Google accepts the submission
- `400`: `{ "error": "Validation failed", "details": [{ "field": "...", "message": "..." }] }` when the body violates the schema; an invalid JSON body or a failed Turnstile check also gets a 400
- `404`: the `formId` is not registered
- `502`: Google rejected the submission

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
