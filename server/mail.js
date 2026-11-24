import nodemailer from 'nodemailer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { id } from './database.js';

// Authentication links are encrypted at rest and removed after delivery/expiry.
export function createMail({ db, secret, transport, from = process.env.MAIL_FROM }) {
  if (!from) throw new Error('MAIL_FROM is required.');
  const key = createHash('sha256')
    .update('orluma-mail-outbox-v1:' + secret)
    .digest();
  function encrypt(message) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decrypt(value) {
    const bytes = Buffer.from(value, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    );
  }
  if (!transport) {
    if (process.env.RESEND_API_KEY)
      transport = async (message, messageId) => {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `orluma-${messageId}`,
          },
          body: JSON.stringify({ ...message, from }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('Email provider rejected delivery.');
      };
    else {
      if (!process.env.SMTP_HOST)
        throw new Error(
          'Configure SMTP_HOST or RESEND_API_KEY. Use Mailpit for local development.',
        );
      const smtp = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        requireTLS:
          process.env.SMTP_REQUIRE_TLS !== 'false' &&
          process.env.SMTP_SECURE !== 'true' &&
          !['localhost', '127.0.0.1', '::1', 'mailpit'].includes(process.env.SMTP_HOST),
        ...(process.env.SMTP_USER
          ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
          : {}),
        connectionTimeout: 15000,
        socketTimeout: 15000,
      });
      transport = (message, messageId) =>
        smtp.sendMail({ ...message, from, messageId: `<${messageId}@orluma.local>` });
    }
  }
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await db.exec(
        "UPDATE mail_outbox SET payload=NULL, status='expired' WHERE status IN ('queued','sending') AND expires_at<=now()",
      );
      for (let i = 0; i < 20; i++) {
        const job = await db
          .prepare(
            "UPDATE mail_outbox SET status='sending', attempts=attempts+1, available_at=now()+interval '2 minutes' WHERE id=(SELECT id FROM mail_outbox WHERE payload IS NOT NULL AND expires_at>now() AND ((status='queued' AND available_at<=now()) OR (status='sending' AND available_at<=now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
          )
          .get();
        if (!job) break;
        try {
          await transport(decrypt(job.payload), job.id);
          await db
            .prepare("UPDATE mail_outbox SET status='sent', payload=NULL WHERE id=?")
            .run(job.id);
        } catch {
          await db
            .prepare(
              "UPDATE mail_outbox SET status=?, payload=CASE WHEN attempts>=5 THEN NULL ELSE payload END, available_at=now()+interval '1 minute' * power(2,attempts) WHERE id=?",
            )
            .run(job.attempts >= 5 ? 'failed' : 'queued', job.id);
          console.warn('Orluma email delivery will retry; check provider configuration.');
        }
      }
    } finally {
      flushing = false;
    }
  }
  return {
    async enqueue(message) {
      await db
        .prepare('INSERT INTO mail_outbox(id,payload) VALUES(?,?)')
        .run(id(), encrypt(message));
    },
    flush,
    start() {
      const timer = setInterval(
        () => flush().catch(() => console.warn('Email queue unavailable.')),
        1000,
      );
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
