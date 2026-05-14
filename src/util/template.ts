// Plain `{{var}}`-style template engine. No Handlebars dependency — Flint
// templates have ~5–10 substitutions each and never need conditionals or
// loops. Anything more complex than a substitution belongs in the
// init command itself (which composes whole files), not in a template helper.
//
// Variable shape:
//   - Names are [A-Za-z0-9_]+
//   - Lookups against the provided `vars` record, case-sensitive
//   - Missing keys throw — fail loud at scaffold time rather than ship
//     a `{{appName}}` string into the user's repo.

import { readFileSync } from 'node:fs';

const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface TemplateVars {
  [key: string]: string;
}

export function renderString(input: string, vars: TemplateVars): string {
  return input.replace(TEMPLATE_RE, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`Template variable "${name}" not provided.`);
    }
    return vars[name]!;
  });
}

export function renderFile(path: string, vars: TemplateVars): string {
  const raw = readFileSync(path, 'utf8');
  return renderString(raw, vars);
}

/**
 * Return the list of variable names referenced in the template string.
 * Useful for tests + future linting of template files.
 */
export function extractVarNames(input: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(TEMPLATE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    names.add(match[1]!);
  }
  return Array.from(names);
}
