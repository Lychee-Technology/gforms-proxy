import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
const script = resolve(repoRoot, 'scripts/gen-field-mapping.ts');

function runCli(...args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(tsxBin, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

describe('gen-field-mapping CLI argument parsing', () => {
  test('rejects an unknown flag with usage and non-zero exit', () => {
    const { status, stderr } = runCli('--url', 'http://example.com/form', '--turnstlie');
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown argument: --turnstlie');
    expect(stderr).toContain('Usage:');
  });

  test('exits non-zero with usage when --url is missing', () => {
    const { status, stderr } = runCli('--turnstile');
    expect(status).toBe(1);
    expect(stderr).toContain('Usage:');
  });
});
