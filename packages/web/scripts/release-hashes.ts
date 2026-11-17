// After the build: the SHA-256 of every file the pages load, published with the release as dist/release-hashes.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f !== 'release-hashes.json') files[relative(dist, p).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
};
walk(dist);
writeFileSync(join(dist, 'release-hashes.json'), JSON.stringify({ version: pkg.version, files }, null, 2) + '\n');
console.log(`release-hashes.json: ${Object.keys(files).length} files`);
