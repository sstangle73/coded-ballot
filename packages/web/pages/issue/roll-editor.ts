// The membership roll, typed in on the issuer page instead of made in a spreadsheet. It runs where the issuer page
// runs, on the project's site, because names and addresses must not reach the organisation's server. This page keeps
// no copy: the result is a CSV file the issuer saves and keeps, because replacing a ballot or signing the close later
// needs the same roll again, byte for byte the same members.
import { parseCsv, type Rules } from '@coded-ballot/core';
import { h, status } from '../shared/ui.ts';

export type Row = Record<string, string>;

const ADDRESS = ['address_line1', 'address_line2', 'city', 'state', 'zip', 'country'];

const LABELS: Record<string, [string, string]> = {
  member_id: ['Member ID', 'Their membership number, or any ID used for nobody else. No spaces.'],
  name: ['Name', 'As it should appear on the envelope.'],
  class: ['Membership class', ''],
  email: ['Email', 'Optional. Needed to send them notices or their ballot by email.'],
  address_line1: ['Address', 'Optional. Needed to post them their ballot.'],
  address_line2: ['Address, second line', ''],
  city: ['Town or city', ''],
  state: ['State or county', ''],
  zip: ['ZIP or postcode', ''],
  postcode: ['Postcode', ''],
  country: ['Country', 'Leave it blank for your own country.'],
  large_print: ['Large-print ballot', ''],
  provisional: ['Provisional', 'yes if their vote is to be checked before it counts.'],
};

const YES = /^(1|y|yes|true)$/i;
const NO = /^(|0|n|no|false)$/i;
/** Spreadsheets read a UTF-8 file's accented names right only after a byte-order mark; the importer ignores it. */
const BOM = String.fromCharCode(0xfeff);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^\d+(\.\d{1,4})?$/;

/** The columns the importer reads headers as: trimmed, lower case, spaces as underscores. */
export const columnName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '_');

/** Classes whose weight comes from a roll column, by column. */
function weightColumns(rules: Rules): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of rules.classes) {
    if (typeof c.weight === 'object') {
      const col = columnName(c.weight.column);
      m.set(col, [...(m.get(col) ?? []), c.id]);
    }
  }
  return m;
}

/** The columns of a new roll for these rules. */
export function rollColumns(rules: Rules): string[] {
  return ['member_id', 'name', 'class', 'email', ...weightColumns(rules).keys(), ...ADDRESS, ...(rules.large_print ? ['large_print'] : [])];
}

function cell(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180, with a byte-order mark so spreadsheets read accented names right (the importer ignores it). */
export function toCsv(columns: string[], rows: Row[]): string {
  return BOM + [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function templateCsv(rules: Rules): string {
  return toCsv(rollColumns(rules), []);
}

/** A roll file as rows, for the editor. Short rows are padded, so a file with problems can still be fixed here. */
export function rowsFromCsv(csv: string): { columns: string[]; rows: Row[] } {
  const [head = [], ...rest] = parseCsv(csv);
  const columns = head.map(columnName);
  return { columns, rows: rest.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))) };
}

/** What would stop this member's row from being used, in plain words. */
export function problemsOf(rules: Rules, rows: Row[], i: number): string[] {
  const r = rows[i]!;
  const p: string[] = [];
  const id = (r.member_id ?? '').trim();
  if (!id) p.push('The member ID is missing.');
  else if (/[|\s]/.test(id)) p.push('The member ID can’t have spaces or a | in it.');
  else if (rows.some((o, j) => j !== i && (o.member_id ?? '').trim() === id)) p.push(`Member ID ${id} is used for someone else too.`);
  if (!(r.name ?? '').trim()) p.push('The name is missing.');
  const cls = rules.classes.find((c) => c.id === (r.class ?? '').trim());
  if (!(r.class ?? '').trim()) p.push('Choose a membership class.');
  else if (!cls) p.push(`“${r.class}” isn’t one of this election’s membership classes (${rules.classes.map((c) => c.id).join(', ')}).`);
  const email = (r.email ?? '').trim();
  if (email && !EMAIL.test(email)) p.push(`“${email}” doesn’t look like an email address.`);
  if (cls && typeof cls.weight === 'object') {
    const col = columnName(cls.weight.column);
    const v = (r[col] ?? '').trim();
    if (!NUMBER.test(v) || Number(v) === 0) p.push(`${cls.label} members need their number of ${col.replace(/_/g, ' ')}, like 12 or 12.5.`);
  }
  for (const col of ['large_print', 'provisional']) {
    if (col in r && !YES.test(r[col]!.trim()) && !NO.test(r[col]!.trim())) p.push(`${LABELS[col]![0]} should be yes or blank, not “${r[col]}”.`);
  }
  return p;
}

