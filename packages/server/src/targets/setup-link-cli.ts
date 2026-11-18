// `setup-link` in the Docker image (docker compose exec coded-ballot setup-link): prints the one-time setup link to
// the person at the terminal, from the same settings the server runs with. It never goes to the server's log.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteDb } from '../db/sqlite.ts';
import { setupMessage } from '../setup-link.ts';

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? './data');
const fromFile = (p?: string) => (p && existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined);
const origin = (env.PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
const dbFile = join(dataDir, 'coded-ballot.sqlite');
if (!existsSync(dbFile)) {
  console.error('The server hasn’t started yet. Start it first: docker compose up -d');
  process.exit(1);
}
const staff = await new SqliteDb(dbFile).first('SELECT id FROM staff LIMIT 1');
if (staff) {
  console.log('This server is already set up. Ask someone who runs elections on it to invite you.');
  process.exit(0);
}
const token = env.SETUP_TOKEN || fromFile(env.SETUP_TOKEN_FILE) || fromFile(join(dataDir, 'setup-token.txt'));
if (!token) {
  console.error('No setup token yet: restart the server (docker compose restart) and try again.');
  process.exit(1);
}
console.log(setupMessage(origin, token));
