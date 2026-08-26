import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
const script = resolve(repoRoot, 'scripts/gen-field-mapping.ts');

function runCli(args: string[], cwd: string = repoRoot): { status: number | null; stderr: string } {
  const result = spawnSync(tsxBin, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

describe('gen-field-mapping CLI argument parsing', () => {
  test('rejects an unknown flag with usage and non-zero exit', () => {
    const { status, stderr } = runCli(['--url', 'http://example.com/form', '--turnstlie']);
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown argument: --turnstlie');
    expect(stderr).toContain('Usage:');
  });

  test('exits non-zero with usage when --url is missing', () => {
    const { status, stderr } = runCli(['--turnstile']);
    expect(status).toBe(1);
    expect(stderr).toContain('Usage:');
  });
});

describe('gen-field-mapping CLI turnstile guard', () => {
  test('an invalid URL reports the URL error, not a turnstile downgrade', () => {
    const formId = 'testFormId123';
    const workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-'));
    try {
      const formsDir = join(workDir, 'src', 'forms');
      mkdirSync(formsDir, { recursive: true });
      writeFileSync(
        join(formsDir, `${formId}.json`),
        JSON.stringify({ formId, turnstileEnabled: true }, null, 2) + '\n',
      );

      const url = `https://evil.example/d/e/${formId}/not-viewform`;
      const { status, stderr } = runCli(['--url', url], workDir);

      expect(status).toBe(1);
      expect(stderr).toContain('Invalid Google Forms URL');
      expect(stderr).not.toContain('turnstileEnabled');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('regenerating a protected form without --turnstile exits non-zero and leaves the file untouched', () => {
    const formId = 'testFormId123';
    const workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-'));
    try {
      const formsDir = join(workDir, 'src', 'forms');
      mkdirSync(formsDir, { recursive: true });
      const definitionPath = join(formsDir, `${formId}.json`);
      const original = JSON.stringify({ formId, turnstileEnabled: true }, null, 2) + '\n';
      writeFileSync(definitionPath, original);

      const url = `https://docs.google.com/forms/d/e/${formId}/viewform`;
      const { status, stderr } = runCli(['--url', url], workDir);

      expect(status).toBe(1);
      expect(stderr).toContain('--turnstile');
      expect(stderr).toContain('--force');
      // Guard must abort before the network fetch even starts
      expect(stderr).not.toContain('Fetching form');
      expect(readFileSync(definitionPath, 'utf8')).toBe(original);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
