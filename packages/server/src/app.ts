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
  // The project's own site may call the API from its origin: the voting page and checker (public routes), and the
  // issuer page (staff routes, with a bearer token handed over in the link's # part). No credentials: cookies stay
  // with this server's own pages, and staff actions with a cookie must come from this origin (requireRole).
  app.use(
    '/api/*',
    cors({ origin: [d.config.publicOrigin, ...d.config.projectOrigins], allowMethods: ['GET', 'POST'], allowHeaders: ['content-type', 'authorization'], maxAge: 600 }),
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
