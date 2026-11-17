// Writes schemas/rules.schema.json, the published schema for rules files, from src/rules/schema.ts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { rulesJsonSchema } from '../src/rules/load.ts';

const out = new URL('../../../schemas/rules.schema.json', import.meta.url);
mkdirSync(new URL('.', out), { recursive: true });
const schema = { title: 'coded-ballot rules file', ...rulesJsonSchema() };
writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
console.log('wrote', out.pathname);
