import { $, fragmentParams, h, show, status } from '../shared/ui.ts';
import { compareRelease, type Manifest } from '../shared/release.ts';

const input = $('#server') as HTMLInputElement;
const s = fragmentParams().get('s');
if (s) input.value = s;

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#out');
  show(out, status('info', 'Checking…'));
  try {
    const manifest = (await (await fetch('../release-hashes.json', { cache: 'no-store' })).json()) as Manifest;
    const r = await compareRelease(input.value, manifest);
    show(
      out,
      r.ok ? status('ok', `Every file of the voting page matches coded-ballot ${manifest.version}.`) : status('bad', 'The voting page does NOT match the published release. Don’t vote there: tell the tellers, and vote from this site’s copy or on paper.'),
      h('table', {}, h('tbody', {}, ...r.files.map((f) => h('tr', {}, h('td', {}, f.ok ? '✓ same' : '✗ different'), h('td', { class: 'small' }, f.path))))),
    );
  } catch (err) {
    show(out, status('bad', (err as Error).message));
  }
});
