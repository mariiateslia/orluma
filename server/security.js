import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class HttpError extends Error {
  constructor(status, message, code = 'request_failed', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const assert = (condition, status, message, code, extra) => {
  if (!condition) throw new HttpError(status, message, code, extra);
};
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, scryptOptions);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password, encoded) {
  const [kind, salt, hash] = String(encoded).split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const actual = await scrypt(password, salt, 64, scryptOptions);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function cookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const position = part.indexOf('=');
        if (position < 0) return ['', ''];
        return [part.slice(0, position).trim(), part.slice(position + 1).trim()];
      })
      .filter(([key]) => key),
  );
}
export function sessionCookie(value, { secure, maxAge = 7 * 86400 } = {}) {
  return `orluma_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function member(db, workspaceId, userId, roles) {
  const membership = db
    .prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?')
    .get(workspaceId, userId);
  assert(membership, 404, 'Workspace not found.', 'not_found');
  assert(
    !roles || roles.includes(membership.role),
    403,
    'Your workspace role does not allow this action.',
    'forbidden',
  );
  return membership;
}
export const editors = ['owner', 'admin', 'member'];
export const admins = ['owner', 'admin'];
export function scoped(db, table, entityId, userId, roles) {
  assert(
    ['projects', 'tasks', 'documents', 'spend_requests', 'expenses'].includes(table),
    500,
    'Invalid entity table.',
  );
  const item = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId);
  assert(item, 404, 'This item could not be found.', 'not_found');
  member(db, item.workspace_id, userId, roles);
  return item;
}
export function expectVersion(item, version) {
  assert(
    item.version === version,
    409,
    'Someone changed this item. Review the latest version before saving.',
    'version_conflict',
    { currentVersion: item.version },
  );
}
