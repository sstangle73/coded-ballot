# coded-ballot

An open source election system for member organisations (clubs, nonprofits, HOAs, union locals) run by volunteer
tellers. Each member gets **one ballot with a unique code**, usable once: by post, online, or in person. The first use
counts; copies and second votes are turned away.

**Read [TRUST.md](TRUST.md) first.** It says who you have to trust and what this design does not protect against.
coded-ballot is sized for clubs and nonprofits, **not for public elections**, and it is not certified for anything.

## Is it allowed?

Whether your organisation may vote by post, online or with coded ballots depends on its bylaws (or constitution) and
on the law where it is incorporated. Many nonprofit and corporation statutes allow ballots by mail or electronic means
only if the bylaws say so, and some set notice periods, quorum rules or proxy rules that the rules file must match.
Check before you use it. This project gives no legal advice and makes no legal claims.

## How an election runs

1. **Set-up.** The issuer writes a rules file (dates, channels, who votes on what, the counting method for each
   contest), freezes the roll, and makes a 12-word passphrase with the issuer tool. A teller makes the count key on
   their own device; only its public half goes to the server.
2. **Ballots.** The issuer tool prints a packet for each member: a cover letter with their address, and ballot sheets
   with a QR code and a typed code but no name. Packets can be printed at home, emailed, or sent through Lob.
3. **Voting.** A member votes once, any one way:
   - **by post:** the folded ballot is scanned on arrival by its QR code, without being opened;
   - **online:** a link sent to the member's email plus the code on their ballot. The vote is locked in their browser
     with the count key before it is sent;
   - **in person:** the ballot goes in the box at the meeting.

   Anyone can check on the public page that their code was used, and how.
4. **Close.** The issuer signs the close (the list of locked online votes) and destroys the passphrase. If it's lost,
   two tellers can sign a fallback close, which is marked as one everywhere.
5. **Count.** On a teller's device: check the close, unlock the online votes, read the paper (scanner or phone camera),
   rule on anything unclear, hand-count the paper, and count. A hand count that disagrees blocks certification. Ties
   are drawn from public randomness (drand) that anyone can check.
6. **Publish.** The results, a step-by-step explanation of every count, the teller report and the count key, so anyone
   can recount the online votes in their browser.

The design is in [DESIGN.md](DESIGN.md), with diagrams in [docs/design.html](docs/design.html).

## The parts

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | The TypeScript core every part shares: rules and their schema, the roll, ballot styles, codes, the signed close, the spend list, ballot layout, sealing votes, reading marks from images, and the counting modules (plurality, approval, yes/no with any threshold, IRV, Scottish STV, all with weights) with plain-language explanations. |
| [`packages/server`](packages/server) | One server app, two ways to run it: Cloudflare Workers (D1, R2) or Docker (Node, SQLite, a folder on disk). |
| [`packages/issuer`](packages/issuer) | The issuer tool, run on the issuer's own computer: passphrase, roll, codes, printable packets, Lob, reissues, the signed close. |
| [`packages/web`](packages/web) | The pages: the voting page, the tellers' app (an installable web app), the public page with the ballot tracker, and the member checker. |

## Try it

Needs Node 22.12 or later.

```bash
npm install
npm test
npm run demo
```

The demo runs a whole election on your computer at `http://localhost:8787`, open for voting now. It prints every
member's code, the voting page, the public page, and a sign-in link for a teller (demo only: a real server uses
passkeys). Email goes to `http://localhost:8787/api/dev/outbox` instead of being sent. To try the count, give voting a
short window and sign the close when it ends:

```bash
DEMO_CLOSE_MINUTES=5 npm run demo
curl -X POST http://localhost:8787/demo/close
```

The demo also prints ballots for four members as PDFs, to mark and scan: see
[docs/scanning-tests.md](docs/scanning-tests.md).

An example rules file is in [examples/rules.example.yaml](examples/rules.example.yaml) and its schema in
[schemas/rules.schema.json](schemas/rules.schema.json).

