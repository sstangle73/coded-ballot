// The membership roll: a CSV the organisation exports, imported once and frozen at the notice date. After that,
// every change is listed in the teller report, and a changed email means the old address is told.
import { canonicalJson, sha256Hex } from './bytes.ts';

export interface Member {
  memberId: string;
  classId: string;
  name: string;
  email: string | null;
  /** Every column from the CSV, as given (address lines, units, shares, ...). */
  fields: Record<string, string>;
}

export interface RollImport {
  members: Member[];
  problems: string[];
}

export interface FrozenRoll {
  frozenAt: string;
  members: Member[];
  /** SHA-256 of the members in member_id order, so the frozen roll can be checked later. */
  sha256: string;
}

export type RollChange =
  | { memberId: string; kind: 'added'; to: Member }
  | { memberId: string; kind: 'removed'; from: Member }
  | { memberId: string; kind: 'class_changed'; from: string; to: string }
  | { memberId: string; kind: 'email_changed'; from: string | null; to: string | null }
  | { memberId: string; kind: 'field_changed'; field: string; from: string; to: string };

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a header row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  // A byte-order mark, or one a spreadsheet read as three Latin-1 letters and saved back as text.
  const t = text.replace(/^(?:\u{feff}|\u{ef}\u{bb}\u{bf})/u, '');
  while (i < t.length) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += c === '\r' && t[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Import a roll CSV. Needs member_id and class columns; name and email are used when present. Rows with problems
 * are left out and listed, so nothing is silently dropped.
 */
export function importRoll(csvText: string, knownClasses: Iterable<string>): RollImport {
  const rows = parseCsv(csvText);
  const problems: string[] = [];
  if (!rows.length) return { members: [], problems: ['the file is empty'] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (n: string) => header.indexOf(n);
  for (const need of ['member_id', 'class']) {
    if (col(need) < 0) problems.push(`no ${need} column (columns found: ${header.join(', ')})`);
  }
  if (problems.length) return { members: [], problems };
  const classes = new Set(knownClasses);
  const seen = new Set<string>();
  const members: Member[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.length !== header.length) {
      problems.push(`line ${line}: ${r.length} columns, expected ${header.length}`);
      return;
    }
    const fields: Record<string, string> = {};
    header.forEach((h, j) => (fields[h] = r[j]!.trim()));
    const memberId = fields.member_id!;
    const classId = fields.class!;
    const email = (fields.email ?? '').trim() || null;
    if (!memberId) return void problems.push(`line ${line}: empty member_id`);
    if (/[|\s]/.test(memberId)) return void problems.push(`line ${line}: member_id may not contain spaces or |`);
    if (seen.has(memberId)) return void problems.push(`line ${line}: member_id ${memberId} appears twice`);
    if (!classes.has(classId)) return void problems.push(`line ${line}: unknown class "${classId}"`);
    if (email && !EMAIL.test(email)) return void problems.push(`line ${line}: "${email}" doesn't look like an email`);
    seen.add(memberId);
    members.push({ memberId, classId, name: fields.name ?? '', email: email?.toLowerCase() ?? null, fields });
  });
  return { members, problems };
}

export function freezeRoll(members: Member[], frozenAt: string): FrozenRoll {
  const sorted = [...members].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  return { frozenAt, members: sorted, sha256: sha256Hex(canonicalJson(sorted)) };
}

/** Every difference between the roll frozen at notice and a later one, for the teller report. */
export function diffRolls(frozen: FrozenRoll, current: Member[]): RollChange[] {
  const before = new Map(frozen.members.map((m) => [m.memberId, m]));
  const after = new Map(current.map((m) => [m.memberId, m]));
  const changes: RollChange[] = [];
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const id of ids) {
    const a = before.get(id);
    const b = after.get(id);
    if (!a && b) changes.push({ memberId: id, kind: 'added', to: b });
    else if (a && !b) changes.push({ memberId: id, kind: 'removed', from: a });
    else if (a && b) {
      if (a.classId !== b.classId) changes.push({ memberId: id, kind: 'class_changed', from: a.classId, to: b.classId });
      if (a.email !== b.email) changes.push({ memberId: id, kind: 'email_changed', from: a.email, to: b.email });
      const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
      for (const k of [...keys].sort()) {
        if (k === 'class' || k === 'email' || k === 'member_id') continue;
        const x = a.fields[k] ?? '';
        const y = b.fields[k] ?? '';
        if (x !== y) changes.push({ memberId: id, kind: 'field_changed', field: k, from: x, to: y });
      }
    }
  }
  return changes;
}
