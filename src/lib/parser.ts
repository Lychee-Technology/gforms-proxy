import type { FieldDetail, GridRow, RawFormData } from './types.js';
import {
  FLAG_DERIVED_TYPE_LABELS,
  QUESTION_TYPE_MAP,
  ValidationTypeMap,
  numberValidationTypes,
  textValidationTypes,
  lengthValidationTypes,
  regexValidationTypes,
} from './types.js';
import type { ValidationInfo } from './types.js';
import { FETCH_TIMEOUT_MS, isTimeoutError } from './fetch-timeout.js';

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

// Build-time only: this runs in the CLI generator, never in the Worker
// (ADR 0007), so the timeout bounds a generation run rather than a request.
export async function fetchFormHtml(url: string): Promise<string> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; gforms-proxy/1.0)',
        Accept: 'text/html',
      },
      signal,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new FormFetchError(`Timed out after ${FETCH_TIMEOUT_MS}ms fetching the form`);
    }
    throw new FormFetchError('Network error: could not reach Google Forms');
  }
  if (!response.ok) {
    throw new FormFetchError(`Failed to fetch form: HTTP ${response.status}`, response.status);
  }
  // The deadline stays live through the body read, so an abort can land after
  // the headers arrive. Without this catch it would escape as a raw
  // DOMException — the one failure here that is not a FormFetchError.
  try {
    return await response.text();
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new FormFetchError(
        `Timed out after ${FETCH_TIMEOUT_MS}ms reading the form response body`,
      );
    }
    throw new FormFetchError('Network error: could not read the form response body');
  }
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

const GRID_TYPE_CODE = 7;
const DATE_TYPE_CODE = 9;
const TIME_TYPE_CODE = 10;

function getQuestionTypeLabel(code?: number): string {
  if (typeof code !== 'number') return 'unknown';
  return QUESTION_TYPE_MAP[code] ?? 'unknown';
}

// Reads flag `flagIndex` of the flag array at `tupleIndex` of the first
// entry tuple. Google emits the flags as the numbers 0 and 1; anything else
// (absent array, absent flag, a string or object) is undefined, so callers
// fall back to Google's default for that question rather than reading a
// malformed value as "on".
function readFlag(entryData: unknown, tupleIndex: number, flagIndex: number): boolean | undefined {
  const flags = (entryData as any)?.[0]?.[tupleIndex];
  if (!Array.isArray(flags)) return undefined;
  const value = flags[flagIndex];
  return typeof value === 'number' ? value !== 0 : undefined;
}

// Grid, date and time questions carry variants that the type code alone does
// not distinguish; the flags do (google-forms-internals.md).
function resolveTypeLabel(typeCode: number | undefined, entryData: unknown): string {
  const base = getQuestionTypeLabel(typeCode);
  switch (typeCode) {
    case GRID_TYPE_CODE:
      return readFlag(entryData, 11, 0) ? FLAG_DERIVED_TYPE_LABELS.checkboxGrid : base;
    case DATE_TYPE_CODE:
      if (readFlag(entryData, 7, 0)) return FLAG_DERIVED_TYPE_LABELS.dateTime;
      if (readFlag(entryData, 7, 1) === false) return FLAG_DERIVED_TYPE_LABELS.dateWithoutYear;
      return base;
    case TIME_TYPE_CODE:
      return readFlag(entryData, 6, 0) ? FLAG_DERIVED_TYPE_LABELS.duration : base;
    default:
      return base;
  }
}

// A grid's field[4] holds one tuple per row: [rowEntryId, columns, required,
// [rowLabel], ...]. Every row needs its own entry ID at submission time, so a
// row without one fails the whole generation run rather than being dropped —
// a definition missing a row would silently never submit that row's answer.
function extractGridRows(label: string, entryData: unknown): GridRow[] {
  if (!Array.isArray(entryData)) return [];
  return entryData.map((tuple: unknown, idx: number): GridRow => {
    const id = (tuple as any)?.[0];
    const validId =
      (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id !== '');
    if (!validId) {
      throw new FormParseError(
        `Grid question "${label}" row ${idx + 1} has no entry ID (unexpected form structure)`,
      );
    }
    const rawLabel = (tuple as any)?.[3]?.[0];
    return {
      label: typeof rawLabel === 'string' && rawLabel !== '' ? rawLabel : `Row ${idx + 1}`,
      entryId: `entry.${String(id)}`,
    };
  });
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
        typeLabel: resolveTypeLabel(typeCode, entryData),
        options: extractOptions(entryData),
        required: isRequired(entryData),
        validation: extractValidation(entryData),
        helpText: typeof (field as any)?.[2] === 'string' ? (field as any)[2] : undefined,
        ...(typeCode === GRID_TYPE_CODE ? { rows: extractGridRows(label, entryData) } : {}),
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
