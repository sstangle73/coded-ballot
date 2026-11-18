// The first person on a new server signs up with a one-time setup link. The link carries the setup token in the
// address's fragment (after #), so it never reaches the server's or a proxy's request logs.

export function setupLink(publicOrigin: string, token: string): string {
  return `${publicOrigin}/teller/#setup=${encodeURIComponent(token)}`;
}

/**
 * What the server logs while nobody has set it up. Never the link itself: logs get shipped, kept and shared, and the
 * link lets whoever opens it first take over the server. The command shows it to the person at the terminal.
 */
export function setupHint(): string {
  return [
    '',
    '  coded-ballot is ready to set up. To get the one-time setup link for the first person, run this in the folder',
    '  you started it from:',
    '',
    '    docker compose exec coded-ballot setup-link',
    '',
  ].join('\n');
}

/** What `setup-link` prints: plain words for whoever installed the server. */
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
