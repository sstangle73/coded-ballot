// Cloudflare Workers target: D1 for the database, R2 for images, static assets for the pages, a cron trigger for
// the retention purge, and SES's HTTPS API for mail.
import { createApp } from '../app.ts';
import { D1Db, R2Blobs } from '../db/d1.ts';
import { MemoryMailer, type Mailer } from '../mail/types.ts';
import { SesApiMailer } from '../mail/ses.ts';
import { purgeDue } from '../purge.ts';
import { configFromEnv } from './config.ts';
import type { Deps } from '../context.ts';

export interface WorkerEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS?: Fetcher;
  [k: string]: unknown;
}

let memoryMailer: MemoryMailer | undefined;

function depsFor(env: WorkerEnv): Deps {
  const s = env as unknown as Record<string, string | undefined>;
  let mailer: Mailer;
  if (s.SES_KEY_ID && s.SES_SECRET && s.MAIL_FROM) {
    mailer = new SesApiMailer({ accessKeyId: s.SES_KEY_ID, secretAccessKey: s.SES_SECRET, region: s.SES_REGION ?? 'us-east-1', from: s.MAIL_FROM });
  } else mailer = memoryMailer ??= new MemoryMailer();
  return { db: new D1Db(env.DB), blobs: new R2Blobs(env.BLOBS), mailer, config: configFromEnv(s), now: () => new Date() };
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || !env.ASSETS) return createApp(depsFor(env)).fetch(req, env, ctx);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_e: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(purgeDue(depsFor(env)).then((ids) => void (ids.length && console.log('purged', ids))));
  },
} satisfies ExportedHandler<WorkerEnv>;
