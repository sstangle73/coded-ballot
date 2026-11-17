// The opt-in time-lock (tlock-js, drand quicknet). The chain hash and public key are constants in the release, and
// tlock-js's client checks every beacon against them.
import { Buffer, defaultChainInfo, mainnetClient, timelockDecrypt, timelockEncrypt } from 'tlock-js';
import { DRAND_QUICKNET, firstRoundAfter } from '@coded-ballot/core';

function client() {
  if (defaultChainInfo.hash !== DRAND_QUICKNET.chainHash || defaultChainInfo.public_key !== DRAND_QUICKNET.publicKey) {
    throw new Error('This release’s drand chain does not match tlock-js; refusing to time-lock.');
  }
  return mainnetClient();
}

/** The round a vote is locked to: the first one published after the closing time. */
export function closeRound(votingClosesIso: string): number {
  return firstRoundAfter(Math.floor(Date.parse(votingClosesIso) / 1000));
}

export async function tlockEncrypt(round: number, bytes: Uint8Array): Promise<string> {
  return timelockEncrypt(round, Buffer.from(bytes), client());
}

export async function tlockDecrypt(armored: string): Promise<Uint8Array> {
  return new Uint8Array(await timelockDecrypt(armored, client()));
}
