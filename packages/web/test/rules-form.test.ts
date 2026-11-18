// The election form writes the rules file: an election made from a file must come back out of the form unchanged.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadRules } from '@coded-ballot/core';
import { build, draftFrom, plain, slug } from '../pages/teller/rules-form.ts';

const example = loadRules(readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8')).rules;

describe('the election form', () => {
  it('keeps every setting of the example election, IDs included', () => {
    const { r, classes, contests } = draftFrom(example);
    const again = loadRules(stringify(build(r, classes, contests))).rules;
    expect(again).toEqual(example);
  });

  it('makes IDs from names for new classes, questions and candidates', () => {
    const { r, classes, contests } = draftFrom(example);
    classes.push({ label: 'Life member', weight: 'fixed', fixed: '2', column: '' });
    contests.push({ ...contests[0]!, id: undefined, rest: {}, title: 'Chair', kind: 'stv', seats: 2, names: 'Zoë Ng\nZoë Ng\nÅsa Berg', candidateIds: new Map(), eligible: null });
    const out = loadRules(stringify(build(r, classes, contests))).rules;
    expect(out.classes.at(-1)).toEqual({ id: 'life-member', label: 'Life member', weight: '2' });
    const q = out.contests.at(-1)!;
    expect(q.id).toBe('chair-2'); // the example already has "chair"
    expect('candidates' in q && q.candidates.map((c) => c.id)).toEqual(['zoe-ng', 'zoe-ng-2', 'asa-berg']);
    expect(slug('!!!', 'question-3')).toBe('question-3');
    expect(plain('dates.voting_closes: voting_closes must not be before voting_opens', [])).toBe('Voting closes must not be before voting opens.');
  });
});
