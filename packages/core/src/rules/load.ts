import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { Rules } from './schema.ts';
import { sha256Hex } from '../bytes.ts';

export interface LoadedRules {
  rules: Rules;
  /** SHA-256 of the file exactly as given; the teller report records it. */
  sha256: string;
}

export class RulesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The rules file has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`);
    this.name = 'RulesError';
    this.problems = problems;
  }
}

/** Parse and check a YAML rules file. Throws RulesError with one plain line per problem. */
export function loadRules(yamlText: string): LoadedRules {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { prettyErrors: true, uniqueKeys: true });
  } catch (e) {
    throw new RulesError([`not valid YAML: ${(e as Error).message}`]);
  }
  const parsed = Rules.safeParse(raw);
  if (!parsed.success) throw new RulesError(describeIssues(parsed.error));
  return { rules: parsed.data, sha256: sha256Hex(yamlText) };
}

function describeIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`);
}

/** The published JSON Schema for rules files. */
export function rulesJsonSchema(): object {
  return z.toJSONSchema(Rules, { io: 'input', unrepresentable: 'any' });
}
