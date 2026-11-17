// Compare an organisation's live voting page with the published release, file by file. Used by the member checker
// (from the project's own site) and by the tellers' app (from the teller's own device).
import { sha256Hex } from '@coded-ballot/core';

export interface Manifest {
  version: string;
  files: Record<string, string>;
}

export interface Comparison {
  ok: boolean;
  files: { path: string; ok: boolean; got?: string }[];
}

export async function compareRelease(server: string, manifest: Manifest): Promise<Comparison> {
  const base = new URL(server.trim()).origin;
  const files: Comparison['files'] = [];
  const fetchHash = async (path: string) => {
    const res = await fetch(`${base}/${path}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, hash: sha256Hex(bytes) };
  };
  let page;
  try {
    page = await fetchHash('vote/index.html');
  } catch (e) {
    throw new Error(`Couldn't download the voting page from ${base} (${(e as Error).message}). The server may not allow this check.`);
  }
  files.push({ path: 'vote/index.html', ok: page.hash === manifest.files['vote/index.html'], got: page.hash });
  const html = new TextDecoder().decode(page.bytes);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((r) => !/^(https?:|data:|#|mailto:)/.test(r));
  for (const ref of new Set(refs)) {
    const path = new URL(ref, `${base}/vote/`).pathname.replace(/^\//, '');
    if (!(path in manifest.files)) {
      if (/\.(js|css|mjs|wasm)$/.test(path)) files.push({ path, ok: false });
      continue;
    }
    try {
      const f = await fetchHash(path);
      files.push({ path, ok: f.hash === manifest.files[path], got: f.hash });
    } catch {
      files.push({ path, ok: false });
    }
  }
  return { ok: files.every((f) => f.ok), files };
}
