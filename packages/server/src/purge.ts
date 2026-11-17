// The retention purge: when an election's retention period after certification ends, its codes, voters, locked
// votes, paper records and images are destroyed, and the public log records what went. Results, the teller report
// and the log stay.
import type { Deps } from './context.ts';
import { logStmt } from './store.ts';

const TABLES = ['codes', 'voters', 'voter_links', 'locked_votes', 'paper_records', 'hand_counts', 'rejected_uses', 'roll_changes', 'fallback_close_approvals', 'tamper_checks'];

export async function purgeDue(d: Deps): Promise<string[]> {
  const now = d.now();
  const rows = await d.db.all<{ id: string; rules_yaml: string; certified_at: string }>(
    "SELECT id, rules_yaml, certified_at FROM elections WHERE status = 'certified'",
  );
  const purged: string[] = [];
  const { loadRules } = await import('@coded-ballot/core');
  for (const r of rows) {
    const days = loadRules(r.rules_yaml).rules.retention_days;
    if (Date.parse(r.certified_at) + days * 86_400_000 > now.getTime()) continue;
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      counts[t] = (await d.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE election_id = ?`, [r.id]))!.n;
    }
    counts.images = await d.blobs.deletePrefix(`${r.id}/`);
    await d.db.batch([
      ...TABLES.map((t) => ({ sql: `DELETE FROM ${t} WHERE election_id = ?`, params: [r.id] })),
      { sql: "UPDATE elections SET status = 'purged', purged_at = ? WHERE id = ?", params: [now.toISOString(), r.id] },
      logStmt(r.id, now, 'purged', { retentionDays: days, destroyed: counts }),
    ]);
    purged.push(r.id);
  }
  // housekeeping for sign-in
  await d.db.run('DELETE FROM challenges WHERE expires_at < ?', [now.toISOString()]);
  await d.db.run('DELETE FROM sessions WHERE expires_at < ?', [now.toISOString()]);
  await d.db.run('DELETE FROM api_tokens WHERE expires_at < ?', [now.toISOString()]);
  return purged;
}
