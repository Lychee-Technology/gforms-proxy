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

describe('main() generated pattern policy', () => {
  test('rejects an unsupported generated regex before writing the definition', async () => {
    const formId = 'unsafePatternForm123';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(htmlForPattern('\\p{L}'))),
    );

    await expect(
      main([
        'node',
        'gen-field-mapping.ts',
        '--url',
        `https://docs.google.com/forms/d/e/${formId}/viewform`,
      ]),
    ).rejects.toThrow(
      `Form ${formId} contains patterns that cannot be deployed:\n- $.properties.field_1.pattern: unsupported RE2 syntax: ^(?:\\p{L})$`,
    );
    expect(existsSync(definitionPath(formId))).toBe(false);
  });

  test('writes the definition when the generated regex is safe', async () => {
    const formId = 'safePatternForm123';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('[a-z]+'))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
    ]);

    expect(existsSync(definitionPath(formId))).toBe(true);
  });

  test('--allow-unevaluable-patterns writes the definition and records the allowance', async () => {
    const formId = 'overridePatternForm123';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('\\p{L}'))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
      '--allow-unevaluable-patterns',
    ]);

    const definition = JSON.parse(
      readFileSync(definitionPath(formId), 'utf-8'),
    ) as Record<string, unknown>;
    expect(definition['unevaluablePatternsAllowed']).toBe(true);
    expect(warn.mock.calls[0]?.[0]).toContain('checked only by Google');
  });
});
