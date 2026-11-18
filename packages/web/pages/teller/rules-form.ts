// The election form: every setting an election needs, in plain words, so nobody has to write a rules file. It writes
// the same rules file (YAML) the server checks and keeps as the election's record, with its SHA-256 in the teller
// report. Things already in an election's rules that the form doesn't show (a candidate's note, a custom threshold)
// are kept as they are. Membership classes and questions keep their IDs once made, because printed ballots use them.
import { stringify } from 'yaml';
import { loadRules, RulesError, type Rules } from '@coded-ballot/core';
import { h, show, status } from '../shared/ui.ts';
import type { Ctx } from './teller.ts';

// Loosely typed on purpose: the draft holds whatever the rules file holds, and loadRules checks the result.
type Obj = Record<string, any>;

interface ClassDraft {
  /** Kept from the rules file; new classes get one from their label when saved. */
  id?: string;
  label: string;
  weight: 'one' | 'fixed' | 'column';
  fixed: string;
  column: string;
}

interface ContestDraft {
  id?: string;
  /** Everything else the rules file had for this question, kept. */
  rest: Obj;
  title: string;
  description: string;
  kind: Kind;
  seats: number;
  names: string;
  /** Candidate IDs already made, by name, so an edit keeps them. */
  candidateIds: Map<string, string>;
  writeIns: boolean;
  threshold: 'simple' | 'two_thirds' | 'three_quarters' | 'custom';
  allowAbstain: boolean;
  /** Who votes on it: null means every class. */
  eligible: Set<ClassDraft> | null;
  weighted: boolean;
}

type Kind = 'one' | 'irv' | 'stv' | 'many' | 'approval' | 'yes_no';

const KINDS: Record<Kind, string> = {
  one: 'Elect one person: whoever gets the most votes',
  irv: 'Elect one person: voters rank the candidates (instant runoff)',
  many: 'Elect several people: the most votes win the seats',
  stv: 'Elect several people: voters rank the candidates (single transferable vote)',
  approval: 'Elect people: voters mark everyone they approve of',
  yes_no: 'A motion or question: yes or no',
};

const THRESHOLDS = {
  simple: { label: 'More than half the votes cast (a simple majority)', value: { fraction: '1/2', of: 'votes_cast', rule: 'more_than', abstain_counts: false } },
  two_thirds: { label: 'At least two-thirds of the votes cast', value: { fraction: '2/3', of: 'votes_cast', rule: 'at_least', abstain_counts: false } },
  three_quarters: { label: 'At least three-quarters of the votes cast', value: { fraction: '3/4', of: 'votes_cast', rule: 'at_least', abstain_counts: false } },
} as const;

const DATE_LABELS: [key: string, label: string, help: string][] = [
  ['notice', 'The roll is frozen', 'Members on the roll at this time, with the email addresses you have for them then, are the ones who vote.'],
  ['ballots_out', 'Ballots go out', 'When you expect to post or hand out the ballots.'],
  ['voting_opens', 'Voting opens', 'Online voting starts, and posted ballots start to count.'],
  ['voting_closes', 'Voting closes', 'The last moment to vote online, and the deadline for posted ballots to arrive.'],
  ['meeting', 'The meeting (optional)', 'If you vote in person at a meeting, when it is.'],
];

