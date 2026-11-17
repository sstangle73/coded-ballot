// Writes sample packets for the example election to the folder given (for checking the print layout by eye).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveIssuerKeys, loadRules } from '@coded-ballot/core';
import { freezeRollCsv, makeBallots } from './issuer.ts';

const out = process.argv[2] ?? '.';
const { rules } = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8'));
const { frozen } = freezeRollCsv(rules, readFileSync(new URL('../../../examples/roll.example.csv', import.meta.url), 'utf8'));
// The well-known BIP39 test phrase: sample ballots only, never a real election.
const keys = await deriveIssuerKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', rules.election.id);
const r = await makeBallots({ rules, frozen, keys, info: { votingPage: 'https://ballot.example.org/vote/', tracker: 'https://ballot.example.org/public/#e=agm-2027', countKeyFingerprint: 'ABCD EFGH JKMN PQRS', returnAddress: ['1 River Road', 'Exampleton NY 10001'] } });
for (const p of r.packets) writeFileSync(join(out, p.filename), p.pdf);
writeFileSync(join(out, 'all.pdf'), r.combined);
console.log(`wrote ${r.packets.length} sample packets to ${out}`);
