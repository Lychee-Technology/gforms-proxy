export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
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
    );
  }
}

export async function submitToGoogleForms(
  submissionUrl: string,
  fieldMap: Record<string, string>,
  data: Record<string, unknown>,
): Promise<void> {
  const parts: string[] = [];

  for (const [key, entryId] of Object.entries(fieldMap)) {
    const value = data[key];
    if (value === undefined || value === null) continue;

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
    });
  } catch {
    throw new SubmissionError('Network error: could not reach Google Forms');
  }

  if (!response.ok) {
    throw new SubmissionError(
      `Google Forms returned HTTP ${response.status}`,
      response.status,
    );
  }
}
