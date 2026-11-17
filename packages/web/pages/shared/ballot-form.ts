// One contest's form fields, shared by the voting page and the tellers' adjudication screen.
import type { Contest } from '@coded-ballot/core';
import { h } from './ui.ts';

export type Getter = () => { ok: true; selection: string[] } | { ok: false; message: string };

/**
 * The form for one contest. `initial` pre-fills it (the tellers' app uses it to show what was read from a paper
 * ballot); `prefix` keeps element IDs apart when several ballots are on one page.
 */
export function contestFields(c: Contest, initial: string[] = [], prefix = ''): { node: HTMLElement; get: Getter } {
  const name = `${prefix}c-${c.id}`;
  const legend = h('legend', {}, c.title);
  if (c.method === 'yes_no') {
    const opts = ['yes', 'no', ...(c.allow_abstain ? ['abstain'] : [])];
    const inputs = opts.map((o) => h('input', { type: 'radio', name, value: o, checked: initial.includes(o) }));
    const node = h('fieldset', {}, legend, ...opts.map((o, i) => h('label', { class: 'choice' }, inputs[i]!, o[0]!.toUpperCase() + o.slice(1))));
    return { node, get: () => ({ ok: true, selection: inputs.filter((x) => x.checked).map((x) => x.value) }) };
  }
  const cands = c.candidates;
  if (c.method === 'irv' || c.method === 'stv') {
    // rows: each candidate, then one write-in row if the rules allow write-ins
    const rows = cands.map((cd) => ({ id: cd.id, label: cd.name }));
    const wiAt = initial.findIndex((x) => x.startsWith('write-in:'));
    const wiText = c.write_ins ? h('input', { type: 'text', id: `${name}-wi`, maxlength: '80', autocomplete: 'off', value: wiAt >= 0 ? initial[wiAt]!.slice(9) : '', 'aria-label': 'Write-in name' }) : null;
    const n = cands.length + (wiText ? 1 : 0);
    const select = (id: string, at: number, label?: string) =>
      h(
        'select',
        { id, ...(label ? { 'aria-label': label } : {}) },
        h('option', { value: '' }, '—'),
        ...Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1), selected: at === i + 1 }, String(i + 1))),
      );
    const selects = rows.map((r) => select(`${name}-${r.id}`, initial.indexOf(r.id) + 1));
    const wiSelect = wiText ? select(`${name}-wi-rank`, wiAt + 1, 'Rank for the write-in') : null;
    const node = h(
      'fieldset',
      {},
      legend,
      h('p', { class: 'small' }, `Give 1 to your first choice, 2 to your next, and so on. Rank as many as you like.${c.method === 'stv' ? ` ${c.seats} seats.` : ''}`),
      ...rows.map((r, i) => h('div', { class: 'rank-row' }, h('label', { for: `${name}-${r.id}`, style: 'margin:0;font-weight:400' }, r.label), selects[i]!)),
      wiText && wiSelect && h('div', { class: 'rank-row' }, h('label', { for: `${name}-wi`, style: 'margin:0;font-weight:400' }, 'Write-in: ', wiText), wiSelect),
    );
    return {
      node,
      get: () => {
        const ranks = selects.map((s, i) => ({ id: rows[i]!.id, r: Number(s.value) })).filter((x) => x.r > 0);
        const wi = wiText?.value.trim();
        if (wi && wiSelect) {
          if (!Number(wiSelect.value)) return { ok: false, message: `${c.title}: give the write-in a rank, or clear the name.` };
          ranks.push({ id: `write-in:${wi}`, r: Number(wiSelect.value) });
        } else if (wiSelect && Number(wiSelect.value)) return { ok: false, message: `${c.title}: type the write-in name, or clear its rank.` };
        const used = new Set<number>();
        for (const x of ranks) {
          if (used.has(x.r)) return { ok: false, message: `${c.title}: two names have rank ${x.r}. Give each name a different number.` };
          used.add(x.r);
        }
        return { ok: true, selection: ranks.sort((a, b) => a.r - b.r).map((x) => x.id) };
      },
    };
  }
  const max = c.method === 'plurality' ? c.seats : (c.max_approvals ?? cands.length);
  const single = max === 1;
  const inputs = cands.map((cd) => h('input', { type: single ? 'radio' : 'checkbox', name, value: cd.id, checked: initial.includes(cd.id) }));
  const wiInitial = initial.find((x) => x.startsWith('write-in:'))?.slice(9) ?? '';
  const writeIn = c.write_ins ? h('input', { type: 'text', id: `${name}-wi`, maxlength: '80', autocomplete: 'off', value: wiInitial }) : null;
  const node = h(
    'fieldset',
    {},
    legend,
    h('p', { class: 'small' }, max === 1 ? 'Choose one.' : c.method === 'approval' && !c.max_approvals ? 'Choose as many as you approve of.' : `Choose up to ${max}.`),
    ...cands.map((cd, i) => h('label', { class: 'choice' }, inputs[i]!, cd.name)),
    writeIn && h('label', { for: `${name}-wi` }, 'Write-in (optional)'),
    writeIn,
  );
  return {
    node,
    get: () => {
      const sel = inputs.filter((x) => x.checked).map((x) => x.value);
      const wi = writeIn?.value.trim();
      if (wi) sel.push(`write-in:${wi}`);
      if (sel.length > max) return { ok: false, message: `${c.title}: choose at most ${max}.` };
      return { ok: true, selection: sel };
    },
  };
}
