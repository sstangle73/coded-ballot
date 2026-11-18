// The roll editor writes the roll file: what it writes must import as the same members, and the template must have
// the columns this election reads.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freezeRollCsv } from '@coded-ballot/issuer';
import { loadRules } from '@coded-ballot/core';
import { decodeRoll, nextId, problemsOf, rollColumns, rowsFromCsv, templateCsv, toCsv, type Row } from '../pages/issue/roll-editor.ts';

const rules = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8')).rules;
const exampleCsv = readFileSync(new URL('../../../examples/roll.example.csv', import.meta.url), 'utf8');

describe('the roll editor', () => {
  it('writes back the example roll as the same frozen roll', () => {
    const { columns, rows } = rowsFromCsv(exampleCsv);
    expect(freezeRollCsv(rules, toCsv(columns, rows)).frozen.sha256).toBe(freezeRollCsv(rules, exampleCsv).frozen.sha256);
  });

  it('quotes commas, quotes and accents so they come back unchanged', () => {
    const rows = [{ member_id: 'M001', name: 'Zoë "Zed" O’Neil, Jr', class: 'full', email: '', address_line1: '1 Rue, Apt 2' }];
    const { frozen, problems } = freezeRollCsv(rules, toCsv(['member_id', 'name', 'class', 'email', 'address_line1'], rows));
    expect(problems).toEqual([]);
    expect(frozen.members[0]!.name).toBe('Zoë "Zed" O’Neil, Jr');
    expect(frozen.members[0]!.fields.address_line1).toBe('1 Rue, Apt 2');
  });

  it('gives a blank file with the election’s columns, the shares column included', () => {
    expect(templateCsv(rules).trim().split(',')).toEqual(rollColumns(rules));
    expect(rollColumns(rules)).toContain('shares');
    expect(rowsFromCsv(templateCsv(rules)).rows).toEqual([]);
  });

  it('says in plain words what is wrong with a member', () => {
    const rows: Row[] = [
      { member_id: 'M001', name: 'Ana', class: 'full', email: '' },
      { member_id: 'M001', name: '', class: 'owner', email: 'nope', shares: '' },
    ];
    expect(problemsOf(rules, rows, 0)).toEqual(['Member ID M001 is used for someone else too.']);
    expect(problemsOf(rules, rows, 1)).toEqual([
      'Member ID M001 is used for someone else too.',
      'The name is missing.',
      '“nope” doesn’t look like an email address.',
      'Boat-share owner members need their number of shares, like 12 or 12.5.',
    ]);
  });

  it('suggests the next member ID', () => {
    expect(nextId([])).toBe('M001');
    expect(nextId([{ member_id: 'M009' }, { member_id: 'M010' }])).toBe('M011');
    expect(nextId([{ member_id: 'A-7' }, { member_id: 'A-8' }, { member_id: 'A-9' }])).toBe('A-10');
    expect(nextId([{ member_id: 'smith' }])).toBe('');
  });
});

describe('reading a roll a spreadsheet saved', () => {
  const header = 'member_id,name,class,email\r\n';
  it('reads Excel’s Windows-1252 CSV with its accents', () => {
    const bytes = Uint8Array.from([...header, 'M001,Zo', 'X', ',full,\r\n'].join('').split('').map((c) => (c === 'X' ? 0xeb : c.charCodeAt(0))));
    const { frozen, problems } = freezeRollCsv(rules, decodeRoll(bytes));
    expect(problems).toEqual([]);
    expect(frozen.members[0]!.name).toBe('Zo' + String.fromCharCode(0xeb));
  });
  it('ignores a byte-order mark, and one a spreadsheet turned into three letters', () => {
    for (const lead of [[0xfeff], [0xef, 0xbb, 0xbf]]) {
      const { problems, frozen } = freezeRollCsv(rules, String.fromCharCode(...lead) + header + 'M001,Ana,full,\r\n');
      expect(problems).toEqual([]);
      expect(frozen.members.length).toBe(1);
    }
  });
  it('downloads with no byte-order mark', () => {
    expect(templateCsv(rules).charCodeAt(0)).toBe('m'.charCodeAt(0));
  });
});
