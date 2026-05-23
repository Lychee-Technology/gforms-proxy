export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SubmissionError';
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
        parts.push(`${encodeURIComponent(entryId)}=${encodeURIComponent(String(item))}`);
      }
    } else {
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
