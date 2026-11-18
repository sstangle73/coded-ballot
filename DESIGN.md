# coded-ballot design

An open source election system for member organisations (clubs, nonprofits, HOAs, union locals) run by volunteer tellers. Each member gets **one ballot with a unique code**. The code can be used once: by mail, online, or by dropping the ballot in the box in person. The first use counts, and copies (photocopies, home-printed PDFs, forwarded emails) are harmless.

It is sized for clubs and nonprofits, **not high-stakes public elections**. [TRUST.md](TRUST.md) says plainly what must be trusted and what the design does not protect against.

The visual version of this document, with diagrams and a technical or plain-language switch, is [docs/design.html](docs/design.html).

Status: design agreed 2026-11-16. Building started 2026-11-16: the core library (`packages/core`) is the first milestone. Decisions made while building are in section 15.

## 1. Roles

| Role | Does | Notes |
|---|---|---|
| **Member** | Votes once, by mail, online or in person | Holds one coded ballot |
| **Issuer** | Generates codes, prints and mails ballots, reissues lost ones, signs the close | Holds the issuer passphrase until close |
| **Teller** | Creates the count key, scans and counts paper, rules on unclear marks, unlocks online votes at the count, certifies | Holds the count key |
| **Operator** | Runs the server | Optional third person |

Roles are an election setting:
- **One-person mode:** the issuer and the teller are the same person. The close gate and the public log are guardrails, not a lock, unless the time-lock is on.
- **Separated mode:** the issuer never holds the count key.

## 2. Codes and ballots

- **Code derivation:**
  - The issuer page (or the command-line issuer tool) generates the passphrase: 12 BIP39 words (128 bits plus a checksum that catches a mistyped word). The issuer never makes one up.
  - `master = Argon2id(passphrase, salt from the election ID)` (libsodium), so guessing it is slow as well as hopeless.
  - `K = HKDF(master)`, with separate labels for the code key and the signing key (Ed25519).
  - `S = HMAC(K_code, election ‖ member_id ‖ n)`, with each field length-prefixed, cut to 80 bits, where `n` is the issue number (copy 1, 2, ...).
  - The typed code is 16 Crockford base32 characters in groups of four plus a check character, e.g. `Y6VY-PMD5-R82Z-EKPW-V`.
  - No member-to-code list is ever stored.
