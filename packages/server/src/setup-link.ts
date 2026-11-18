// The first person on a new server signs up with a one-time setup link. The link carries the setup token in the
// address's fragment (after #), so it never reaches the server's or a proxy's request logs.

export function setupLink(publicOrigin: string, token: string): string {
  return `${publicOrigin}/teller/#setup=${encodeURIComponent(token)}`;
}

/** What the server prints while nobody has set it up: plain words for whoever installed it. */
export function setupMessage(publicOrigin: string, token: string): string {
  return [
    '',
    '  coded-ballot is ready to set up.',
    '  Open this link (or send it, privately, to the person who will run your elections). The first person to open',
    '  it becomes the issuer and a teller, and invites everyone else. It works once.',
    '',
    `    ${setupLink(publicOrigin, token)}`,
    '',
  ].join('\n');
}
