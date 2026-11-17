# coded-ballot

An open source election system for member organisations (clubs, nonprofits, HOAs, union locals) run by volunteer tellers. Each member gets **one ballot with a unique code**, usable once: by mail, online, or in person. The first use counts; copies are harmless.

**Read [TRUST.md](TRUST.md) first.** It says who you have to trust and what this design does not protect against. coded-ballot is sized for clubs and nonprofits, **not for public elections**, and it is not certified for anything.

**Check your own rules and law.** Whether your organisation may vote by mail, online or with coded ballots depends on its bylaws and on local law. Each organisation must check that for itself; this project makes no legal claims.

## Status

Under construction. Built so far:

- `packages/core`: the TypeScript core shared by every part. Rules file and its schema, roll import, eligibility and ballot styles, code derivation, the signed close, the spend list, and the counting modules (plurality, approval, yes/no with any threshold, IRV, Scottish STV, all with weights) with plain-language explanations and ties drawn from drand.

The design is in [DESIGN.md](DESIGN.md), with diagrams in [docs/design.html](docs/design.html).

## Try the core

Needs Node 22.12 or later.

```bash
npm install
npm test
```

An example rules file is in [examples/rules.example.yaml](examples/rules.example.yaml); its schema is [schemas/rules.schema.json](schemas/rules.schema.json).

## Licence

[AGPL-3.0-only](LICENSE). If you change coded-ballot and let people use it over a network, you must offer them your changed source.
