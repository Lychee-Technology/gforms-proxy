#!/usr/bin/env tsx
import { pathToFileURL } from 'node:url';
import registry from '../src/forms/registry.js';
import { assertDeployablePatterns } from '../src/lib/pattern-policy.js';
import type { FormDefinition } from '../src/lib/types.js';

export function validateRegisteredForms(
  definitions: ReadonlyMap<string, FormDefinition>,
): void {
  const failures: string[] = [];

  for (const [formId, definition] of definitions) {
    try {
      assertDeployablePatterns(formId, definition.schema, {
        allowUnevaluable: definition.unevaluablePatternsAllowed === true,
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Registered form validation failed:\n${failures.join('\n\n')}`);
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  try {
    validateRegisteredForms(registry);
  } catch (error) {
    console.error(
      'Error validating registered forms:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
