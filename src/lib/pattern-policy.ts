import {
  JS_REGEX_FLAGS,
  toJavaScriptRegexSource,
} from './re2-compat.js';

export interface SchemaPatternIssue {
  path: string;
  pattern: string;
  reason:
    | 'outside safe RE2 subset'
    | 'uncompilable translated pattern';
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
          const source = toJavaScriptRegexSource(child);
          if (source === null) {
            issues.push({
              path: childPath,
              pattern: child,
              reason: 'outside safe RE2 subset',
            });
          } else {
            try {
              new RegExp(source, JS_REGEX_FLAGS);
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              issues.push({
                path: childPath,
                pattern: child,
                reason: 'uncompilable translated pattern',
              });
            }
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

export function assertDeployablePatterns(formId: string, schema: unknown): void {
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
  throw new Error(
    `Form ${formId} contains patterns that cannot be deployed:\n${details}`,
  );
}
