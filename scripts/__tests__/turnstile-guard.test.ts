import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTurnstileDowngrade } from '../turnstile-guard.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turnstile-guard-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeDefinition(definition: Record<string, unknown>): string {
  const path = join(dir, 'form.json');
  writeFileSync(path, JSON.stringify(definition, null, 2) + '\n');
  return path;
}

describe('checkTurnstileDowngrade', () => {
  test('blocks regenerating a protected form without --turnstile', () => {
    const path = writeDefinition({ formId: 'abc', turnstileEnabled: true });
    const message = checkTurnstileDowngrade(path, { turnstile: false, force: false });
    expect(message).toContain('--turnstile');
    expect(message).toContain('--force');
  });

  test('allows regenerating a protected form with --turnstile', () => {
    const path = writeDefinition({ formId: 'abc', turnstileEnabled: true });
    expect(checkTurnstileDowngrade(path, { turnstile: true, force: false })).toBeNull();
  });

  test('allows stripping protection with --force', () => {
    const path = writeDefinition({ formId: 'abc', turnstileEnabled: true });
    expect(checkTurnstileDowngrade(path, { turnstile: false, force: true })).toBeNull();
  });

  test('allows generating a brand-new form (no existing file)', () => {
    const path = join(dir, 'does-not-exist.json');
    expect(checkTurnstileDowngrade(path, { turnstile: false, force: false })).toBeNull();
  });

  test('allows regenerating an unprotected form without --turnstile', () => {
    const path = writeDefinition({ formId: 'abc' });
    expect(checkTurnstileDowngrade(path, { turnstile: false, force: false })).toBeNull();
  });

  test('allows regenerating when existing file is not valid JSON', () => {
    const path = join(dir, 'form.json');
    writeFileSync(path, 'not json');
    expect(checkTurnstileDowngrade(path, { turnstile: false, force: false })).toBeNull();
  });

  test('allows regenerating when turnstileEnabled is explicitly false', () => {
    const path = writeDefinition({ formId: 'abc', turnstileEnabled: false });
    expect(checkTurnstileDowngrade(path, { turnstile: false, force: false })).toBeNull();
  });

  test('propagates filesystem read errors instead of allowing the overwrite', () => {
    const path = writeDefinition({ formId: 'abc', turnstileEnabled: true });
    chmodSync(path, 0o000);
    try {
      expect(() => checkTurnstileDowngrade(path, { turnstile: false, force: false })).toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
  });
});
