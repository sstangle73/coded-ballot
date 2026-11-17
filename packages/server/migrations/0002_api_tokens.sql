-- Short-lived tokens for the issuer's local tool, made by a signed-in staff member in the browser (passkeys only
-- work there). Sent as "Authorization: Bearer <token>".
CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff (id),
  label TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
