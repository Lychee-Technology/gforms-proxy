import { compilePattern, type CompileFailure } from './re2/index.js';

export interface SchemaPatternIssue {
  path: string;
  pattern: string;
  reason: CompileFailure;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const propertyPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

export function findSchemaPatternIssues(
  schema: unknown,
): SchemaPatternIssue[] {
  const issues: SchemaPatternIssue[] = [];
  const activeAncestors = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    if (activeAncestors.has(value)) return;
    activeAncestors.add(value);

    try {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }

      for (const [key, child] of Object.entries(value)) {
        const childPath = propertyPath(path, key);
        if (key === 'pattern' && typeof child === 'string') {
          const result = compilePattern(child);
          if (!result.ok) {
            issues.push({ path: childPath, pattern: child, reason: result.reason });
          }
        }
        visit(child, childPath);
      }
    } finally {
      activeAncestors.delete(value);
    }
  };

  visit(schema, '$');
  return issues;
}

export const SAFE_SUBSET_HINT =
  'The matcher supports standard regex syntax, minus constructs it cannot ' +
  'model faithfully: among them Unicode property classes (\\p{...}), inline ' +
  'flags ((?i)), POSIX classes ([[:alpha:]]), named groups, lookarounds, ' +
  'negated class escapes inside a character class ([\\S]; where the escape is ' +
  "the class's only member, [^\\s] is the rewrite), a character class whose " +
  'first member is ] or : ([]a], [:abc]; escape it, [\\]a]), and escapes such ' +
  'as \\a \\A \\z \\Q...\\E \\x{...} \\101. ' +
  "Counted repetition is capped at RE2's own maximum of 1000, and a pattern " +
  'whose repetition expands past the 4000-instruction program budget is ' +
  'refused too. A second budget of 4000 caps the character-class ranges the ' +
  'whole expansion emits (ranges multiplied by repetitions), so a class of ' +
  "about 8 ranges caps repetition around 500: ^[a-zA-Z0-9 .,'-]{1,500}$ " +
  'compiles and {1,501} does not. Lower the repeat count, narrow the class, ' +
  'otherwise simplify the pattern on the Google Form, or pass ' +
  '--allow-unevaluable-patterns to onboard it with that field checked only ' +
  'by Google. See docs/adr/0005 and issue #21.';

export function assertDeployablePatterns(
  formId: string,
  schema: unknown,
  options: { allowUnevaluable?: boolean } = {},
): void {
  const issues = findSchemaPatternIssues(schema);
  if (issues.length === 0) return;

  const details = issues
    .map(({ path, reason, pattern }) => {
      const displayPattern = pattern
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
      return `- ${path}: ${reason}: ${displayPattern}`;
    })
    .join('\n');

  if (options.allowUnevaluable) {
    console.warn(
      `Warning: form ${formId} contains patterns the matcher cannot evaluate:\n${details}\n` +
        'These fields will be checked only by Google. Proceeding because ' +
        'unevaluable patterns are allowed here: --allow-unevaluable-patterns ' +
        'on the generator, unevaluablePatternsAllowed in the definition for ' +
        'validate:forms.',
    );
    return;
  }

  throw new Error(
    `Form ${formId} contains patterns that cannot be deployed:\n${details}\n${SAFE_SUBSET_HINT}`,
  );
}
