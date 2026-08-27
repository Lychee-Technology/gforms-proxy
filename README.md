# Google Forms Proxy

A proxy service that transforms Google Forms into structured JSON Schema APIs, enabling programmatic form access and AI-powered form filling.

## Use cases

### Website for small business

For 99% of small businesses, websites can easily run on Cloudflare Pages. However, they almost always need some type of forms for customer interaction. Paying extra for form hosting doesn't make sense when Google Forms is so powerful and easy to use. However, embedding Google Forms directly makes the website feel cheap.

This project solves that by:
- Fetching Google Forms HTML and extracting the form structure
- Converting form fields into a JSON Schema for programmatic access
- Providing a clean API layer that hides the Google Forms embedding

### Use AI to fill the forms

This project can be combined with AI to automatically fill Google Forms:

- **Form Schema Extraction**: Parse Google Forms HTML to extract questions, types, options, and validation rules
- **JSON Schema Generation**: Convert form structure into a formal JSON Schema (Draft 2020-12)
- **AI Integration**: Use Gemini or other LLMs to:
  - Translate form questions to English
  - Generate concise metadata (titles, keys, translations)
  - Map form fields to structured data
- **Programmatic Submission**: Use the schema to validate and format data before submission

## How it works

The project extracts form structure from Google Forms HTML:

1. **Fetches the form HTML** and locates the `FB_PUBLIC_LOAD_DATA_` global variable
2. **Parses question entries** from the embedded data structure
3. **Extracts field metadata** including:
   - Question labels and help text
   - Field types (short answer, paragraph, multiple choice, checkboxes, dropdown, linear scale, date, time, grids)
   - Options for choice-based questions
   - Required flags
   - Validation rules (number ranges, text patterns, length limits, regex)
4. **Generates JSON Schema** with:
   - Proper types and constraints
   - Validation rules mapped to JSON Schema keywords
   - Required field declarations
   - Form metadata (title, description, ID)

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

`--gemini-key` (or the `GEMINI_API_KEY` env var) enables Gemini-generated field keys and translations; without it, field keys fall back to mechanical `field_N` names. `--turnstile` marks the form as Turnstile-protected; regenerating a Turnstile-protected form without that flag aborts unless you pass `--force`.

To let the Worker accept submissions for the form, register it: add a JSON import and a `Map` entry in `src/forms/registry.ts`, then deploy (see `docs/adr/0001-static-bundled-form-registry.md`).

### API

`GET /schema?url=<viewform_url>` (or `POST /schema` with body `{ "url": "..." }`) fetches any public Google Form and returns its JSON Schema (Draft 2020-12). This path is stateless — no registration needed.

`POST /api/v1/forms/:formId/responses` accepts a JSON body for a pre-registered form, validates it against the stored schema, verifies Turnstile when the definition requires it, and forwards the data to Google's `formResponse` endpoint. Responses:

- `200` — `{ "success": true }`, submitted to Google
- `400` — `{ "error": "Validation failed", "details": [{ "field": "...", "message": "..." }] }` for schema violations; also returned for an invalid JSON body or a failed Turnstile check
- `404` — unknown `formId`
- `502` — Google rejected the submission

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

- `scripts/gen-field-mapping.ts` - Main script for parsing Google Forms and generating JSON Schema
- `google-forms-internals.md` - Detailed documentation of Google Forms HTML structure and parsing logic 