import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupLink, setupMessage } from '../src/setup-link.ts';
import { resolveSetupToken } from '../src/targets/setup-token.ts';

describe('the setup link', () => {
  it('carries the token in the fragment, so no request log sees it', () => {
    const link = setupLink('https://ballot.example.org', 'a+b/c');
    expect(link).toBe('https://ballot.example.org/teller/#setup=a%2Bb%2Fc');
    expect(new URL(link).search).toBe('');
  });

  it('is printed with plain words', () => {
    const m = setupMessage('https://ballot.example.org', 'tok');
    expect(m).toContain('https://ballot.example.org/teller/#setup=tok');
    expect(m).toMatch(/works once/);
  });
});

describe('the Docker setup token', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'cb-setup-'));

  it('is made once and kept across restarts while nobody has set the server up', () => {
    const d = dir();
    const a = resolveSetupToken({ dataDir: d, hasStaff: false })!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(resolveSetupToken({ dataDir: d, hasStaff: false })).toBe(a);
    expect(readFileSync(join(d, 'setup-token.txt'), 'utf8').trim()).toBe(a);
    if (process.platform !== 'win32') expect(statSync(join(d, 'setup-token.txt')).mode & 0o777).toBe(0o600);
  });

  it('is deleted once someone has set it up', () => {
    const d = dir();
    resolveSetupToken({ dataDir: d, hasStaff: false });
    expect(resolveSetupToken({ dataDir: d, hasStaff: true })).toBeUndefined();
    expect(existsSync(join(d, 'setup-token.txt'))).toBe(false);
  });

  it('uses the one the operator set, and makes no file', () => {
    const d = dir();
    expect(resolveSetupToken({ configured: 'mine', dataDir: d, hasStaff: false })).toBe('mine');
    expect(existsSync(join(d, 'setup-token.txt'))).toBe(false);
  });
});

describe('the server log', () => {
  it('says how to get the link but never shows it', async () => {
    const { setupHint } = await import('../src/setup-link.ts');
    expect(setupHint()).toContain('docker compose exec coded-ballot setup-link');
    expect(setupHint()).not.toContain('#setup=');
  });
});
