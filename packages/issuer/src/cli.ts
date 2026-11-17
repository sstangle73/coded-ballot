#!/usr/bin/env node
// coded-ballot issuer tool. Run it on your own computer, in a folder that holds the election's files:
//   rules.yaml          the rules file
//   roll.csv            the membership roll you exported
//   roll.frozen.json    made by freeze-roll
//   issued.json         each member's copy number and ballot style (never a code)
//   packets/            the printable PDFs
// It never runs from the organisation's server, which never sees the passphrase or a code.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  closeStatement,
  deriveIssuerKeys,
  fingerprint,
  generatePassphrase,
  isValidPassphrase,
  loadRules,
  RulesError,
  signClose,
  toBase64,
  type FrozenRoll,
} from '@coded-ballot/core';
import { ask, askSecret } from './prompt.ts';
import { Server } from './server.ts';
import { addressOf, freezeRollCsv, makeBallots, reissue, type IssuedState, type PacketInfo } from './issuer.ts';
import { sendLobLetter, type LobAddress } from './lob.ts';

const HELP = `coded-ballot issuer tool

  passphrase                 make the issuer passphrase and confirm your second copy
  check-rules                check rules.yaml and print its SHA-256
  freeze-roll                check roll.csv and freeze it as roll.frozen.json
  ballots                    make codes and packets/ for everyone not yet issued
  upload                     send the frozen roll's emails, the code hashes and the signing key to the server
  reissue --member ID        replace one member's ballot (lost or spoilt) and tell the server
  email-ballots              email each member with an address their ballot sheets
  lob [--live]               send packets through Lob (test mode unless --live)
  close                      sign the close once voting has ended
  destroyed                  record that every copy of the passphrase is destroyed

Options: --dir <folder> (default: here), --server <url>, --token-file <file> (or CODED_BALLOT_TOKEN).
Make a tool token on the server's staff page, signed in with your passkey.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: '.' },
    server: { type: 'string' },
    'token-file': { type: 'string' },
    member: { type: 'string' },
    live: { type: 'boolean', default: false },
    'voting-page': { type: 'string' },
    'return-address': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const dir = resolve(values.dir!);
const file = (n: string) => join(dir, n);
const readJson = <T>(n: string): T => JSON.parse(readFileSync(file(n), 'utf8')) as T;
const writeJson = (n: string, v: unknown) => writeFileSync(file(n), JSON.stringify(v, null, 2) + '\n');

function rules() {
  try {
    return loadRules(readFileSync(file('rules.yaml'), 'utf8'));
  } catch (e) {
    if (e instanceof RulesError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

function server(): Server {
  const url = values.server ?? (existsSync(file('server.txt')) ? readFileSync(file('server.txt'), 'utf8').trim() : null);
  if (!url) throw new Error('Give --server https://... (it is remembered in server.txt).');
  writeFileSync(file('server.txt'), url + '\n');
  const tf = values['token-file'];
  const token = process.env.CODED_BALLOT_TOKEN ?? (tf ? readFileSync(tf, 'utf8').trim() : null);
  return new Server(url, token);
}

async function keys(electionId: string) {
  const p = await askSecret('Issuer passphrase (12 words): ');
  if (!isValidPassphrase(p)) throw new Error('That passphrase is not right: a word is misspelt, missing or out of order.');
  console.log('Working (this takes a second on purpose)...');
  return deriveIssuerKeys(p, electionId);
}

async function packetInfo(srv: Server, electionId: string): Promise<PacketInfo> {
  const info = await srv.call<{ countKey: { fingerprint: string } | null }>('GET', `/api/public/e/${electionId}`);
  if (!info.countKey) console.warn('Warning: no count key yet, so the fingerprint is not printed. Ask a teller to create it first.');
  return {
    votingPage: values['voting-page'] ?? `${srv.url}/vote/`,
    tracker: `${srv.url}/public/#e=${electionId}`,
    countKeyFingerprint: info.countKey?.fingerprint ?? null,
    returnAddress: (values['return-address'] ?? '').split('|').map((s) => s.trim()).filter(Boolean),
  };
}

