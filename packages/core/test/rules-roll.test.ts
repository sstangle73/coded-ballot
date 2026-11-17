import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRules, RulesError, rulesJsonSchema } from '../src/rules/load.ts';
import { diffRolls, freezeRoll, importRoll, parseCsv } from '../src/roll.ts';
import { describeStyle, electorate, eligible, parseStyleId, styleFor, styleWeightFor } from '../src/eligibility.ts';
import { fmt } from '../src/decimal.ts';

const example = readFileSync(new URL('../../../examples/rules.example.yaml', import.meta.url), 'utf8');

describe('rules file', () => {
  it('loads the example and fills in defaults', () => {
    const { rules, sha256 } = loadRules(example);
    expect(rules.election.id).toBe('agm-2027');
    expect(rules.contests).toHaveLength(4);
    expect(rules.small_group_threshold).toBe(5);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const motion = rules.contests.find((c) => c.id === 'motion-1')!;
    expect(motion.method === 'yes_no' && motion.threshold.rule).toBe('at_least');
  });
  it('explains problems in plain lines', () => {
    const bad = example
      .replace('voting_closes: 2027-03-29T19:00:00-04:00', 'voting_closes: 2027-02-01T19:00:00-05:00')
      .replace('eligible_classes: [full]\n\n  - id: committee', 'eligible_classes: [fulll]\n\n  - id: committee');
    try {
      loadRules(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RulesError);
      const p = (e as RulesError).problems.join('\n');
      expect(p).toMatch(/voting_closes must not be before voting_opens/);
      expect(p).toMatch(/unknown class fulll/);
    }
  });
  it('rejects YAML with duplicate keys and unknown methods', () => {
    expect(() => loadRules('schema_version: 1\nschema_version: 1\n')).toThrow(RulesError);
    expect(() => loadRules(example.replace('method: irv', 'method: borda'))).toThrow(RulesError);
  });
  it('publishes a JSON Schema', () => {
    const s = rulesJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(s.properties)).toContain('contests');
  });
});

const csv = [
  'member_id,name,class,email,shares',
  'M001,"Example, Ana",full,ana@example.org,',
  'M002,Ben,associate,,',
  'M003,Cai,owner,CAI@example.org,12.5',
  'M004,Dee,owner,dee@example.org,3',
  'M005,Eve,nosuch,,',
  'M001,Dup,full,,',
].join('\r\n');

describe('roll', () => {
  const { rules } = loadRules(example);
  const classes = rules.classes.map((c) => c.id);

  it('parses quoted CSV', () => {
    expect(parseCsv('a,b\n"x,""y""",z\n')).toEqual([['a', 'b'], ['x,"y"', 'z']]);
  });
  it('imports members and lists every problem row', () => {
    const r = importRoll(csv, classes);
    expect(r.members.map((m) => m.memberId)).toEqual(['M001', 'M002', 'M003', 'M004']);
    expect(r.members[0]!.name).toBe('Example, Ana');
    expect(r.members[2]!.email).toBe('cai@example.org');
    expect(r.problems).toEqual(['line 6: unknown class "nosuch"', 'line 7: member_id M001 appears twice']);
  });
  it('freezes with a fingerprint and diffs later changes', () => {
    const { members } = importRoll(csv, classes);
    const frozen = freezeRoll(members, rules.dates.notice);
    expect(freezeRoll([...members].reverse(), rules.dates.notice).sha256).toBe(frozen.sha256);
    const later = members
      .filter((m) => m.memberId !== 'M002')
      .map((m) => (m.memberId === 'M001' ? { ...m, email: 'new@example.org' } : m));
    later.push({ memberId: 'M009', classId: 'full', name: 'New', email: null, fields: {} });
    expect(diffRolls(frozen, later).map((c) => `${c.memberId}:${c.kind}`)).toEqual([
      'M001:email_changed',
      'M002:removed',
      'M009:added',
    ]);
  });
  it('gives weights, styles and eligibility', () => {
    const { members } = importRoll(csv, classes);
    const [ana, ben, cai] = members;
    const chair = rules.contests.find((c) => c.id === 'chair')!;
    const roof = rules.contests.find((c) => c.id === 'boathouse')!;
    expect(fmt(eligible(rules, ana!, chair))).toBe('1');
    expect(eligible(rules, ben!, chair)).toBe(0n);
    expect(fmt(eligible(rules, cai!, roof))).toBe('12.5');
    const s = styleFor(rules, cai!, { largePrint: true });
    expect(s.id).toBe('owner_w12.5_lp');
    expect(s.contests).toEqual(['boathouse']);
    expect(parseStyleId('owner_w12.5_lp_prov')).toEqual({ classId: 'owner', weight: '12.5', largePrint: true, provisional: true });
    expect(describeStyle(rules, 'full').contests).toEqual(['chair', 'committee', 'motion-1']);
    expect(fmt(styleWeightFor(rules, 'owner_w3', roof))).toBe('3');
    expect(fmt(electorate(rules, members, roof).weight)).toBe('15.5');
  });
});