## Running it for an election

The server needs HTTPS: passkeys and the camera only work on a secure origin.

### Cloudflare Workers

Copy [`packages/server/wrangler.jsonc`](packages/server/wrangler.jsonc), set your names, then follow the commands at
the top of that file: create the D1 database and R2 bucket, apply the migrations, set the mail secrets (`SES_KEY_ID`
and `SES_SECRET` for Amazon SES), build the pages and deploy. Then make the setup link (see *First steps* below):

```bash
npm run build -w @coded-ballot/web
npx wrangler deploy -c packages/server/wrangler.jsonc
npm run setup-link -w @coded-ballot/server -- -c packages/server/wrangler.jsonc
```

### Docker

[`compose.yaml`](compose.yaml) runs the image built from the [`Dockerfile`](Dockerfile), with data in a volume and
the mail password in a file beside it (`smtp_pass.txt`). Put it behind your reverse proxy with HTTPS and set
`PUBLIC_ORIGIN` to its address. Then get the setup link (see *First steps* below):

```bash
docker compose up -d --build
docker compose exec coded-ballot setup-link
```

### Settings

| Variable | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | The server's own address, like `https://ballot.example.org`. Passkeys are tied to it. |
| `PROJECT_ORIGINS` | Comma-separated origins allowed to call the public API: the project site's voting page and member checker. |
| `VOTING_PAGE_URL` | Where voting links point. Empty means this server's own `/vote/` page. |
| `SETUP_TOKEN` (or `SETUP_TOKEN_FILE`) | Optional on Docker: the one-time token in the setup link. Without it, Docker makes one and keeps it in the data folder until someone has set the server up. On Workers, `npm run setup-link` sets it. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (or `_FILE`), `MAIL_FROM` | Mail on Docker. |
| `SES_KEY_ID`, `SES_SECRET`, `SES_REGION`, `MAIL_FROM` | Mail on Workers, through Amazon SES. |

### First steps on a new server

1. Open the **setup link**. On Docker, `docker compose exec coded-ballot setup-link` prints it (the server's log says
   so until someone has set it up, but never shows the link: logs get shipped and kept); on Workers,
   `npm run setup-link` prints it. It looks like `https://ballot.example.org/teller/#setup=...` and works
   once, for the first person, so send it privately to whoever will run your elections. They enter their name and
   email and make a passkey (their fingerprint, face or screen lock; no password). They are then the issuer and a
   teller, and invite the other tellers from the same page. (With only the token, "First time on this server? Set it
   up" on `/teller/` takes it typed in.)
2. In the tellers' app, signed in as the issuer, make a tool token for the issuer tool. On the issuer's own computer,
   run the issuer tool: `npx coded-ballot-issuer --help`.

## The project site

The project's own copy of the voting page and the member checker are published on GitHub Pages from the GitHub mirror
by [`.github/workflows/pages.yml`](.github/workflows/pages.yml), with `release-hashes.json`: the SHA-256 of every
file. Members can vote from that copy, which only ever locks their vote with the count key printed on their ballot, or
use the checker to compare their organisation's voting page with the release. Organisations list the project site in
`PROJECT_ORIGINS`.

## Accessibility

The pages aim for WCAG 2.1 AA and pass axe-core's checks for it in light and dark mode. Colour is never the only
signal: every status pairs its colour with a glyph and a word (✓ OK, ▲ Check, ✗ Problem), and the palette is chosen
to stay distinct for colour-blind readers. Ballots come in a large-print style.

## Security

Found a problem? Please report it privately: see [SECURITY.md](SECURITY.md).

## Licence

[AGPL-3.0-only](LICENSE). If you change coded-ballot and let people use it over a network, you must offer them your
changed source.

## Support

This is free and staying that way. If it's useful to you, you can [buy me a coffee](https://buymeacoffee.com/stevenstorie).

Built by [Steven Storie](https://gitlab.com/sstangle73).
