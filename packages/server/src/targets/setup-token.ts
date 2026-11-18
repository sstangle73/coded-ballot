// Docker / Node: the setup token when the operator set none. Made once, kept in the data folder so a restart prints
// the same link, and deleted once someone has set the server up.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveSetupToken(opts: { configured?: string; dataDir: string; hasStaff: boolean }): string | undefined {
  const file = join(opts.dataDir, 'setup-token.txt');
  if (opts.hasStaff) {
    if (existsSync(file)) rmSync(file);
    return opts.configured;
  }
  if (opts.configured) return opts.configured;
  if (existsSync(file)) {
    const kept = readFileSync(file, 'utf8').trim();
    if (kept) return kept;
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
