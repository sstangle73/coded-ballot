// The rules file: every value an organisation sets for one election. Behaviour lives in reviewed code modules
// (count, eligible, layout); this file only holds values, and is checked against this schema before anything runs.
// The JSON Schema published for it is generated from this file (npm run schema in packages/core).
import { z } from 'zod';

export const RULES_SCHEMA_VERSION = 1;

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and hyphens, starting with a letter or digit, 1-40 long');

const isoDateTime = z.iso.datetime({ offset: true });

const fractionString = z
  .string()
  .regex(/^\d+\/\d+$/, 'a fraction such as 1/2 or 2/3')
  .refine((s) => {
    const [n, d] = s.split('/').map(Number);
    return d! > 0 && n! <= d!;
  }, 'between 0/1 and 1/1');

const decimalString = z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d+(\.\d{1,4})?$/, 'a number with at most 4 decimal places'),
]);

export const Candidate = z.object({
  id,
  name: z.string().min(1).max(120),
  note: z.string().max(200).optional(),
});

export const Threshold = z.object({
  fraction: fractionString.describe('share of the base needed, e.g. 1/2 or 2/3'),
  of: z
    .enum(['votes_cast', 'members'])
    .default('votes_cast')
    .describe('votes_cast: yes + no (abstentions left out unless abstain_counts); members: every eligible member'),
  rule: z
    .enum(['more_than', 'at_least'])
    .default('more_than')
    .describe('more_than 1/2 is a simple majority; at_least 2/3 is the usual two-thirds'),
  abstain_counts: z.boolean().default(false).describe('count abstentions in votes_cast'),
});

const contestBase = {
  id,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  eligible_classes: z.array(id).min(1).optional().describe('membership classes that vote on this; default all'),
  weighted: z.boolean().default(false).describe("use each member's class weight (units or shares) for this contest"),
};

const candidateContest = {
  ...contestBase,
  candidates: z.array(Candidate).min(1),
  seats: z.number().int().min(1).default(1),
  write_ins: z.boolean().default(false),
};

export const PluralityContest = z.object({ ...candidateContest, method: z.literal('plurality') });
export const ApprovalContest = z.object({
  ...candidateContest,
  method: z.literal('approval'),
  max_approvals: z.number().int().min(1).optional().describe('most choices one ballot may mark; default no limit'),
});
export const IrvContest = z.object({ ...candidateContest, method: z.literal('irv'), seats: z.literal(1).default(1) });
export const StvContest = z.object({
  ...candidateContest,
  method: z.literal('stv'),
  stv_rules: z.literal('scottish').default('scottish').describe('Scottish STV (SSI 2007/42 rules 45-52)'),
});
export const YesNoContest = z.object({
  ...contestBase,
  method: z.literal('yes_no'),
  threshold: Threshold.default({ fraction: '1/2', of: 'votes_cast', rule: 'more_than', abstain_counts: false }),
  allow_abstain: z.boolean().default(true),
});

export const Contest = z.discriminatedUnion('method', [
  PluralityContest,
  ApprovalContest,
  IrvContest,
  StvContest,
  YesNoContest,
]);

export const MemberClass = z.object({
  id,
  label: z.string().min(1).max(80),
  weight: z
    .union([
      decimalString,
      z.object({ column: z.string().min(1).describe('roll CSV column holding each member’s units or shares') }),
    ])
    .default(1)
    .describe('a fixed weight for everyone in the class, or a roll column'),
});

export const Quorum = z
  .union([
    z.object({ ballots: z.number().int().min(1) }),
    z.object({ fraction_of_members: fractionString }),
  ])
  .describe('minimum turnout for any result to stand');

export const Rules = z
  .object({
    schema_version: z.literal(RULES_SCHEMA_VERSION),
    election: z.object({
      id,
      title: z.string().min(1).max(200),
      organisation: z.string().min(1).max(200),
      timezone: z.string().min(1).default('UTC'),
    }),
    dates: z.object({
      notice: isoDateTime.describe('the roll (including emails) is frozen at this time'),
      ballots_out: isoDateTime,
      voting_opens: isoDateTime,
      voting_closes: isoDateTime,
      meeting: isoDateTime.optional(),
    }),
    retention_days: z.number().int().min(1).max(3650).default(90).describe('days after certification before purge'),
    roles: z
      .object({
        mode: z.enum(['separated', 'one_person']).default('separated'),
      })
      .default({ mode: 'separated' }),
    channels: z
      .object({
        mail: z.boolean().default(true),
        online: z.boolean().default(true),
        in_person: z.boolean().default(true),
      })
      .default({ mail: true, online: true, in_person: true }),
    time_lock: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    classes: z.array(MemberClass).min(1),
    contests: z.array(Contest).min(1),
    quorum: Quorum.optional(),
    tie_break: z
      .array(z.enum(['previous_rounds', 'lot']))
      .min(1)
      .default(['previous_rounds', 'lot'])
      .describe('how ties are settled, in order; lot uses the first drand round after close'),
    small_group_threshold: z.number().int().min(2).default(5),
    large_print: z.boolean().default(true).describe('offer a large-print ballot style'),
    notice_wording: z
      .object({
        intro: z.string().max(4000).optional(),
        report_misuse: z
          .string()
          .max(1000)
          .default('If the tracker shows your code as used and you did not use it, tell the tellers at once.'),
      })
      .default({
        report_misuse: 'If the tracker shows your code as used and you did not use it, tell the tellers at once.',
      }),
  })
  .superRefine((r, ctx) => {
    const order = ['notice', 'ballots_out', 'voting_opens', 'voting_closes'] as const;
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1]!;
      const b = order[i]!;
      if (Date.parse(r.dates[a]) > Date.parse(r.dates[b])) {
        ctx.addIssue({ code: 'custom', path: ['dates', b], message: `${b} must not be before ${a}` });
      }
    }
    const classIds = new Set<string>();
    r.classes.forEach((c, i) => {
      if (classIds.has(c.id)) ctx.addIssue({ code: 'custom', path: ['classes', i, 'id'], message: 'duplicate class id' });
      classIds.add(c.id);
    });
    const contestIds = new Set<string>();
    r.contests.forEach((c, i) => {
      if (contestIds.has(c.id))
        ctx.addIssue({ code: 'custom', path: ['contests', i, 'id'], message: 'duplicate contest id' });
      contestIds.add(c.id);
      for (const cl of c.eligible_classes ?? []) {
        if (!classIds.has(cl))
          ctx.addIssue({ code: 'custom', path: ['contests', i, 'eligible_classes'], message: `unknown class ${cl}` });
      }
      if ('candidates' in c) {
        const seen = new Set<string>();
        c.candidates.forEach((cand, j) => {
          if (seen.has(cand.id))
            ctx.addIssue({ code: 'custom', path: ['contests', i, 'candidates', j, 'id'], message: 'duplicate candidate id' });
          seen.add(cand.id);
        });
        if (c.method !== 'approval' && c.seats > c.candidates.length && !c.write_ins) {
          ctx.addIssue({ code: 'custom', path: ['contests', i, 'seats'], message: 'more seats than candidates' });
        }
      }
    });
    if (!r.channels.mail && !r.channels.online && !r.channels.in_person) {
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'at least one channel must be allowed' });
    }
  });

export type Rules = z.infer<typeof Rules>;
export type Contest = z.infer<typeof Contest>;
export type MemberClass = z.infer<typeof MemberClass>;
export type Candidate = z.infer<typeof Candidate>;
export type Threshold = z.infer<typeof Threshold>;
export type Method = Contest['method'];
