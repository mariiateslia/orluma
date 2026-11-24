import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const password = randomBytes(24).toString('hex');
try {
  await writeFile(
    '.env',
    `APP_URL=http://localhost:3000\nHOST=127.0.0.1\nPORT=3000\nDATABASE_URL=postgresql://orluma:${password}@localhost:5433/orluma\nPOSTGRES_PASSWORD=${password}\nAUTH_SECRET=${randomBytes(48).toString('base64url')}\nMAIL_FROM=Orluma <no-reply@orluma.test>\nSMTP_HOST=127.0.0.1\nSMTP_PORT=1025\nSMTP_SECURE=false\nREGISTRATION_MODE=invite\nTRUST_PROXY=0\nNODE_ENV=production\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Created private .env. Next: docker compose up --build -d. Local email inbox: http://localhost:8025.',
  );
} catch (error) {
  if (error.code === 'EEXIST')
    console.log('.env already exists and was left unchanged. See docs/SELF_HOSTING.md.');
  else throw error;
}
