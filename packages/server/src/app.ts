// The one Hono app both targets run.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Deps, Env } from './context.ts';
import { auth, loadStaff } from './routes/auth.ts';
import { staff } from './routes/staff.ts';
import { pub } from './routes/public.ts';
import { MemoryMailer } from './mail/types.ts';

export const VERSION = '0.1.0';

export function createApp(d: Deps) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('deps', d);
    await next();
  });
  app.use('*', secureHeaders({ referrerPolicy: 'no-referrer', crossOriginResourcePolicy: false }));
  // Public and voting routes: the project's own voting page and checker may call these from their origin.
  app.use(
    '/api/public/*',
    cors({ origin: [d.config.publicOrigin, ...d.config.projectOrigins], allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'], maxAge: 600 }),
  );
  app.use('/api/*', loadStaff);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  });
  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  app.route('/api/auth', auth);
  app.route('/api/staff', staff);
  app.route('/api/public', pub);
  if (d.config.devOutbox && d.mailer instanceof MemoryMailer) {
    const m = d.mailer;
    app.get('/api/dev/outbox', (c) => c.json({ sent: m.sent }));
  }
  return app;
}
