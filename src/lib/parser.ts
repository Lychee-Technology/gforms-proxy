import type { FieldDetail, RawFormData } from './types.js';
import {
  QUESTION_TYPE_MAP,
  ValidationTypeMap,
  numberValidationTypes,
  textValidationTypes,
  lengthValidationTypes,
  regexValidationTypes,
} from './types.js';
import type { ValidationInfo } from './types.js';

export class FormFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'FormFetchError';
  }
}

export class FormParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormParseError';
  }
}

// Anchored at both ends: nothing may follow `viewform` except a query string or
// a fragment. An unanchored tail let path-traversal URLs through — `fetch`
// collapses the dot segments, so the URL that passed validation and the URL
// actually fetched could name different paths (or a different form than
// `extractFormId` reports). See issue #8.
const GOOGLE_FORMS_REGEX =
  /^https:\/\/docs\.google\.com\/forms\/d\/e\/[a-zA-Z0-9_-]+\/viewform(?:[?#]\S*)?$/;

export function validateFormUrl(url: string): void {
  if (!GOOGLE_FORMS_REGEX.test(url)) {
    throw new FormParseError(
      'Invalid Google Forms URL. Expected: https://docs.google.com/forms/d/e/<id>/viewform',
    );
  }
}

export async function fetchFormHtml(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; gforms-proxy/1.0)',
        Accept: 'text/html',
      },
    });
  } catch (err) {
    throw new FormFetchError('Network error: could not reach Google Forms');
  }
  if (!response.ok) {
    throw new FormFetchError(`Failed to fetch form: HTTP ${response.status}`, response.status);
  }
  return response.text();
}

export function extractFormTitle(html: string): string {
  const match = html.match(/<title>([^<]+)<\/title>/i);
  if (!match?.[1]) return 'Google Form';
  return match[1].replace(/\s*-\s*Google Forms\s*$/i, '').trim();
}

export function extractFormId(url: string): string {
  const match = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)\//);
  return match?.[1] ?? '';
}

function getQuestionTypeLabel(code?: number): string {
  if (typeof code !== 'number') return 'unknown';
  return QUESTION_TYPE_MAP[code] ?? 'unknown';
}

function extractOptions(entryData: unknown): string[] {
  const options = (entryData as any)?.[0]?.[1];
  if (!Array.isArray(options)) return [];
  return options
    .map((opt: unknown) => {
      if (typeof opt === 'string') return opt;
      if (Array.isArray(opt)) {
        if (typeof opt[0] === 'string') return opt[0] as string;
        if (Array.isArray(opt[0]) && typeof opt[0][0] === 'string') return opt[0][0] as string;
      }
      if (opt && typeof (opt as any).option === 'string') return (opt as any).option as string;
      return null;
    })
    .filter((v): v is string => v !== null);
}

function extractValidation(entryData: unknown): ValidationInfo | null {
  const rawData = (entryData as any)?.[0]?.[3] ?? (entryData as any)?.[0]?.[4] ?? null;
  if (!Array.isArray(rawData)) return null;
  const data = rawData[0];
  if (!Array.isArray(data)) return null;

  const typeCode = data[0] as number;
  const typeLabel = ValidationTypeMap[typeCode];
  if (!typeLabel) return null;

  let operator = '';
  const values: string[] = [];

  switch (typeLabel) {
    case 'number': {
      operator = numberValidationTypes[data[1] as number] ?? '';
      if (!operator) return null;
      const params = data[2] as unknown[];
      if (operator === 'between' || operator === 'not_between') {
        if (!Array.isArray(params) || params.length < 2) return null;
        values.push(String(params[0]), String(params[1]));
      } else if (operator !== 'is_number' && operator !== 'is_whole_number') {
        if (!Array.isArray(params) || params.length < 1) return null;
        values.push(String(params[0]));
      }
      break;
    }
    case 'text': {
      operator = textValidationTypes[data[1] as number] ?? '';
      if (!operator) return null;
      if (operator === 'contains' || operator === 'does_not_contain') {
        const params = data[2] as unknown[];
        if (!Array.isArray(params) || params.length === 0) return null;
        values.push(String(params[0]));
      }
      break;
    }
    case 'length': {
      operator = lengthValidationTypes[data[1] as number] ?? '';
      if (!operator) return null;
      const params = data[2] as unknown[];
      if (!Array.isArray(params) || params.length === 0) return null;
      values.push(String(params[0]));
      break;
    }
    case 'regular_expression': {
      operator = regexValidationTypes[data[1] as number] ?? '';
      if (!operator) return null;
      const params = data[2] as unknown[];
      if (!Array.isArray(params) || params.length === 0) return null;
      values.push(String(params[0]));
      break;
    }
    default:
      return null;
  }

  return {
    type: typeLabel,
    operator,
    values,
    customErrorMessage: typeof data[3] === 'string' ? data[3] : undefined,
  };
}

function isRequired(entryData: unknown): boolean {
  return Boolean((entryData as any)?.[0]?.[2]);
}

export function parseFormHtml(html: string, url: string): RawFormData {
  const formTitle = extractFormTitle(html);
  const formId = extractFormId(url);

  // s flag (dotAll) supports multiline JSON payloads
  const regex = /var FB_PUBLIC_LOAD_DATA_ = (\[.+?\]);\s*<\/script>/s;
  const match = html.match(regex);
  if (!match?.[1]) {
    throw new FormParseError(
      'Could not locate FB_PUBLIC_LOAD_DATA_ in the page. Verify the form is public and the URL is correct.',
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new FormParseError('FB_PUBLIC_LOAD_DATA_ JSON is malformed.');
  }

  const formFields = (data as any)?.[1]?.[1] as unknown[] | undefined;
  if (!Array.isArray(formFields) || formFields.length === 0) {
    throw new FormParseError('No fields found in form data.');
  }

  const fields: FieldDetail[] = [];
  for (const field of formFields) {
    const label = (field as any)?.[1] as string | undefined;
    const entryData = (field as any)?.[4];
    const typeCode =
      typeof (field as any)?.[3] === 'number' ? ((field as any)[3] as number) : undefined;
    const entryIdValue = (entryData as any)?.[0]?.[0];

    if (label && entryIdValue !== undefined) {
      fields.push({
        label,
        entryId: `entry.${String(entryIdValue)}`,
        typeCode,
        typeLabel: getQuestionTypeLabel(typeCode),
        options: extractOptions(entryData),
        required: isRequired(entryData),
        validation: extractValidation(entryData),
        helpText: typeof (field as any)?.[2] === 'string' ? (field as any)[2] : undefined,
      });
    } else if (label && entryIdValue === undefined) {
      console.warn(`[gforms-proxy] Skipped field "${label}" — no entry ID found (unexpected form structure)`);
    }
  }

  return { formTitle, formId, fields };
}

export async function fetchAndParseForm(url: string): Promise<RawFormData> {
  validateFormUrl(url);
  const html = await fetchFormHtml(url);
  return parseFormHtml(html, url);
}
