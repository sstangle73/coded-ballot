import type { Config } from '../context.ts';

/** Settings from environment variables, the same names on both targets. */
export function configFromEnv(env: Record<string, string | undefined>): Config {
  const publicOrigin = (env.PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
  if (!/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be like https://ballot.example.org');
  return {
    publicOrigin,
    rpId: env.RP_ID || new URL(publicOrigin).hostname,
    rpName: env.RP_NAME || 'coded-ballot',
    projectOrigins: (env.PROJECT_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    votingPageUrl: env.VOTING_PAGE_URL || `${publicOrigin}/vote/`,
    setupToken: env.SETUP_TOKEN || undefined,
    devOutbox: env.DEV_OUTBOX === '1',
  };
}
