// The Node target serves the pages itself; it applies the same headers Cloudflare reads from the release's _headers
// file. Only the "/*" block is used: the release has no per-path rules.
export function parseHeadersFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inAll = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inAll = raw.trim() === '/*';
      continue;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.*)$/.exec(raw);
    if (inAll && m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}
