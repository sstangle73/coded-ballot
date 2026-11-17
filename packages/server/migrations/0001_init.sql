-- coded-ballot schema. One file serves Cloudflare D1 and Node's SQLite.
--
-- Privacy rules this schema keeps:
--  * codes holds hash(S) and the ballot style, never a member.
--  * voters holds member IDs and emails for online links, never a code.
--  * locked_votes holds sealed choices only: no code, no time, no member. It is WITHOUT ROWID with a random key,
--    so nothing records the order votes arrived in; listing by id is a shuffle.

CREATE TABLE elections (
  id TEXT PRIMARY KEY,
  rules_yaml TEXT NOT NULL,
  rules_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'open', 'closed', 'certified', 'purged')),
  issuer_public_key TEXT,
  passphrase_backup_confirmed INTEGER NOT NULL DEFAULT 0,
  count_key_public TEXT,
  count_key_confirmed INTEGER NOT NULL DEFAULT 0,
  roll_sha256 TEXT,
  roll_frozen_at TEXT,
  close_json TEXT,
  close_signature TEXT,
  close_fallback INTEGER NOT NULL DEFAULT 0,
  results_json TEXT,
  report_json TEXT,
  count_key_private TEXT,
  certified_at TEXT,
  purged_at TEXT,
  cloned_from TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE codes (
  election_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  style_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'spent', 'revoked')),
  channel TEXT CHECK (channel IN ('mail', 'online', 'in_person')),
  at TEXT,
  -- set and cleared inside one transaction while an online vote is stored; never persists
  spend_nonce TEXT,
  PRIMARY KEY (election_id, hash)
) WITHOUT ROWID;

CREATE TABLE rejected_uses (
  election_id TEXT NOT NULL,
  at TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  hash_prefix TEXT NOT NULL
);

CREATE TABLE voters (
  election_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  email TEXT NOT NULL,
  link_token_hash TEXT,
  link_expires_at TEXT,
  link_requests INTEGER NOT NULL DEFAULT 0,
  -- 'used' once the member has voted online; a nonce only inside the voting transaction
  used TEXT,
  PRIMARY KEY (election_id, member_id)
) WITHOUT ROWID;
CREATE INDEX voters_email ON voters (election_id, email);
CREATE UNIQUE INDEX voters_token ON voters (link_token_hash);

CREATE TABLE locked_votes (
  election_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  PRIMARY KEY (election_id, id)
) WITHOUT ROWID;

CREATE TABLE public_log (
  election_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (election_id, seq)
);

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  roles TEXT NOT NULL, -- comma-separated: issuer, teller
  created_at TEXT NOT NULL
);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff (id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff (id),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff (id),
  expires_at TEXT NOT NULL
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  staff_id TEXT,
  expires_at TEXT NOT NULL
);

-- Paper ballots read at the count. cvr is the cast vote record (style and selections, no code).
CREATE TABLE paper_records (
  election_id TEXT NOT NULL,
  id TEXT NOT NULL,
  style_id TEXT NOT NULL,
  batch TEXT NOT NULL DEFAULT 'main' CHECK (batch IN ('main', 'provisional')),
  cvr TEXT NOT NULL,
  image_sha256 TEXT,
  image_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'adjudicate', 'resolved', 'rejected')),
  issues TEXT,
  ruling TEXT,
  ruled_by TEXT,
  PRIMARY KEY (election_id, id)
) WITHOUT ROWID;

CREATE TABLE hand_counts (
  election_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  totals TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (election_id, contest_id, staff_id)
);

CREATE TABLE fallback_close_approvals (
  election_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (election_id, staff_id)
);

-- Provisional ballots are paper only, each in an inner envelope with the member's name on it. Tellers rule on the
-- envelope; upheld ones are opened and scanned into the 'provisional' batch, the rest destroyed unread. Only the
-- numbers are kept.
CREATE TABLE provisional_tally (
  election_id TEXT PRIMARY KEY,
  upheld INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  staff_id TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE tamper_checks (
  election_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL,
  staff_id TEXT
);

-- Changes to the roll after it was frozen at the notice date: listed in the teller report (not the public log).
CREATE TABLE roll_changes (
  election_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
