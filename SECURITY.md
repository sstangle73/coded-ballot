# Security

## Reporting a vulnerability

Please report a security problem privately, not in a public issue. This project lives on
[GitLab](https://gitlab.com/sstangle73/coded-ballot) and is mirrored to GitHub, and either route works:
- **[Report a vulnerability](https://github.com/sstangle73/coded-ballot/security/advisories/new)** on the GitHub
  mirror's *Security* tab, or
- a [GitLab issue](https://gitlab.com/sstangle73/coded-ballot/-/issues/new) marked **confidential**.

Only you and the maintainer see either one. Say what you can of:
- the version or commit, and which target (Cloudflare Workers or Docker);
- how to reproduce it, or a proof of concept;
- what someone could do with it: vote twice, vote as someone else, change or read a vote, link a vote to a member,
  change a result, or stop an election.

## What happens next

- You'll hear back within 7 days.
- Once it's confirmed, it gets fixed and the fix is described in the release, crediting you unless you'd rather not be
  named.
- Please keep it private until a fix is out, or for 90 days after your report, whichever comes first. If an election
  you know of is running on an affected version, say so: that changes the timing.

This is a one-person project, and reports aren't paid.

## Supported versions

Only the latest `main` gets fixes.

## What's in scope

[TRUST.md](TRUST.md) says what coded-ballot is meant to protect and who has to be trusted. A report matters most when
it breaks one of those promises without the trust TRUST.md already assumes:
- **One member, one vote:** a code used twice, a vote cast without both the email link and the code, a paper ballot
  counted that was never received, or a ballot counted with the wrong style or weight.
- **Secrecy:** anything that links a member or a code to how they voted, on the server, in the public log, the
  results, the teller report or the published recount data, beyond the small-group risk TRUST.md describes.
- **Integrity of the count:** a locked vote changed, added or dropped without the signed close catching it; the
  voting page sealing to a key other than the one whose fingerprint it shows; a count, tie draw or recount that
  differs from the rules; certification despite a hand count that doesn't match.
- **Staff access:** reaching staff routes without a passkey session or a tool token, a tool token doing more than the
  issuer tool needs, inviting someone into a role the inviter doesn't hold, or locked votes released before a valid
  close.
- **The pages:** script injection, a way round the content security policy, or the member checker passing a changed
  voting page.

Out of scope: an issuer who keeps the passphrase and leaks codes, tellers who collude, a server operator acting alone
where TRUST.md says the design can't stop them, a deployment without HTTPS, the demo server (`npm run demo`, which
prints codes and keys by design), and denial of service by sheer volume.
