import { FETCH_TIMEOUT_MS, isTimeoutError } from './fetch-timeout.js';
import type { FieldMapping } from './types.js';

// Where the failure came from. 'upstream' is anything Google answered or a
// network failure reaching it; 'invalid-value' is a value this proxy refused to
// serialize before any request was made. The route maps the two differently.
export type SubmissionErrorKind = 'upstream' | 'invalid-value';

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly kind: SubmissionErrorKind = 'upstream',
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

// The submitter's own view of the two formats: the validator has already
// checked them against the schema, so these only have to pull the parts out.
// A miss here means schema drift, and it is answered like every other shape
// mismatch below — 400 naming the field, nothing sent upstream.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const invalidValue = (message: string) => new SubmissionError(message, undefined, 'invalid-value');

const param = (name: string, value: string | number | boolean) =>
  `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`;

// An object where a scalar belongs would serialize as "[object Object]";
// fail loudly instead of corrupting the submission (#6).
function assertScalar(key: string, value: unknown): asserts value is string | number | boolean {
  if (typeof value === 'object' && value !== null) {
    throw invalidValue(
      `Field "${key}" has an object value, which cannot be submitted to Google Forms`,
    );
  }
}

// Arrays repeat the entry ID once per item (checkboxes, checkbox-grid rows).
function pushScalars(parts: string[], key: string, entryId: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertScalar(key, item);
      parts.push(param(entryId, item));
    }
  } else {
    assertScalar(key, value);
    parts.push(param(entryId, value));
  }
}

// entry.X_year / _month / _day as plain integers — the encoding Google's own
// client and python-gforms send; "01" and "1" are both accepted, so the
// shorter form is used.
function pushDate(parts: string[], key: string, entryId: string, value: unknown): void {
  const match = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!match) throw invalidValue(`Field "${key}" must be a date in YYYY-MM-DD form`);
  parts.push(
    param(`${entryId}_year`, Number(match[1])),
    param(`${entryId}_month`, Number(match[2])),
    param(`${entryId}_day`, Number(match[3])),
  );
}

// entry.X_hour / _minute. There is no seconds component (ADR 0002).
function pushTime(parts: string[], key: string, entryId: string, value: unknown): void {
  const match = typeof value === 'string' ? TIME_RE.exec(value) : null;
  if (!match) throw invalidValue(`Field "${key}" must be a time in HH:MM form`);
  parts.push(
    param(`${entryId}_hour`, Number(match[1])),
    param(`${entryId}_minute`, Number(match[2])),
  );
}

// One parameter per answered row, under that row's own entry ID. Rows the
// mapping does not know are ignored, as unmapped top-level keys are; the
// validator's closed object is what turns them into a 400.
function pushGrid(
  parts: string[],
  key: string,
  rows: Record<string, string>,
  value: unknown,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidValue(`Field "${key}" must be an object with one entry per grid row`);
  }
  const cells = value as Record<string, unknown>;
  for (const [rowKey, entryId] of Object.entries(rows)) {
    // Object.hasOwn, as in the validator: a row keyed "constructor" must not
    // read Object.prototype.constructor off an empty object and send its source.
    if (!Object.hasOwn(cells, rowKey)) continue;
    const cell = cells[rowKey];
    if (cell === undefined || cell === null) continue;
    pushScalars(parts, `${key}.${rowKey}`, entryId, cell);
  }
}

export async function submitToGoogleForms(
  submissionUrl: string,
  fieldMap: Record<string, FieldMapping>,
  data: Record<string, unknown>,
): Promise<void> {
  const parts: string[] = [];

  for (const [key, mapping] of Object.entries(fieldMap)) {
    // Own keys only, for the same reason as the grid rows below.
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value === undefined || value === null) continue;

    if (typeof mapping === 'string') {
      pushScalars(parts, key, mapping, value);
    } else if (mapping.kind === 'date') {
      pushDate(parts, key, mapping.entryId, value);
    } else if (mapping.kind === 'time') {
      pushTime(parts, key, mapping.entryId, value);
    } else {
      pushGrid(parts, key, mapping.rows, value);
    }
  }

  const body = parts.join('&');

  let response: Response;
  try {
    response = await fetch(submissionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Both paths are 'upstream' with no statusCode, which is what makes the
    // route answer 502 rather than blaming the caller's payload.
    if (isTimeoutError(err)) {
      throw new SubmissionError(
        `Timed out after ${FETCH_TIMEOUT_MS}ms waiting for Google Forms`,
      );
    }
    throw new SubmissionError('Network error: could not reach Google Forms');
  }

  if (!response.ok) {
    throw new SubmissionError(
      `Google Forms returned HTTP ${response.status}`,
      response.status,
    );
  }
}
