/**
 * Guard against silently stripping Turnstile protection when regenerating a
 * form definition. Returns an error message when the write must be aborted,
 * or null when it is safe to proceed.
 */
import { existsSync, readFileSync } from 'node:fs';

export function checkTurnstileDowngrade(
  outPath: string,
  opts: { turnstile: boolean; force: boolean },
): string | null {
  if (opts.turnstile || opts.force) return null;
  if (!existsSync(outPath)) return null;

  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }

  if (
    typeof existing === 'object' &&
    existing !== null &&
    (existing as Record<string, unknown>)['turnstileEnabled'] === true
  ) {
    return (
      `Existing definition at ${outPath} has turnstileEnabled: true, but --turnstile was not passed.\n` +
      'Regenerating without it would silently strip bot protection.\n' +
      'Re-run with --turnstile to keep protection, or pass --force to strip it intentionally.'
    );
  }

  return null;
}