- **Generation:** codes are generated in the issuer's own browser, on the **issuer page served from the project site** (or by the command-line issuer tool on the issuer's computer), never from pages served by the organisation's server. The server receives only `hash(S)` and the ballot style for each code.
  - The tellers' app opens the issuer page with `#s=<server>&e=<election>&c=<code>`. The `#` part never reaches the project site. The code works once, within two minutes: the page trades it for a 12-hour token that works only for the issuer's routes and lives only in the tab's memory, so browser history keeps nothing usable. Signing out on the page ends that token; signing out of the tellers' app ends them all.
  - A link can name any server, and a fake one could show the real election and ask for a signed close. So the page shows the server's address and asks the issuer to confirm it is their organisation's before anything else.
  - The server allows CORS from `PROJECT_ORIGINS` for the bearer header, never with credentials; staff actions with a cookie must still come from the server's own origin.
  - The issuer page keeps no file: it finds each member's current copy by deriving their code hashes and looking them up in the server's list of hashes (which carries no state, so it doesn't say who has voted). It checks the roll file against the roll fingerprint the server froze, and the passphrase against the published signing key.
  - The copy of the issuer page on an organisation's own server refuses to run (except on `localhost`, for testing).
- **The ballot sheet:**
  - shows a QR code (election, style, S, page) and a typed code, and never the member's name
  - has four corner fiducials and large ovals, or a rank grid for ranked contests
  - shows the count key's fingerprint
- **The fold:** the QR code prints on the **outside panel of the folded sheet**, so it can be scanned without unfolding.
- **Ballot styles:** one per membership class (a class that votes on fewer questions gets a shorter ballot), plus large print and provisional.
- **Reissue:** recompute copy `n`, revoke its hash, and issue copy `n+1`. The public log shows only a count of reissues.
- **Passphrase backup:** a confirmed second copy is required before voting opens.

## 3. Channels

| Channel | What spends the code | When |
|---|---|---|
| ✉ Mail | Tellers scan the QR code on the outside of the folded sheet as the envelope arrives, without unfolding it | On receipt. The folded sheet goes unread into a sealed box until the count |
| ⌨ Online | One-time email link plus the code | At submission |
| ▣ In person | The sheet is scanned as it goes into the box. A member who forgot their ballot gets one reissued on the spot | At the drop |

Return envelopes are plain and pre-addressed, printed with "Don't write your name or address".

### Spend list

- **States:** `issued → spent(channel, time)`, `issued → revoked`, `issued → unused at close`.
- **Spending is an atomic compare-and-set:** `UPDATE … SET state='spent' … WHERE hash=? AND state='issued'`.
- **First use wins.** Any later use is rejected and logged for the tellers. Changing a vote is impossible by design, because votes are stored without codes.

### Online second factor

- **The flow:** the member asks for a one-time link, which goes to the email on the **roll, frozen at the notice date**. The link opens the voting page, and the member enters their code and choices.
- **In one transaction**, the server marks the link used (one per member), spends the code, and stores the locked choice apart from both.
- **Roll changes** after the notice date are listed in the teller report, and the old address is notified.
- **Members with no email** on file vote by mail or in person.

## 4. Keeping online votes private

- **Count key:**
  - A teller creates it in the teller app before voting opens. The browser makes an X25519 key pair, uploads the public half, and shows the private half as a printable QR code or passphrase.
  - Voting won't open until a second copy is confirmed.
  - The key's **fingerprint is printed on every ballot sheet** and in the election notice.
- **Online votes:**
  - Each choice is encrypted in the voter's browser to the count key (a libsodium sealed box).
  - Choices are stored with no code and no timestamp, in shuffled batches.
  - The app logs no IP addresses.
- **Time-lock (opt-in):** each online vote is also wrapped in a drand time-lock (`tlock-js`, Apache-2.0 or MIT, v0.9.0) tied to the round at the close time. Nobody can unlock it before that round is published. The drand chain hash is a constant built into the release.
- **Bring your own voting page:**
  - The voting page is also a static release, on the project's own site and as a download.
  - The election link carries the server URL and election ID after the `#`.
  - The organisation's server allows CORS from the project site.
  - The project's copy shows the count key fingerprint and refuses to vote unless it matches the one printed on the ballot.

## 5. Close and count

1. **Signed close:** the issuer key's last act. The signing key (from the same passphrase) signs the close time and the SHA-256 of the full list of locked votes. The server publishes the statement, and then the passphrase is destroyed.
   - If every copy of the passphrase is lost, the tellers sign a **fallback close**, which the public log marks as a fallback.
2. **Server gate:** the server won't hand out locked votes before a valid close, and every download attempt goes in the public log.
3. **Unlock:** the teller app checks the downloaded list against the signed fingerprint. If the time-lock is on, it fetches the drand round, removes the time-lock layer, and then unlocks with the count key, all on the teller's laptop.
4. **Paper:** the box is opened and the ballots are scanned. Mark reading produces cast vote records, and unclear marks go to adjudication (section 7).
5. **Hand count:** the tellers hand-count all paper and enter their totals. A mismatch with the app's count blocks certification.
6. **Ties by lot:** drawn from the first drand round published after close, so anyone can repeat the draw.
7. **Certify and publish:** the results, the teller report (rules file SHA-256 and software version, reissue count, rejected uses, roll changes, tamper-check log, key-destruction time), and the **count key's private half**, so anyone can recount the online votes.
8. **Purge:** ballots, images and data are purged when the retention period ends, with a log of what was destroyed.

**Provisional ballots:** disputed members get a provisional style. Those ballots are kept as a sealed batch and counted only if the tellers uphold eligibility; otherwise they're destroyed unread.

**Runoffs:** "Clone as runoff" copies the roll and rules into a new election with fresh codes. The docs point out that ranked choice (IRV) is an instant runoff.

## 6. Rules

- **Settings:** a YAML rules file checked against a published schema. It covers deadlines, which channels are allowed, eligibility by class, seats, write-ins, quorum, thresholds, tie-break order, retention and notice wording. The schema grows by release.
- **Modules:** behaviour lives in reviewed code modules, each with its own tests. Organisations don't write scripts.
  - `count(records, contest) → result + plain-language step-by-step explanation`
  - `eligible(member, contest) → weight`
  - `layout(contest) → ballot regions`
- **First-version counting:** plurality (single and multi-seat), yes/no with any threshold, approval, ranked choice (IRV and STV), and weighted votes (per unit or share). STV follows the Scottish rules (SSI 2007/42, Schedule 1, rules 45 to 52): Droop quota, weighted inclusive Gregory transfers to five decimal places.
- **Rules the design can't offer:**
  - changing a vote after casting it
  - enforced proxy limits
- **Later:** a recorded (named) vote mode.

## 7. Scanning

- **Two ways in, one pipeline:** a phone-camera PWA, and a watched folder for flatbed or sheet-feeder scans (the same TypeScript core run as a Node CLI).
- **Steps:** find the fiducials, correct the perspective, decode the QR code, and sample each oval's fill (OpenCV.js or WASM).
- **Adjudication:** marks between the two thresholds, overvotes, write-ins and rank-grid errors go to a teller queue with the image.
- **Records:** each ballot yields a cast vote record plus a SHA-256 of its image.
- **Prior art:** OMRChecker (MIT). The VxSuite interpreter is GPL-3.0-only, so read it but don't copy it.

## 8. Public page

- A ballot tracker: enter your code and see "received by mail on [date]" or "cast online".
- Counts received by channel.
- Results and the teller report, after certification.
- A small-group warning: if a style or weight group has fewer than about 5 ballots, publish only combined totals for the shared questions.

## 9. Tamper checks

- **Releases** are built reproducibly and publish the SHA-256 of every file the voting page loads.
- **The tellers' app** fetches the live voting page from the teller's own device at intervals during voting, compares it with the release, and logs every result in the teller report.
- **The member checker** is a static page on the **project's own site**, not the organisation's. It fetches the voting page from the member's browser and compares the hashes. A hash shown on the voting page itself proves nothing.

## 10. Mailing

- **Small-organisation default:** print-at-home packets, with per-member PDFs in mailing order, a #10 window envelope, the ballot folded with the QR code outside, and a #9 return envelope stamped by the organisation. About $90 for 50 members at the $0.82 stamp price (USPS, from 4 Oct 2026).
- **Mail API adapter** (Lob, PostGrid) for larger organisations: about $1.16–$1.21 per packet. Neither vendor prepays return postage at small scale. Business Reply Mail only beats stamping every envelope at thousands of members.

## 11. Accessibility

Voting and teller pages meet WCAG 2.1 AA, with a large-print ballot style and online voting as an alternative to paper. The colours are colour-blind safe and always paired with glyphs or labels.

## 12. Stack and hosting

- **Code:** a TypeScript core (rules, codes, mark reading, tally) shared by every target.
- **Two deployment targets, both in the first version:**
  - **Cloudflare:** Workers, D1, R2, and Access for tellers.
  - **Docker:** Node, SQLite, local disk.
- **One web framework for both:** Hono (its own docs cover Workers and Node, the latter through `@hono/node-server`; checked 2026-11-16). D1 is SQLite underneath, so one schema serves both.
- **CI** tests both targets.
- **Hosting:** voter-facing parts run on reliable hosting, not a home connection.
- **Licence:** AGPL-3.0.
- **README:** tells each organisation to check its own rules and law. The project makes no legal claims.

## 13. Scope

**First version:**
- roll import (CSV) with classes, frozen at the notice date
- the rules file and the five counting modules
- the issuer page on the project site, and the local issuer tool (codes, PDFs, email, mail API adapter, reissue, signed close)
- online voting (email link and code), the count key, and the opt-in time-lock
- the project-hosted and downloadable voting page
- the teller PWA (receipt scan, count scan, adjudication, hand-count entry, count-key unlock)
- the public page, tamper checks and the member checker
- everything in the practical safeguards: the outside-fold QR code, provisional ballots, the published count key, the passphrase backup and fallback close, the drand lot, accessibility, clone as runoff, and the README legal note
- the retention purge

**Later:**
- a split count key (any 2 of 3 tellers)
- more counting modules (Condorcet, score, cumulative)
- a recorded-vote mode
- sampled audits for large organisations
- a hosted service for many organisations

**Ruled out:** ElectionGuard, blind signatures, a home-made cryptographic protocol, and no-key mode (reissue is required).

## 14. To verify before relying on it

Checked 2026-11-16 (✓ at the source):
- ✓ Hono documents Workers and Node (Node through `@hono/node-server` 2.1.8). Running the same app on both is proved by the server's tests.
- ✓ `tlock-js` 0.9.0 is still the latest (published 2024-03-18, repo not archived, last push the same day). It pins `drand-client` 1.2.5; the drand organisation itself is active. It stays opt-in.
- ✓ drand relays answering today: `api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`, `drand.cloudflare.com`, all serving the quicknet chain `52db9ba7…e971` (3-second rounds).
- ✓ The `#` fragment: the WHATWG Fetch standard serialises request URLs "with exclude fragment", and RFC 9110 forbids it in `Referer`. A redirect carries it to the next page in the browser, and the page's own scripts, extensions and browser history can read it. Per-browser testing not done (inference from the standards). The server URL and election ID are not secret, so this is enough for them.

Still open:
- how long transactional email providers keep message bodies
- mark-reading accuracy on home-printed PDFs (scaling, inkjet)
- the Lob and PostGrid prices at build time (Lob's pricing page and help table disagreed on 2026-11-16)

## 15. Decisions made while building (2026-11-16)

- **Name:** coded-ballot. Packages are `@coded-ballot/*`.
- **Issuer key:** generated 12-word passphrase, Argon2id, then HKDF (section 2).
- **Codes:** 80 bits, 16 characters plus a check character (section 2).
- **STV:** Scottish rules (section 6).
- **Project site:** the project-hosted voting page and member checker are published on GitHub Pages from the GitHub mirror, built by CI from tagged source with the SHA-256 of every file alongside. Nothing is published until the maintainer decides to.
- **Issuer page (2026-11-17):** the issuer's work moved from a command-line tool to a page on the project site, opened from the tellers' app, so an issuer needs no install and no token to copy. The command-line tool stays for bulk email and Lob: Lob's API doesn't allow calls from a browser, and an organisation's server can't send ballots by email without seeing the codes.
- **Sign-in for tellers and the issuer:** passkeys (WebAuthn) on both targets, enrolled by a one-time email link. Cloudflare Access can sit in front as an extra layer.
- **Email:** any SMTP server on Docker; on Workers, a provider's HTTPS API. Tested with Amazon SES.
- **Mail API:** Lob first, for Lob's test mode; a PostGrid adapter can follow.
- **Count key fingerprint:** the voting page, the issuer page and the issuer tool work it out from the public key itself, never from the fingerprint the server reports, and the issuer confirms it with the teller who made the key before printing ballots.
- **Mark reading:** in TypeScript in the core, without OpenCV: four corner squares, a perspective map, and each oval judged against the paper just around it. A mark must be dark across the whole oval (70% overall and 45% in every quarter); crosses, ticks, write-ins, overvotes and rank-grid mistakes always go to a teller. Real-paper tests: [docs/scanning-tests.md](docs/scanning-tests.md).
- **Which paper counts:** before reading paper, the tellers' app downloads every code received by post or in person with its ballot style, once, and checks each sheet against that list on the teller's device. A sheet never received, voted online, or carrying the wrong style can't be counted, and the server never learns which code a cast vote record came from.
- **Ballot images** are re-saved as JPEG in the tellers' app before upload, which drops photo metadata such as location.
- **Recount:** the public page recounts the online votes in the member's browser after certification. Paper cast vote records are not published.
- **Page headers:** the release carries a `_headers` file (strict CSP, no framing, wildcard CORS on the public files for the member checker). Cloudflare reads it; the Node target applies the same file.
