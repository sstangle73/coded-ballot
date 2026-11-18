// Cloudflare Workers: make the one-time setup link for a new server. It makes a setup token, stores it as the
// Worker's SETUP_TOKEN secret (wrangler reads it from stdin, so it is never on a command line) and prints the link
// for the first person to open. Run it once, after the first deploy:
//   npm run setup-link -w @coded-ballot/server -- -c packages/server/wrangler.jsonc
// Running it again replaces the token, so an earlier link stops working. (Docker prints its link itself at start.)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setupMessage } from '../src/setup-link.ts';

const args = process.argv.slice(2);
const at = args.indexOf('-c');
// npm runs this in packages/server; a path given is read from where npm was started (INIT_CWD)
const given = at >= 0 ? args[at + 1] : undefined;
const configPath = given ? resolve(process.env.INIT_CWD ?? process.cwd(), given) : resolve('wrangler.jsonc');
let origin = args.includes('--origin') ? args[args.indexOf('--origin') + 1] : undefined;
if (!origin) {
  // wrangler.jsonc: drop whole-line // comments (a URL's // stays), then it is JSON
  const text = readFileSync(configPath, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  origin = (JSON.parse(text).vars ?? {}).PUBLIC_ORIGIN;
}
origin = (origin ?? '').replace(/\/$/, '');
if (!/^https:\/\/[^/]+$/.test(origin)) {
  console.error(`Set vars.PUBLIC_ORIGIN in ${configPath} to the server's https address first (or pass --origin).`);
  process.exit(2);
}

const token = randomBytes(24).toString('base64url');
const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const r = spawnSync(process.execPath, [wrangler, 'secret', 'put', 'SETUP_TOKEN', '-c', configPath], {
  input: token,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (r.status !== 0) {
  console.error('wrangler could not set SETUP_TOKEN, so no link was made.');
  process.exit(r.status ?? 1);
}
console.log(setupMessage(origin, token));
