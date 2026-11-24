CREATE TABLE mail_outbox (
 id TEXT PRIMARY KEY,
 payload TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mail_queue ON mail_outbox(status,available_at);
CREATE UNIQUE INDEX users_email_lower ON users(lower(email));
