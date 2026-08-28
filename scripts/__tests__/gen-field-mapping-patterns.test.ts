import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../gen-field-mapping.js';

// 301 is the regex "matches" operator; 299 is regex "contains", which keeps
// an already-anchored pattern verbatim in the generated schema.
const htmlForPattern = (pattern: string, operatorCode = 301) => {
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
          [[123456, null, 0, [[4, operatorCode, [pattern]]]]],
        ],
      ],
    ],
  ]);
  return `<html><head><title>Pattern Form - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${payload};\n</script></body></html>`;
};

// A form with no validation rules at all, so nothing can carry a pattern.
const PATTERN_FREE_HTML = `<html><head><title>Plain Form - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify([
  null,
  [null, [[null, 'What is your name?', '', 0, [[123456, null, 1]]]]],
])};\n</script></body></html>`;

let workDir: string;
let originalCwd: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

function definitionPath(formId: string): string {
  return join(workDir, 'src', 'forms', `${formId}.json`);
}

function stderrText(): string {
  return errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-patterns-'));
  mkdirSync(join(workDir, 'src', 'forms'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(workDir);
  vi.stubEnv('GEMINI_API_KEY', '');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

  test('onboards the multi-quantifier pattern from the issue #21 criteria', async () => {
    // ^\d{3}-\d{4}$ is the acceptance-criterion pattern: several bounded
    // quantifiers in one rule. It must reach the generated schema intact,
    // because the schema still describes the rule Google enforces.
    const formId = 'quantifierPatternForm1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(htmlForPattern('^\\d{3}-\\d{4}$', 299))),
    );

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
    expect(definition.schema.properties['field_1']?.pattern).toBe('^\\d{3}-\\d{4}$');
  });
});

describe('main() and the regex-delegation notice', () => {
  test('reports how many fields carry regex validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('[a-z]+'))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      'https://docs.google.com/forms/d/e/noticePatternForm12/viewform',
    ]);

    expect(stderrText()).toContain('Note: 1 field carries regex validation.');
    expect(stderrText()).toContain('Google enforces those rules when the response is submitted');
  });

  test('counts a field once even when its pattern is nested under a not constraint', async () => {
    // 302 is regex "does_not_match", which lands as { not: { pattern } }
    // inside allOf rather than as a top-level pattern.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(htmlForPattern('[a-z]+', 302))));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      'https://docs.google.com/forms/d/e/nestedPatternForm12/viewform',
    ]);

    expect(stderrText()).toContain('Note: 1 field carries regex validation.');
  });

  test('says nothing about regex for a form with no patterns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PATTERN_FREE_HTML)));

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      'https://docs.google.com/forms/d/e/plainForm1234567890/viewform',
    ]);

    expect(stderrText()).not.toContain('regex validation');
  });
});
