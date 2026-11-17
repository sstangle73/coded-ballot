import { describe, expect, it } from 'vitest';
import { MemorySpendStore, SpendList } from '../src/spend.ts';

async function setup() {
  const list = new SpendList(new MemorySpendStore(), 'agm-2027');
  const a = list.hashOf('AAAAAAAAAAAAAAAA');
  const b = list.hashOf('BBBBBBBBBBBBBBBB');
  await list.issue([{ hash: a, styleId: 'full' }, { hash: b, styleId: 'associate' }]);
  return { list, a, b };
}
const t = new Date('2027-03-10T15:30:00Z');

describe('spend list', () => {
  it('first use wins across channels; later uses are rejected and logged', async () => {
    const { list, a } = await setup();
    expect(await list.spend(a, 'mail', t)).toEqual({ ok: true, styleId: 'full' });
    expect(await list.spend(a, 'online', t)).toEqual({ ok: false, reason: 'already_spent', spentBy: 'mail' });
    expect(await list.spend(a, 'in_person', t)).toMatchObject({ ok: false, reason: 'already_spent' });
    const log = await list.rejectedUses();
    expect(log.map((r) => r.channel)).toEqual(['online', 'in_person']);
    expect(log[0]!.hashPrefix).toBe(a.slice(0, 8));
  });
  it('lets only one of many simultaneous uses win', async () => {
    const { list, a } = await setup();
    const results = await Promise.all(
      (['mail', 'online', 'in_person', 'online', 'mail'] as const).map((c) => list.spend(a, c, t)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
  it('rejects unknown codes, revoked codes and a doctored style', async () => {
    const { list, a, b } = await setup();
    expect(await list.spend(list.hashOf('ZZZZZZZZZZZZZZZZ'), 'mail', t)).toEqual({ ok: false, reason: 'unknown' });
    expect(await list.revoke(b, t)).toEqual({ ok: true });
    expect(await list.spend(b, 'mail', t)).toEqual({ ok: false, reason: 'revoked' });
    expect(await list.spend(a, 'mail', t, 'associate')).toEqual({ ok: false, reason: 'wrong_style' });
    expect(await list.spend(a, 'mail', t, 'full')).toMatchObject({ ok: true });
  });
  it('will not revoke a used code', async () => {
    const { list, a } = await setup();
    await list.spend(a, 'online', t);
    expect(await list.revoke(a, t)).toEqual({ ok: false, reason: 'already_spent' });
  });
  it('shows the tracker view: dates for paper, none for online', async () => {
    const { list, a, b } = await setup();
    expect(await list.track(a)).toEqual({ status: 'not_used' });
    await list.spend(a, 'mail', t);
    expect(await list.track(a)).toEqual({ status: 'received', channel: 'mail', date: '2027-03-10' });
    await list.spend(b, 'online', t);
    expect(await list.track(b)).toEqual({ status: 'cast_online' });
    expect(await list.track('00')).toEqual({ status: 'unknown' });
  });
  it('counts by channel', async () => {
    const { list, a } = await setup();
    await list.spend(a, 'in_person', t);
    expect(await list.counts()).toEqual({ issued: 2, unused: 1, revoked: 0, spent: { mail: 0, online: 0, in_person: 1 } });
  });
  it('refuses to issue the same hash twice', async () => {
    const { list, a } = await setup();
    await expect(list.issue([{ hash: a, styleId: 'full' }])).rejects.toThrow();
  });
});