/** The next ID after the last one that ends in a number: M041 after M040. */
export function nextId(rows: Row[]): string {
  const ids = new Set(rows.map((r) => (r.member_id ?? '').trim()));
  const last = [...rows].reverse().map((r) => /^(.*?)(\d+)$/.exec((r.member_id ?? '').trim())).find(Boolean);
  if (!last) return rows.length ? '' : 'M001';
  const [, prefix, digits] = last;
  let n = Math.max(...[...ids].map((id) => (id.startsWith(prefix!) && /^\d+$/.test(id.slice(prefix!.length)) ? Number(id.slice(prefix!.length)) : 0)));
  let next: string;
  do next = prefix! + String(++n).padStart(digits!.length, '0');
  while (ids.has(next));
  return next;
}

function save(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A link that saves an empty roll with this election's columns, and what goes in each. */
export function templateLink(rules: Rules): HTMLElement {
  const weights = weightColumns(rules);
  const help = (col: string) => {
    if (col === 'class') return `One of: ${rules.classes.map((c) => `${c.id} (${c.label})`).join(', ')}.`;
    if (col === 'large_print') return 'yes for a large-print ballot, otherwise blank.';
    const w = weights.get(col);
    if (w) return `Votes for each ${w.map((id) => rules.classes.find((c) => c.id === id)!.label).join(' or ')} member, like 12.5. Blank for others.`;
    return LABELS[col]?.[1] ?? '';
  };
  return h(
    'div',
    {},
    h('p', {}, h('button', { class: 'secondary', onclick: () => save(templateCsv(rules), `roll-template-${rules.election.id}.csv`) }, 'Download a blank roll file')),
    h(
      'details',
      {},
      h('summary', {}, 'What goes in each column'),
      h('p', { class: 'small' }, 'Open the blank file in a spreadsheet, put one member on each row, and save it as CSV. Keep the column names as they are.'),
      h('dl', {}, ...rollColumns(rules).flatMap((c) => [h('dt', {}, h('code', {}, c)), h('dd', {}, help(c) || (LABELS[c]?.[0] ?? ''))])),
    ),
  );
}

export interface EditorOptions {
  rules: Rules;
  columns?: string[];
  rows?: Row[];
  fileName?: string;
  /** The roll is saved as a file; use it for this election. */
  use: (csv: string, fileName: string) => void;
  cancel: () => void;
}

/** Add, change and remove members, then save the roll file. Updates itself in place, so typing keeps its focus. */
export function rollEditor(o: EditorOptions): HTMLElement {
  const { rules } = o;
  const weights = weightColumns(rules);
  const columns = [...(o.columns?.length ? o.columns : rollColumns(rules))];
  for (const need of ['member_id', 'name', 'class', ...weights.keys()]) if (!columns.includes(need)) columns.push(need);
  const rows: Row[] = (o.rows ?? []).map((r) => ({ ...r }));
  const fileName = o.fileName ?? `roll-${rules.election.id}.csv`;
  let editing: number | null = null;
  let dirty = false;
  let filter = '';
  let undo: { row: Row; at: number } | null = null;

  const root = h('div', { class: 'roll-editor' });
  window.addEventListener('beforeunload', (e) => {
    if (dirty && root.isConnected) e.preventDefault();
  });

  const one = rules.classes.length === 1 ? rules.classes[0]!.id : null;
  const blank = (): Row => ({ ...Object.fromEntries(columns.map((c) => [c, ''])), member_id: nextId(rows), class: one ?? '' });
  const classLabel = (id: string) => rules.classes.find((c) => c.id === id)?.label ?? id;

  function form(): HTMLElement {
    const row: Row = editing === null ? blank() : { ...rows[editing]! };
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const wraps = new Map<string, HTMLElement>();
    const msg = h('div', {});
    const field = (col: string) => {
      const [label, hint] = LABELS[col] ?? [col.replace(/_/g, ' '), ''];
      const id = `roll-${col}`;
      let input: HTMLInputElement | HTMLSelectElement;
      let wrap: HTMLElement;
      if (col === 'class') {
        input = h('select', { id }, h('option', { value: '' }, 'Choose…'), ...rules.classes.map((c) => h('option', { value: c.id }, c.label)));
        input.value = rules.classes.some((c) => c.id === row.class) ? row.class! : '';
        input.addEventListener('change', showWeights);
        wrap = h('div', { class: one ? 'hidden' : '' }, h('label', { for: id }, label), input);
      } else if (col === 'large_print' || col === 'provisional') {
        input = h('input', { id, type: 'checkbox' });
        input.checked = YES.test(row[col] ?? '');
        wrap = h('label', { class: 'choice', for: id }, input, col === 'large_print' ? 'Send them a large-print ballot' : `Provisional: ${hint}`);
      } else {
        const w = weights.get(col);
        input = h('input', {
          id,
          type: col === 'email' ? 'email' : 'text',
          autocomplete: 'off',
          ...(w ? { inputmode: 'decimal' } : {}),
          ...(col === 'member_id' ? { autocapitalize: 'none', spellcheck: 'false' } : {}),
        });
        input.value = row[col] ?? '';
        const text = w ? `Number of ${col.replace(/_/g, ' ')}` : label;
        const why = w ? `Their votes, like 12.5. ${w.map(classLabel).join(' and ')} members only.` : hint;
        wrap = h('div', {}, h('label', { for: id }, text), why ? h('p', { class: 'small hint' }, why) : null, input);
      }
      inputs.set(col, input);
      wraps.set(col, wrap);
      return wrap;
    };
    function showWeights() {
      const cls = inputs.get('class')!.value;
      for (const [col, ids] of weights) wraps.get(col)?.classList.toggle('hidden', !ids.includes(cls));
    }
    const read = (): Row => {
      const r: Row = { ...row };
      for (const [col, input] of inputs) {
        r[col] = input instanceof HTMLInputElement && input.type === 'checkbox' ? (input.checked ? 'yes' : '') : input.value.trim();
      }
      const cw = rules.classes.find((c) => c.id === r.class)?.weight;
      for (const col of weights.keys()) if (!(typeof cw === 'object' && columnName(cw.column) === col)) r[col] = '';
      return r;
    };
    const submit = () => {
      const r = read();
      const all = [...rows];
      const at = editing ?? all.length;
      all[at] = r;
      const p = problemsOf(rules, all, at);
      if (p.length) {
        msg.replaceChildren(status('bad', p.length === 1 ? p[0]! : 'Fix these first:'), p.length > 1 ? h('ul', {}, ...p.map((x) => h('li', {}, x))) : '');
        msg.querySelector<HTMLElement>('[role=alert]')?.focus();
        return;
      }
      rows[at] = r;
      const added = editing === null;
      editing = null;
      dirty = true;
      undo = null;
      draw(added ? `Added ${r.name}.` : `Saved ${r.name}’s details.`);
      if (added) root.querySelector<HTMLInputElement>('#roll-name')?.focus();
    };
    const order = columns.filter((c) => c !== 'member_id' && c !== 'name');
    const box = h(
      'fieldset',
      {},
      h('legend', {}, editing === null ? 'Add a member' : `Change ${row.name || row.member_id}’s details`),
      field('name'),
      field('member_id'),
      ...order.map(field),
      msg,
      h('p', {}, h('button', { onclick: submit }, editing === null ? 'Add this member' : 'Save these details'), editing === null ? null : h('button', { class: 'secondary', onclick: () => ((editing = null), draw()) }, 'Cancel')),
    );
    box.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
        e.preventDefault();
        submit();
      }
    });
    showWeights();
    return box;
  }

  function list(): HTMLElement {
    const q = filter.trim().toLowerCase();
    const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || Object.values(r).some((v) => v.toLowerCase().includes(q)));
    const items = shown.map(({ r, i }) => {
      const p = problemsOf(rules, rows, i);
      const where = [r.city, r.zip ?? r.postcode].filter(Boolean).join(' ');
      return h(
        'li',
        { class: 'member' },
        h('strong', {}, r.name || '(no name)'),
        h('span', { class: 'small' }, ` ${[r.member_id, one ? '' : classLabel(r.class ?? ''), r.email || 'no email', where || (r.address_line1 ? '' : 'no address')].filter(Boolean).join(' · ')}`),
        p.length ? h('div', { class: 'status bad' }, p.join(' ')) : null,
        h(
          'div',
          {},
          h('button', { class: 'secondary', onclick: () => ((editing = i), draw(), root.querySelector<HTMLElement>('#roll-name')?.focus()) }, 'Change'),
          h('button', { class: 'secondary', onclick: () => ((undo = { row: rows[i]!, at: i }), rows.splice(i, 1), (editing = null), (dirty = true), draw(`Removed ${r.name || r.member_id}.`)) }, 'Remove'),
        ),
      );
    });
    return h(
      'div',
      {},
      rows.length ? h('ol', { class: 'members' }, ...items) : h('p', { class: 'small' }, 'Add the first member above.'),
      q && !shown.length ? h('p', { class: 'small' }, 'Nobody matches.') : null,
    );
  }

  function finder(): HTMLElement | null {
    if (rows.length <= 8) return null;
    const search = h('input', { id: 'roll-find', type: 'search', autocomplete: 'off', value: filter });
    search.addEventListener('input', () => {
      filter = search.value;
      root.querySelector('.member-list')!.replaceChildren(list());
    });
    return h('div', {}, h('label', { for: 'roll-find' }, 'Find a member'), search);
  }

  function draw(said = '') {
    const bad = rows.filter((_, i) => problemsOf(rules, rows, i).length).length;
    const said_ = said
      ? h('div', { class: 'status ok' }, said, ' ', undo ? h('button', { class: 'secondary', onclick: () => (rows.splice(undo!.at, 0, undo!.row), (undo = null), draw('Put back.')) }, 'Undo') : null)
      : null;
    root.replaceChildren(
      h('p', {}, 'Type in everyone who can vote. This page doesn’t keep the list: save the roll file before you leave, and keep it. You’ll need the same file again to replace a lost ballot or sign the close.'),
      said_ ?? '',
      form(),
      bad ? status('warn', `${bad} member${bad === 1 ? ' needs' : 's need'} fixing before you can use the roll.`) : '',
      h(
        'p',
        {},
        h(
          'button',
          {
            disabled: !rows.length || !!bad,
            onclick: () => {
              const csv = toCsv(columns, rows);
              save(csv, fileName);
              dirty = false;
              o.use(csv, fileName);
            },
          },
          'Save the roll file and use it',
        ),
        h('button', { class: 'secondary', disabled: !rows.length, onclick: () => (save(toCsv(columns, rows), fileName), (dirty = false)) }, 'Save the file, keep editing'),
        h('button', { class: 'secondary', onclick: () => (!dirty || window.confirm('Leave without saving these members?')) && o.cancel() }, 'Cancel'),
      ),
      h('h3', {}, rows.length ? `${rows.length} member${rows.length === 1 ? '' : 's'}` : 'No members yet'),
      finder() ?? '',
      h('div', { class: 'member-list' }, list()),
    );
  }
  draw();
  return root;
}
