# What you have to trust

coded-ballot is built for clubs, nonprofits, HOAs and similar member organisations. It is **not** for high-stakes public elections. No election system can be trusted completely, so this page says who has to be honest for this one to work, what they could get away with if they weren't, and what the design doesn't protect against. Read it before you use coded-ballot.

Glyphs: ● yes · ◐ partly, or only in some modes · ○ no

## Who you must trust

| Who | Sees a name next to a code | Sees choices | Could vote as someone else | Who would notice |
|---|---|---|---|---|
| **Issuer** (sends out the ballots) | ◐ can recompute any code until close | ○ | ◐ by paper, for members who don't vote; not online, which needs the member's email | a member who checks the tracker |
| **Volunteers stuffing packets, or a mail service** | ● they handle them | ○ | ◐ by paper | a member who checks the tracker |
| **Anyone holding a ballot** | ● | ○ | ● that one ballot | the member, when their code shows as used |
| **Someone in the member's inbox** | ● if the ballot was emailed | ○ | ● online too, because both factors are in one inbox | the member |
| **Server operator** | ◐ online voters, at the moment they vote | ◐ only by tampering with the voting page, and not for members using the project's copy | ◐ by editing the database | tellers' release-hash checks; count reconciliation; members checking the tracker |
| **Issuer and operator together** | ● | ◐ only by tampering with the voting page | ● | nobody |
| **Tellers** | ○ | ● paper, and online votes at the count (without codes) | ◐ through rulings on unclear marks | a second teller; images kept for the retention period |

**The biggest one:** the issuer can work out the code of a member who never votes and post a ballot in their name. Signed outer envelopes made that harder, because it meant forging a signature. The defences here are the public counts (codes issued, reissued, and used by channel) and members checking their own code on the tracker. Every mailing asks members to report a use they didn't make.

## Weaknesses of the design

- **No coercion resistance.** Remote voting can't stop someone watching a member vote, or a member selling their code.
- **Small groups.** In an electorate of a few dozen, a ballot style, weight group or batch with only a few ballots can reveal how those people voted. The app warns at fewer than about 5, but it can't fix this. The same applies to the online votes published for recount once the count key is published.
- **Handwriting.** Write-ins and handwriting can identify a voter to the tellers.
- **Key destruction can't be proven.** If a copy of the issuer passphrase survives, the paper ballots kept for the retention period can still be linked to members.
- **Not end-to-end verifiable.** A member can check their ballot was *received*, not that it was *counted as cast*. Anyone can recount the paper (images plus the hand count) and the online votes (the count key is published after certification), but nothing proves each ballot was valid before it was unlocked.
- **The issuer page comes from the project site.** The passphrase and the codes are made in the issuer's browser by the page GitHub Pages serves from the project's mirror, so the project's maintainer and GitHub are trusted not to change it, as they are for the project's copy of the voting page. The organisation's server can't change it, but it serves the tellers' app, whose Issue ballots button could point somewhere else: the issuer should check the address starts `https://sstangle73.github.io/coded-ballot/` before typing the passphrase.
- **Tampered voting page.** Online votes are locked with the tellers' count key, but whoever runs the server also serves the voting page and could change it to copy votes before they're locked. The tellers' checks and the project-hosted member checker catch tampering aimed at everyone, and at anyone who checks, but not a page changed only for voters who never check. Members who vote from the project's own copy and match the printed count key fingerprint are protected either way.
- **One-person mode.** The same person holds the count key all through voting. The close gate and the public log are guardrails, not a lock, unless the time-lock is on.
- **Time-lock costs.** With the time-lock on, the count needs drand to be reachable, the close time is fixed when voting opens, and extending voting lets votes already cast be unlocked at the original close time.
- **Lost count key.** If every copy of the count key is lost, the online votes can't be opened.
- **Rules that can't be offered:** changing a vote after it's cast, and limits on how many proxies one person holds.
- **Availability.** An outage on the deadline day blocks online voting. Paper at the meeting is the fallback.
- **Not certified,** and not for public elections. Each organisation must check that its own rules and local law allow this kind of voting.

## Use something else when

- your organisation can't name an issuer and an operator it trusts
- you expect coercion or vote buying
- the vote must stay secret even from your own officers. For online-only votes, [Belenios](https://www.belenios.org) or [Helios](https://vote.heliosvoting.org) offer cryptographic guarantees