const commands: Record<string, () => Promise<void>> = {
  async passphrase() {
    const p = generatePassphrase();
    console.log('\nYour issuer passphrase. Write it down twice, on paper, and keep the copies in two safe places:\n');
    console.log('   ' + p.split(' ').map((w, i) => `${i + 1}. ${w}`).join('   ') + '\n');
    console.log('Nothing keeps a copy. Without it there are no reissues and no signed close.');
    await ask('Press Enter when both copies are written down, then the screen check starts. ');
    console.clear();
    const words = p.split(' ');
    for (const i of [2, 8, 11]) {
      const w = await ask(`From your SECOND copy, word ${i + 1}: `);
      if (w.toLowerCase() !== words[i]) throw new Error('That word does not match. Start again with a new passphrase.');
    }
    console.log('Second copy confirmed. On the server, confirm the passphrase backup in the election set-up (or run upload).');
  },

  async 'check-rules'() {
    const { rules: r, sha256 } = rules();
    console.log(`OK: ${r.election.title} (${r.election.id}), ${r.contests.length} contests, rules SHA-256 ${sha256}`);
  },

  async 'freeze-roll'() {
    const { rules: r } = rules();
    const { frozen, problems } = freezeRollCsv(r, readFileSync(file('roll.csv'), 'utf8'));
    for (const p of problems) console.error('  problem: ' + p);
    if (problems.length) {
      console.error(`${problems.length} row(s) need fixing in roll.csv before freezing.`);
      process.exit(1);
    }
    writeJson('roll.frozen.json', frozen);
    console.log(`Frozen ${frozen.members.length} members at ${frozen.frozenAt}. Roll SHA-256 ${frozen.sha256}`);
  },

  async ballots() {
    const { rules: r } = rules();
    const frozen = readJson<FrozenRoll>('roll.frozen.json');
    const state = existsSync(file('issued.json')) ? readJson<IssuedState>('issued.json') : undefined;
    const srv = server();
    const info = await packetInfo(srv, r.election.id);
    const k = await keys(r.election.id);
    const out = await makeBallots({ rules: r, frozen, keys: k, info, state });
    mkdirSync(file('packets'), { recursive: true });
    for (const p of out.packets) writeFileSync(join(file('packets'), p.filename), p.pdf);
    if (out.packets.length) writeFileSync(join(file('packets'), `all-${new Date().toISOString().slice(0, 10)}.pdf`), out.combined);
    writeJson('issued.json', out.state);
    writeJson('upload.json', { issuerPublicKey: toBase64(k.signPublicKey), codes: out.codes });
    console.log(`Made ${out.packets.length} packets in packets/ (in roll order). Next: upload.`);
    console.log(`Signing key fingerprint: ${fingerprint(k.signPublicKey)}`);
  },

  async upload() {
    const { rules: r } = rules();
    const srv = server();
    const frozen = readJson<FrozenRoll>('roll.frozen.json');
    const id = r.election.id;
    await srv.call('POST', `/api/staff/e/${id}/roll`, {
      members: frozen.members.map((m) => ({ memberId: m.memberId, email: m.email })),
      rollSha256: frozen.sha256,
      frozenAt: frozen.frozenAt,
    });
    const up = readJson<{ issuerPublicKey: string; codes: unknown[] }>('upload.json');
    const res = await srv.call<{ issued: number }>('POST', `/api/staff/e/${id}/codes`, up);
    console.log(`Uploaded the roll (${frozen.members.length} members) and ${res.issued} code hashes.`);
    if ((await ask('Is a second copy of the passphrase written down and checked? (yes/no) ')).toLowerCase() === 'yes') {
      await srv.call('POST', `/api/staff/e/${id}/passphrase-backup`);
      console.log('Recorded on the server.');
    }
  },

  async reissue() {
    const { rules: r } = rules();
    if (!values.member) throw new Error('Give --member <member_id>.');
    const srv = server();
    const info = await packetInfo(srv, r.election.id);
    const k = await keys(r.election.id);
    const out = await reissue({ rules: r, frozen: readJson('roll.frozen.json'), keys: k, info, state: readJson('issued.json'), memberId: values.member });
    await srv.call('POST', `/api/staff/e/${r.election.id}/codes/reissue`, { revoke: out.revoke, issue: out.issue });
    writeJson('issued.json', out.state);
    mkdirSync(file('packets'), { recursive: true });
    const name = out.packet.filename.replace('.pdf', `-copy${out.state.members[values.member]!.copy}.pdf`);
    writeFileSync(join(file('packets'), name), out.packet.pdf);
    console.log(`The old ballot is cancelled. New packet: packets/${name}`);
  },

  async 'email-ballots'() {
    const { rules: r } = rules();
    console.log('Note: a ballot sent by email puts the code and the online voting link in the same inbox (see TRUST.md).');
    const host = process.env.SMTP_HOST;
    const from = process.env.MAIL_FROM;
    if (!host || !from) throw new Error('Set SMTP_HOST, SMTP_USER and MAIL_FROM; the password is asked for.');
    const pass = await askSecret('SMTP password: ');
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ host, port: Number(process.env.SMTP_PORT ?? 587), requireTLS: true, auth: { user: process.env.SMTP_USER, pass } });
    const frozen = readJson<FrozenRoll>('roll.frozen.json');
    const srv = server();
    const info = await packetInfo(srv, r.election.id);
    const k = await keys(r.election.id);
    const state = readJson<IssuedState>('issued.json');
    const { makePacket } = await import('./issuer.ts');
    let n = 0;
    for (const [i, m] of frozen.members.entries()) {
      const s = state.members[m.memberId];
      if (!m.email || !s) continue;
      const { packet } = await makePacket(r, k, m, s.copy, info, i + 1);
      await t.sendMail({
        from,
        to: m.email,
        subject: `Your ballot: ${r.election.title}`,
        text: `Your ballot for ${r.election.title} is attached. Print it, or vote online at ${info.votingPage} with the code printed on it.\n\n${r.notice_wording.report_misuse}`,
        attachments: [{ filename: 'ballot.pdf', content: Buffer.from(packet.ballotOnly) }],
      });
      n++;
    }
    console.log(`Emailed ${n} ballots.`);
  },

  async lob() {
    const { rules: r } = rules();
    const keyText = process.env.LOB_API_KEY ?? (await askSecret('Lob API key: '));
    if (values.live !== keyText.startsWith('live_')) throw new Error(values.live ? '--live needs a live_ key.' : 'Use a test_ key, or add --live to really send.');
    const from = readJson<LobAddress>('lob-from.json');
    const frozen = readJson<FrozenRoll>('roll.frozen.json');
    const srv = server();
    const info = await packetInfo(srv, r.election.id);
    const k = await keys(r.election.id);
    const state = readJson<IssuedState>('issued.json');
    const { makePacket } = await import('./issuer.ts');
    const sent: Record<string, string> = existsSync(file('lob-sent.json')) ? readJson('lob-sent.json') : {};
    for (const [i, m] of frozen.members.entries()) {
      const s = state.members[m.memberId];
      if (!s || sent[`${m.memberId}#${s.copy}`]) continue;
      const a = addressOf(m);
      const f = m.fields;
      const { packet } = await makePacket(r, k, m, s.copy, info, i + 1);
      const res = await sendLobLetter({
        apiKey: keyText,
        to: { name: a.name, address_line1: f.address_line1 ?? '', address_line2: f.address_line2, address_city: f.city ?? '', address_state: f.state ?? '', address_zip: f.zip ?? f.postcode ?? '', address_country: f.country || 'US' },
        from,
        pdf: packet.pdf,
        description: `${r.election.id} packet`,
        idempotencyKey: `${r.election.id}-${m.memberId}-${s.copy}`,
      });
      sent[`${m.memberId}#${s.copy}`] = res.id;
      writeJson('lob-sent.json', sent);
      console.log(`${m.memberId}: ${res.id}${res.url ? ' ' + res.url : ''}`);
    }
  },

  async close() {
    const { rules: r } = rules();
    const srv = server();
    const digest = await srv.call<{ count: number; sha256: string }>('GET', `/api/staff/e/${r.election.id}/close/prepare`);
    console.log(`${digest.count} locked online votes, fingerprint ${digest.sha256}`);
    const k = await keys(r.election.id);
    const st = { ...closeStatement(r.election.id, new Date(), []), lockedVotes: digest };
    await srv.call('POST', `/api/staff/e/${r.election.id}/close`, await signClose(k, st));
    console.log('Closed. Now destroy every copy of the passphrase, then run: destroyed');
  },

  async destroyed() {
    const { rules: r } = rules();
    if ((await ask('Have you destroyed every copy of the passphrase, paper and digital? (yes/no) ')).toLowerCase() !== 'yes') return;
    await server().call('POST', `/api/staff/e/${r.election.id}/key-destroyed`);
    console.log('Recorded in the public log.');
  },
};

const cmd = positionals[0];
if (values.help || !cmd || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !values.help ? 1 : 0);
}
commands[cmd]!().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
