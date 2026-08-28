import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../gen-field-mapping.js';

const htmlForPattern = (pattern: string) => {
  const payload = JSON.stringify([
    null,
    [
      null,
      [
        [
          null,
          'Enter a value',
          '',
          0,
          [[123456, null, 0, [[4, 301, [pattern]]]]],
        ],
      ],
    ],
  ]);
  return `<html><head><title>Pattern Form - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${payload};\n</script></body></html>`;
};

let workDir: string;
let originalCwd: string;

function definitionPath(formId: string): string {
  return join(workDir, 'src', 'forms', `${formId}.json`);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-patterns-'));
  mkdirSync(join(workDir, 'src', 'forms'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(workDir);
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('main() and forms with regex validation', () => {
  test('writes the definition and records the pattern in the schema', async () => {
    const formId = 'safePatternForm123';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('[a-z]+'))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
    ]);

    expect(existsSync(definitionPath(formId))).toBe(true);
    const definition = JSON.parse(
      readFileSync(definitionPath(formId), 'utf-8'),
    ) as { schema: { properties: Record<string, { pattern?: string }> } };
    expect(definition.schema.properties['field_1']?.pattern).toBe('^(?:[a-z]+)$');
  });

  test('writes the definition for a pattern no local matcher could evaluate', async () => {
    // Patterns are no longer evaluated locally, so none of them gates
    // generation: the schema records the rule and Google enforces it
    // (ADR 0006).
    const formId = 'unicodePatternForm123';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('\\p{L}'))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
    ]);

    expect(existsSync(definitionPath(formId))).toBe(true);
    const definition = JSON.parse(
      readFileSync(definitionPath(formId), 'utf-8'),
    ) as { schema: { properties: Record<string, { pattern?: string }> } };
    expect(definition.schema.properties['field_1']?.pattern).toBe('^(?:\\p{L})$');
  });
});
