# Self-hosting Orluma

Use one Node.js 24 process and one persistent SQLite database on a local disk. The current event-stream implementation is process-local. Do not run multiple app replicas against a shared network filesystem or deploy the database on ephemeral serverless storage.

## Configuration

Copy `.env.example` to `.env`. The Node entry points load this file; Compose reads its values when interpolating `compose.yaml`.

| Variable            | Default                 | Purpose                                                                                                                                                                     |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`           | `http://localhost:3000` | Exact origin used by browsers and invitation links; set to `https://your-domain.example` for a public installation. No subpath hosting in v0.1.                             |
| `HOST`              | `127.0.0.1`             | Node bind address. Docker uses `0.0.0.0` inside the container.                                                                                                              |
| `PORT`              | `3000`                  | Node port; in Compose, host port forwarded to container port 3000.                                                                                                          |
| `DATA_DIR`          | `./data`                | Directory for `orluma.sqlite`. Docker fixes this to `/app/data` in a named volume.                                                                                          |
| `REGISTRATION_MODE` | `invite`                | The first account registers, later accounts require an invitation. `open` is an explicit operator opt-in for unrestricted registration. Compose keeps this set to `invite`. |
| `TRUST_PROXY`       | `0`                     | Set to `1` only behind exactly one trusted reverse proxy that overwrites forwarding headers and is the only route to the app.                                               |
| `NODE_ENV`          | `production`            | Production headers and static frontend. `npm run dev` sets development mode.                                                                                                |

If POST requests say “Open Orluma at its configured URL,” the browser origin differs from `APP_URL`. Use the configured hostname consistently, including `localhost` versus `127.0.0.1`. Do not weaken the origin check.

## Public access

1. Start locally and create the first account before exposing the instance.
2. Point your own domain at a server with persistent storage. Run a TLS reverse proxy in front of the app.
3. Set `APP_URL=https://your-domain.example` and restart Orluma. When HTTPS is configured, cookies require HTTPS.
4. Forward `/api`, the frontend and the SSE connection to the same app origin. Disable proxy buffering for event streams and allow connections lasting longer than 60 seconds. The app sends heartbeats every 15 seconds and also refreshes on focus / every 20 seconds while visible.
5. Create invitation links from the public URL, then share them with your team.

Minimal Nginx location inside an existing HTTPS server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 75s;
}
```

For this single-proxy example, set `TRUST_PROXY=1` and keep the app’s port reachable only from the proxy host. Shared-office NATs share the authentication rate limit (30 attempts per 15 minutes per IP). Host monitoring, TLS, off-site backup retention and disk capacity are the operator’s responsibilities.

## Back up

Node installation, including while the app is running:

```sh
npm run backup
# Or specify a new destination path; existing files are never overwritten.
npm run backup -- /secure/backups/orluma-2026-11-20.sqlite
```

This uses SQLite’s online backup API to include committed WAL transactions. A successful backup is a standalone database. It contains password hashes, sessions and private team content; store it with restricted access and encrypt off-site copies. Schedule and retain backups yourself.

Docker installation:

```sh
docker compose exec orluma node scripts/backup.js /app/data/backup.sqlite
docker compose cp orluma:/app/data/backup.sqlite ./orluma-backup.sqlite
docker compose exec orluma node -e "require('node:fs').unlinkSync('/app/data/backup.sqlite')"
```

The script refuses to overwrite `backup.sqlite`; copy and remove a completed backup before creating another. Move the local copy to protected backup storage. Do not back up just the live `orluma.sqlite` file with a plain file copy while the app is writing.

## Restore

Restore into a **new, empty data directory or volume**, preserving the old data until you verify the recovery. Stop the app first. A restored backup must not be combined with unrelated `-wal` / `-shm` files.

Node installation:

```sh
# Stop npm start / your process manager first.
mkdir data-restored
cp /secure/backups/orluma-2026-11-20.sqlite data-restored/orluma.sqlite
chmod 700 data-restored
chmod 600 data-restored/orluma.sqlite
# Set DATA_DIR=./data-restored in .env, then:
npm start
```

For Compose, stop the service, create a new Docker volume, mount it instead of `orluma_data`, and place the backup at `orluma.sqlite` owned by UID/GID 1000. Start the same app version and verify sign-in, workspace content and balances. Backups restore the accounts and sessions captured at the time of backup; use password recovery to revoke sessions for an account if necessary.

Test recovery periodically on an isolated instance. A workspace JSON export does not include account credentials and has no import UI in this release.

## Forgotten password

There is no email service or public password-reset endpoint. A server operator can recover a known account. Stop Orluma first, then run:

```sh
npm run reset-password -- person@example.com
```

The terminal asks for a new password twice with input hidden. Never put the password in command-line arguments or committed files. Automation can explicitly use `--stdin` with a secret manager’s output. The command revokes every session for this account; restart the app and sign in with the new password.

With Compose, stop the app and run a one-off container against the same volume:

```sh
docker compose stop orluma
docker compose run --rm --no-deps orluma node scripts/reset-password.js person@example.com
docker compose start orluma
```

## Update

Back up first. Review changes, update the code, run `npm ci && npm run build`, then restart. For Compose, rebuild with `docker compose up --build -d`. The database schema initializes idempotently; future schema changes must include a migration. Do not assume a newer database is compatible with an older release.

## Costs

The code has no seat fee or paid API dependency. Running it on your own computer requires no hosting account. A shared public instance needs compute, persistent storage, backups and optionally a domain; those costs depend on your host. No hosting provider is provisioned by the repository.