export function slug(s: string, fallback: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return out || fallback;
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 37)}-${n}`;
  taken.add(id);
  return id;
}

/** An ISO date-time with this computer's offset, which the rules file keeps as written. */
function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

function toInput(s: string | undefined): string {
  return s ? iso(new Date(s)).slice(0, 16) : '';
}

/** A datetime-local value is this computer's local time. */
function fromInput(v: string): string | undefined {
  return v ? iso(new Date(v)) : undefined;
}

function daysFromNow(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return iso(d);
}

function kindOf(c: Obj): Kind {
  if (c.method === 'plurality') return (c.seats ?? 1) > 1 ? 'many' : 'one';
  return c.method as Kind;
}

function thresholdOf(t: Obj | undefined): ContestDraft['threshold'] {
  if (!t) return 'simple';
  for (const [k, v] of Object.entries(THRESHOLDS)) {
    if (v.value.fraction === t.fraction && v.value.rule === (t.rule ?? 'more_than') && (t.of ?? 'votes_cast') === 'votes_cast' && !t.abstain_counts) return k as ContestDraft['threshold'];
  }
  return 'custom';
}

export function draftFrom(rules: Obj): { r: Obj; classes: ClassDraft[]; contests: ContestDraft[] } {
  const r: Obj = structuredClone(rules);
  const classes: ClassDraft[] = (r.classes as Obj[]).map((c) => ({
    id: c.id,
    label: c.label,
    weight: c.weight && typeof c.weight === 'object' ? 'column' : c.weight !== undefined && Number(c.weight) !== 1 ? 'fixed' : 'one',
    fixed: c.weight !== undefined && typeof c.weight !== 'object' ? String(c.weight) : '2',
    column: c.weight && typeof c.weight === 'object' ? c.weight.column : 'shares',
  }));
  const byId = new Map(classes.map((c) => [c.id!, c]));
  const contests: ContestDraft[] = (r.contests as Obj[]).map((c) => {
    const { id, title, description, method, seats, candidates, write_ins, threshold, allow_abstain, eligible_classes, weighted, ...rest } = c;
    return {
      id,
      rest: { ...rest, ...(method === 'yes_no' ? { threshold } : {}) },
      title,
      description: description ?? '',
      kind: kindOf(c),
      seats: seats ?? 1,
      names: ((candidates ?? []) as Obj[]).map((x) => x.name).join('\n'),
      candidateIds: new Map(((candidates ?? []) as Obj[]).map((x) => [x.name, x.id])),
      writeIns: !!write_ins,
      threshold: thresholdOf(threshold),
      allowAbstain: allow_abstain ?? true,
      eligible: eligible_classes ? new Set((eligible_classes as string[]).map((x) => byId.get(x)).filter((x): x is ClassDraft => !!x)) : null,
      weighted: !!weighted,
    };
  });
  return { r, classes, contests };
}

function blank(): Obj {
  return {
    schema_version: 1,
    election: { id: '', title: '', organisation: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    dates: { notice: daysFromNow(7, 9), ballots_out: daysFromNow(14, 9), voting_opens: daysFromNow(14, 9), voting_closes: daysFromNow(35, 19) },
    retention_days: 90,
    roles: { mode: 'separated' },
    channels: { mail: true, online: true, in_person: true },
    time_lock: { enabled: false },
    classes: [{ id: 'member', label: 'Member' }],
    contests: [],
    large_print: true,
  };
}

function newContest(): ContestDraft {
  return { rest: {}, title: '', description: '', kind: 'one', seats: 1, names: '', candidateIds: new Map(), writeIns: false, threshold: 'simple', allowAbstain: true, eligible: null, weighted: false };
}

/** The rules object from the form, ready for the rules file. */
export function build(r: Obj, classes: ClassDraft[], contests: ContestDraft[]): Obj {
  const classIds = new Set(classes.filter((c) => c.id).map((c) => c.id!));
  for (const [i, c] of classes.entries()) if (!c.id) c.id = unique(slug(c.label, `class-${i + 1}`), classIds);
  const out: Obj = { ...r };
  out.classes = classes.map((c) => ({
    id: c.id,
    label: c.label.trim(),
    ...(c.weight === 'fixed' ? { weight: c.fixed.trim() } : c.weight === 'column' ? { weight: { column: c.column.trim() } } : {}),
  }));
  const contestIds = new Set(contests.filter((c) => c.id).map((c) => c.id!));
  const anyWeights = classes.some((c) => c.weight !== 'one');
  out.contests = contests.map((c, i) => {
    if (!c.id) c.id = unique(slug(c.title, `question-${i + 1}`), contestIds);
    const base: Obj = { id: c.id, title: c.title.trim() };
    if (c.description.trim()) base.description = c.description.trim();
    const eligible = c.eligible && c.eligible.size < classes.length ? classes.filter((x) => c.eligible!.has(x)).map((x) => x.id) : null;
    if (eligible) base.eligible_classes = eligible;
    if (anyWeights && c.weighted) base.weighted = true;
    if (c.kind === 'yes_no') {
      const threshold = c.threshold === 'custom' ? c.rest.threshold : THRESHOLDS[c.threshold].value;
      const { threshold: _old, ...rest } = c.rest;
      return { ...rest, ...base, method: 'yes_no', threshold, allow_abstain: c.allowAbstain };
    }
    const { threshold: _t, ...rest } = c.rest;
    const taken = new Set<string>();
    const candidates = c.names
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name, j) => ({ id: unique(c.candidateIds.get(name) ?? slug(name, `candidate-${j + 1}`), taken), name }));
    const method = c.kind === 'one' || c.kind === 'many' ? 'plurality' : c.kind;
    const seats = c.kind === 'one' || c.kind === 'irv' ? 1 : Math.max(1, Math.floor(c.seats || 1));
    return { ...rest, ...base, method, seats, candidates, ...(c.writeIns ? { write_ins: true } : {}) };
  });
  if (!out.dates.meeting) delete out.dates.meeting;
  return out;
}

/** Plain names for the places a problem can be. */
export function plain(problem: string, contests: ContestDraft[]): string {
  const label = (k: string) => DATE_LABELS.find((d) => d[0] === k)?.[1] ?? k;
  const order = /^dates\.\w+: (\w+) must not be before (\w+)$/.exec(problem);
  if (order) return `${label(order[1]!)} must not be before ${label(order[2]!).toLowerCase()}.`;
  return problem
    .replace(/^election\.id:.*/, 'The short name must be lower-case letters, digits and hyphens.')
    .replace(/^election\.title/, 'Title')
    .replace(/^election\.organisation/, 'Organisation')
    .replace(/^dates\.(\w+)/, (_, k: string) => label(k))
    .replace(/^contests\.(\d+)(\.[\w.]+)?/, (_, i: string, rest: string) => `Question ${Number(i) + 1} (${contests[Number(i)]?.title || 'untitled'})${rest ? ', ' + rest.slice(1).replace(/\./g, ' ') : ''}`)
    .replace(/^classes\.(\d+)(\.[\w.]+)?/, (_, i: string, rest: string) => `Membership class ${Number(i) + 1}${rest ? ', ' + rest.slice(1).replace(/\./g, ' ') : ''}`)
    .replace(/^quorum/, 'Quorum')
    .replace(/^channels/, 'Ways to vote');
}

export interface FormOptions {
  /** The election's current rules, to change them; none for a new election. */
  rules?: Rules;
  /** Ballots exist already: say what changing the rules does to them. */
  ballotsMade?: boolean;
  /** Saves the rules file; returns the election ID. */
  save: (yaml: string) => Promise<string>;
  done: (id: string) => void;
  cancel: () => void;
}

export function electionForm(ctx: Ctx, opts: FormOptions) {
  const editing = !!opts.rules;
  const { r, classes, contests } = draftFrom(opts.rules ?? blank());
  let idTouched = editing;
  const root = h('div', {});

  const text = (id: string, value: string, set: (v: string) => void, attrs: Obj = {}) => {
    const el = h('input', { id, type: 'text', autocomplete: 'off', ...attrs });
    el.value = value;
    el.addEventListener('input', () => set(el.value));
    return el;
  };
  const area = (id: string, value: string, set: (v: string) => void, rows = 3) => {
    const el = h('textarea', { id, rows: String(rows), autocomplete: 'off' });
    el.value = value;
    el.addEventListener('input', () => set(el.value));
    return el;
  };
  const check = (label: string, value: boolean, set: (v: boolean) => void) => {
    const el = h('input', { type: 'checkbox' });
    el.checked = value;
    el.addEventListener('change', () => set(el.checked));
    return h('label', { class: 'choice' }, el, label);
  };
  const choose = <T extends string>(id: string, options: Record<T, string>, value: T, set: (v: T) => void) => {
    const el = h('select', { id }, ...Object.entries(options).map(([k, v]) => h('option', { value: k }, v as string)));
    el.value = value;
    el.addEventListener('change', () => set(el.value as T));
    return el;
  };

  // ---- about ----
  const idInput = text('f-id', r.election.id, (v) => ((r.election.id = v.trim()), (idTouched = true)), { spellcheck: 'false', disabled: editing });
  const about = h(
    'fieldset',
    {},
    h('legend', {}, 'The election'),
    h('label', { for: 'f-title' }, 'Title'),
    text('f-title', r.election.title, (v) => {
      r.election.title = v;
      if (!idTouched) idInput.value = r.election.id = slug(v, '');
    }, { placeholder: 'Annual general meeting 2027' }),
    h('label', { for: 'f-org' }, 'Organisation'),
    text('f-org', r.election.organisation, (v) => (r.election.organisation = v)),
    h('label', { for: 'f-id' }, 'Short name, for links'),
    idInput,
    h('p', { class: 'small' }, editing ? 'It can’t change once the election exists.' : 'Made from the title; lower-case letters, digits and hyphens. It appears in links and on ballots.'),
  );

  // ---- dates ----
  const tzNote = r.election.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` The election is set to ${r.election.timezone}.` : '';
  const dates = h(
    'fieldset',
    {},
    h('legend', {}, 'Dates'),
    h('p', { class: 'small' }, `Times are in this computer’s time zone, ${Intl.DateTimeFormat().resolvedOptions().timeZone}.${tzNote}`),
    ...DATE_LABELS.flatMap(([k, label, help]) => {
      const el = h('input', { id: `f-${k}`, type: 'datetime-local' });
      el.value = toInput(r.dates[k]);
      el.addEventListener('change', () => (r.dates[k] = fromInput(el.value)));
      return [h('label', { for: `f-${k}` }, label), el, h('p', { class: 'small' }, help)];
    }),
  );

  // ---- how to vote ----
  const ways = h(
    'fieldset',
    {},
    h('legend', {}, 'How members can vote'),
    check('By post (paper ballots scanned on arrival)', r.channels.mail, (v) => (r.channels.mail = v)),
    check('Online (an emailed link plus the code on their ballot)', r.channels.online, (v) => (r.channels.online = v)),
    check('In person, at the meeting', r.channels.in_person, (v) => (r.channels.in_person = v)),
    check('Offer large-print ballots (members marked large_print in the roll get one)', r.large_print ?? true, (v) => (r.large_print = v)),
  );

  const roles = h(
    'fieldset',
    {},
    h('legend', {}, 'Who runs it'),
    choose('f-mode', { separated: 'An issuer sends out the ballots, and different people (tellers) count them (recommended)', one_person: 'One person does both' }, r.roles?.mode ?? 'separated', (v) => (r.roles = { mode: v })),
    h('p', { class: 'small' }, 'Keeping them apart means nobody alone can both make ballots and open the online votes. With one person, the safeguards are a public log, not a lock.'),
  );

  // ---- classes and questions: rebuilt when one is added or removed ----
  const classBox = h('div', {});
  const contestBox = h('div', {});
  const drawClasses = () => {
    classBox.replaceChildren(
      ...classes.map((c, i) => {
        const fixed = text(`f-cw-${i}`, c.fixed, (v) => (c.fixed = v), { inputmode: 'decimal' });
        const column = text(`f-cc-${i}`, c.column, (v) => (c.column = v), { spellcheck: 'false' });
        const extra = h('div', {});
        const drawExtra = () =>
          extra.replaceChildren(
            ...(c.weight === 'fixed' ? [h('label', { for: `f-cw-${i}` }, 'Votes each'), fixed] : c.weight === 'column' ? [h('label', { for: `f-cc-${i}` }, 'Roll column with each member’s votes (units or shares)'), column] : []),
          );
        drawExtra();
        return h(
          'div',
          { class: 'panel' },
          h('label', { for: `f-cl-${i}` }, `Membership class ${i + 1}`),
          text(`f-cl-${i}`, c.label, (v) => (c.label = v)),
          c.id ? h('p', { class: 'small' }, `In the roll’s class column: ${c.id}`) : h('p', { class: 'small' }, `In the roll’s class column: ${slug(c.label, '…')} (from the name, when saved)`),
          h('label', { for: `f-cwt-${i}` }, 'Votes'),
          choose(`f-cwt-${i}`, { one: 'One vote each', fixed: 'The same number of votes each', column: 'A number from the roll (units or shares)' }, c.weight, (v) => ((c.weight = v), drawExtra(), drawContests())),
          extra,
          classes.length > 1 ? h('button', { type: 'button', class: 'secondary', onclick: () => (classes.splice(i, 1), contests.forEach((q) => q.eligible?.delete(c)), drawClasses(), drawContests()) }, 'Remove this class') : null,
        );
      }),
      h('button', { type: 'button', class: 'secondary', onclick: () => (classes.push({ label: '', weight: 'one', fixed: '2', column: 'shares' }), drawClasses(), drawContests()) }, 'Add a membership class'),
    );
  };

  const drawContests = () => {
    const anyWeights = classes.some((c) => c.weight !== 'one');
    contestBox.replaceChildren(
      ...(contests.length ? [] : [status('info', 'Add at least one question: a post to fill, or a motion.')]),
      ...contests.map((c, i) => {
        const p = `f-q${i}`;
        const kindBody = h('div', {});
        const drawKind = () => {
          const candidates = c.kind !== 'yes_no';
          const seats = c.kind === 'many' || c.kind === 'stv' || c.kind === 'approval';
          kindBody.replaceChildren(
            ...(seats ? [h('label', { for: `${p}-seats` }, 'Seats to fill'), text(`${p}-seats`, String(c.seats), (v) => (c.seats = Number(v)), { type: 'number', min: '1', inputmode: 'numeric' })] : []),
            ...(candidates
              ? [
                  h('label', { for: `${p}-names` }, 'Candidates, one per line'),
                  area(`${p}-names`, c.names, (v) => (c.names = v), 5),
                  check('Voters may write in someone else', c.writeIns, (v) => (c.writeIns = v)),
                ]
              : [
                  h('label', { for: `${p}-thr` }, 'It passes with'),
                  choose(
                    `${p}-thr`,
                    { ...Object.fromEntries(Object.entries(THRESHOLDS).map(([k, v]) => [k, v.label])), ...(c.threshold === 'custom' ? { custom: 'The rule already in this election’s settings' } : {}) } as Record<ContestDraft['threshold'], string>,
                    c.threshold,
                    (v) => (c.threshold = v),
                  ),
                  check('Voters may abstain', c.allowAbstain, (v) => (c.allowAbstain = v)),
                ]),
          );
        };
        drawKind();
        return h(
          'div',
          { class: 'panel' },
          h('label', { for: `${p}-title` }, `Question ${i + 1}`),
          text(`${p}-title`, c.title, (v) => (c.title = v), { placeholder: c.kind === 'yes_no' ? 'Motion 1: change the club’s name' : 'Chair' }),
          h('label', { for: `${p}-kind` }, 'Kind'),
          choose(`${p}-kind`, KINDS, c.kind, (v) => {
            c.kind = v;
            if ((v === 'many' || v === 'stv') && c.seats < 2) c.seats = 2;
            drawKind();
          }),
          kindBody,
          h('label', { for: `${p}-desc` }, 'Wording on the ballot (optional)'),
          area(`${p}-desc`, c.description, (v) => (c.description = v), 2),
          classes.length > 1
            ? h(
                'fieldset',
                {},
                h('legend', {}, 'Who votes on it'),
                ...classes.map((cl) =>
                  check(cl.label || '(unnamed class)', !c.eligible || c.eligible.has(cl), (v) => {
                    c.eligible ??= new Set(classes);
                    if (v) c.eligible.add(cl);
                    else c.eligible.delete(cl);
                  }),
                ),
              )
            : null,
          anyWeights ? check('Count each member’s votes from their class (units or shares), not one each', c.weighted, (v) => (c.weighted = v)) : null,
          h(
            'p',
            {},
            i > 0 ? h('button', { type: 'button', class: 'secondary', onclick: () => (contests.splice(i - 1, 0, ...contests.splice(i, 1)), drawContests()) }, 'Move up') : null,
            h('button', { type: 'button', class: 'secondary', onclick: () => (contests.splice(i, 1), drawContests()) }, 'Remove this question'),
          ),
        );
      }),
      h('button', { type: 'button', class: 'secondary', onclick: () => (contests.push(newContest()), drawContests(), contestBox.querySelector<HTMLInputElement>(`#f-q${contests.length - 1}-title`)?.focus()) }, 'Add a question'),
    );
  };
  drawClasses();
  drawContests();

  // ---- more settings ----
  const quorumKind = r.quorum?.ballots ? 'ballots' : r.quorum?.fraction_of_members ? 'fraction' : 'none';
  const quorumBox = h('div', {});
  let qKind: 'none' | 'ballots' | 'fraction' = quorumKind;
  let qBallots = String(r.quorum?.ballots ?? 10);
  let qFraction = r.quorum?.fraction_of_members ?? '1/10';
  const drawQuorum = () =>
    quorumBox.replaceChildren(
      ...(qKind === 'ballots' ? [h('label', { for: 'f-qb' }, 'Ballots needed'), text('f-qb', qBallots, (v) => (qBallots = v), { type: 'number', min: '1' })] : []),
      ...(qKind === 'fraction' ? [h('label', { for: 'f-qf' }, 'Share of members who must vote, as a fraction like 1/10'), text('f-qf', qFraction, (v) => (qFraction = v))] : []),
    );
  drawQuorum();
  r.notice_wording ??= {};
  const more = h(
    'details',
    {},
    h('summary', {}, 'More settings'),
    h('label', { for: 'f-quorum' }, 'Quorum'),
    choose('f-quorum', { none: 'None', ballots: 'A number of ballots', fraction: 'A share of the members' }, qKind, (v) => ((qKind = v), drawQuorum())),
    quorumBox,
    check('Time-lock online votes until voting closes (needs the drand network at the count)', r.time_lock?.enabled ?? false, (v) => (r.time_lock = { enabled: v })),
    h('label', { for: 'f-ret' }, 'Days to keep ballots and images after the results are certified'),
    text('f-ret', String(r.retention_days ?? 90), (v) => (r.retention_days = Number(v)), { type: 'number', min: '1', max: '3650' }),
    h('label', { for: 'f-intro' }, 'Opening words of the ballot letter (optional)'),
    area('f-intro', r.notice_wording.intro ?? '', (v) => (r.notice_wording.intro = v.trim() || undefined)),
  );

  // ---- save ----
  const msg = h('div', {});
  const yamlOf = () => {
    const out = build(r, classes, contests);
    out.quorum = qKind === 'ballots' ? { ballots: Number(qBallots) } : qKind === 'fraction' ? { fraction_of_members: qFraction.trim() } : undefined;
    if (!out.quorum) delete out.quorum;
    if (out.notice_wording && !out.notice_wording.intro) delete out.notice_wording.intro;
    return `# ${out.election.title}: the rules for this election, made with the election form in coded-ballot's tellers' app.\n${stringify(out)}`;
  };
  const submit = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        const problems: string[] = [];
        if (!r.election.title.trim()) problems.push('Give the election a title.');
        if (!r.election.organisation.trim()) problems.push('Give the organisation’s name.');
        if (!contests.length) problems.push('Add at least one question.');
        contests.forEach((c, i) => {
          if (!c.title.trim()) problems.push(`Question ${i + 1} needs a title.`);
          if (c.kind !== 'yes_no' && !c.names.trim()) problems.push(`Question ${i + 1} needs candidates.`);
        });
        classes.forEach((c, i) => !c.label.trim() && problems.push(`Membership class ${i + 1} needs a name.`));
        let yaml = '';
        if (!problems.length) {
          yaml = yamlOf();
          try {
            loadRules(yaml);
          } catch (e) {
            if (!(e instanceof RulesError)) throw e;
            problems.push(...e.problems.map((p) => plain(p, contests)));
          }
        }
        if (problems.length) return msg.replaceChildren(status('bad', 'Some settings need fixing:'), h('ul', {}, ...problems.map((p) => h('li', {}, p))));
        submit.disabled = true;
        try {
          opts.done(await opts.save(yaml));
        } catch (e) {
          msg.replaceChildren(status('bad', (e as Error).message));
        } finally {
          submit.disabled = false;
        }
      },
    },
    editing ? 'Save the changes' : 'Create the election',
  );
  const download = h(
    'button',
    {
      type: 'button',
      class: 'secondary',
      onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([yamlOf()], { type: 'text/yaml' })), download: `${r.election.id || 'election'}.yaml` });
        a.click();
      },
    },
    'Save these settings as a file',
  );

  root.append(
    h('h2', {}, editing ? `Change “${r.election.title}”` : 'A new election'),
    opts.ballotsMade ? status('warn', 'Ballots are already made for this election. They keep the wording they were printed with: if you change a question or a candidate, make and send them again.') : '',
    about,
    dates,
    ways,
    roles,
    h('fieldset', {}, h('legend', {}, 'Membership classes'), h('p', { class: 'small' }, 'Every member on the roll belongs to one class. Most organisations need only one. Use more when some members vote on different questions, or have more votes than others.'), classBox),
    h('fieldset', {}, h('legend', {}, 'What’s on the ballot'), contestBox),
    more,
    msg,
    h('p', {}, submit, h('button', { type: 'button', class: 'secondary', onclick: opts.cancel }, 'Cancel'), download),
  );
  show(ctx.app, root);
}
