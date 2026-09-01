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

// Grid/date/time questions produce object values that would serialize as
// "[object Object]"; fail loudly instead of corrupting the submission (#6).
function assertSerializable(key: string, value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    throw new SubmissionError(
      `Field "${key}" has an object value, which cannot be submitted to Google Forms`,
      undefined,
      'invalid-value',
    );
  }
}

export async function submitToGoogleForms(
  submissionUrl: string,
  fieldMap: Record<string, FieldMapping>,
  data: Record<string, unknown>,
): Promise<void> {
  const parts: string[] = [];

  for (const [key, entryId] of Object.entries(fieldMap)) {
    const value = data[key];
    if (value === undefined || value === null) continue;

    // Bridge until the compound encodings land (#23): no bundled definition
    // carries a structured mapping yet.
    if (typeof entryId !== 'string') {
      throw new SubmissionError(
        `Field "${key}" uses a mapping this submitter does not encode yet`,
        undefined,
        'invalid-value',
      );
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        assertSerializable(key, item);
        parts.push(`${encodeURIComponent(entryId)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      assertSerializable(key, value);
      parts.push(`${encodeURIComponent(entryId)}=${encodeURIComponent(String(value))}`);
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
