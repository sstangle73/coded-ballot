// Docker / Node target: SQLite and a directory on local disk, SMTP for mail, an hourly retention purge.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { DiskBlobs, SqliteDb } from '../db/sqlite.ts';
import { MemoryMailer, type Mailer } from '../mail/types.ts';
import { SmtpMailer } from '../mail/smtp.ts';
import { purgeDue } from '../purge.ts';
import { configFromEnv } from './config.ts';
import { parseHeadersFile } from '../static-headers.ts';
import { existsSync } from 'node:fs';
import { resolveSetupToken } from './setup-token.ts';
import { setupHint } from '../setup-link.ts';

const env = process.env;
const secret = (name: string) => env[name] ?? (env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : undefined);

const dataDir = resolve(env.DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });
const db = new SqliteDb(join(dataDir, 'coded-ballot.sqlite'));
const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));
const applied = await db.migrate(migrations);
if (applied.length) console.log('applied migrations', applied.join(', '));

let mailer: Mailer;
if (env.SMTP_HOST && env.MAIL_FROM) {
  mailer = new SmtpMailer({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), user: env.SMTP_USER, pass: secret('SMTP_PASS'), from: env.MAIL_FROM });
} else {
  console.warn('No SMTP_HOST/MAIL_FROM: email is kept in memory, not sent.');
  mailer = new MemoryMailer();
}
const hasStaff = (await db.first('SELECT id FROM staff LIMIT 1')) !== null;
const setupToken = resolveSetupToken({ configured: secret('SETUP_TOKEN'), dataDir, hasStaff });
const config = { ...configFromEnv({ ...env, SETUP_TOKEN: setupToken }) };
if (!hasStaff && setupToken) console.log(setupHint());
const deps = { db, blobs: new DiskBlobs(join(dataDir, 'blobs')), mailer, config, now: () => new Date() };
const app = createApp(deps);
const staticDir = env.STATIC_DIR;
if (staticDir) {
  const headersFile = join(staticDir, '_headers');
  const pageHeaders = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : {};
  app.get('/_headers', (c) => c.notFound());
  app.use('/*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/api/')) for (const [k, v] of Object.entries(pageHeaders)) c.res.headers.set(k, v);
  });
  app.use('/*', serveStatic({ root: staticDir }));
  for (const page of ['vote', 'teller', 'public', 'check']) app.get(`/${page}`, (c) => c.redirect(`/${page}/`));
}

setInterval(() => purgeDue(deps).then((ids) => ids.length && console.log('purged', ids), (e) => console.error('purge failed', e)), 3600_000);

const port = Number(env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: env.HOST ?? '0.0.0.0' }, (i) => console.log(`coded-ballot listening on ${i.port}, public origin ${config.publicOrigin}`));
