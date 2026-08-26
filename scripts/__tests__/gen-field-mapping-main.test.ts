import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../gen-field-mapping.js';

const MINIMAL_PAYLOAD = JSON.stringify([
  null,
  [
    null,
    [
      [null, 'What is your name?', 'Your full name', 0, [[123456, null, 1]]],
      [null, 'Choose one', '', 2, [[789012, [['Option A'], ['Option B']], 0]]],
    ],
  ],
]);

const MINIMAL_HTML = `<html><head><title>Test Form - Google Forms</title></head>
<body><script>var FB_PUBLIC_LOAD_DATA_ = ${MINIMAL_PAYLOAD};\n</script></body></html>`;

let workDir: string;
let originalCwd: string;

function definitionPath(formId: string): string {
  return join(workDir, 'src', 'forms', `${formId}.json`);
}

function readDefinition(formId: string): Record<string, any> {
  return JSON.parse(readFileSync(definitionPath(formId), 'utf8'));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gen-field-mapping-main-'));
  mkdirSync(join(workDir, 'src', 'forms'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(workDir);
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(MINIMAL_HTML)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('main() acceptance paths', () => {
  test('generates a brand-new form definition when no file exists', async () => {
    const formId = 'newFormId123';
    await main(['node', 'gen-field-mapping.ts', '--url', `https://docs.google.com/forms/d/e/${formId}/viewform`]);

    const definition = readDefinition(formId);
    expect(definition.formId).toBe(formId);
    expect(definition.submissionUrl).toBe(`https://docs.google.com/forms/d/e/${formId}/formResponse`);
    expect(definition.turnstileEnabled).toBeUndefined();
    expect(definition.schema.properties).not.toHaveProperty('turnstile_token');
    expect(Object.keys(definition.fieldMap)).toHaveLength(2);
    expect(Object.values(definition.fieldMap)).toContain('entry.123456');
  });

  test('regenerating with --turnstile keeps turnstileEnabled and the turnstile_token splice', async () => {
    const formId = 'protectedForm123';
    writeFileSync(
      definitionPath(formId),
      JSON.stringify({ formId, turnstileEnabled: true }, null, 2) + '\n',
    );

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
      '--turnstile',
    ]);

    const definition = readDefinition(formId);
    expect(definition.turnstileEnabled).toBe(true);
    expect(definition.schema.properties.turnstile_token).toEqual({
      type: 'string',
      description: 'Cloudflare Turnstile token',
    });
    expect(definition.schema.required).toContain('turnstile_token');
    // Regeneration actually happened: parsed fields are present
    expect(Object.keys(definition.fieldMap)).toHaveLength(2);
  });

  test('regenerating with --force strips turnstileEnabled and the turnstile_token splice', async () => {
    const formId = 'protectedForm123';
    writeFileSync(
      definitionPath(formId),
      JSON.stringify({ formId, turnstileEnabled: true }, null, 2) + '\n',
    );

    await main([
      'node',
      'gen-field-mapping.ts',
      '--url',
      `https://docs.google.com/forms/d/e/${formId}/viewform`,
      '--force',
    ]);

    const definition = readDefinition(formId);
    expect(definition.turnstileEnabled).toBeUndefined();
    expect(definition.schema.properties).not.toHaveProperty('turnstile_token');
    expect(definition.schema.required ?? []).not.toContain('turnstile_token');
    // Regeneration actually happened: parsed fields are present
    expect(Object.keys(definition.fieldMap)).toHaveLength(2);
  });
});
