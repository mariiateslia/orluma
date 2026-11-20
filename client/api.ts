export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error || 'Something went wrong. Please try again.'));
    this.status = status;
    this.code = String(body.code || 'request_failed');
    this.details = body;
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response
    .json()
    .catch(() => ({ error: 'The server could not be reached. Please try again.' }));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('orluma:session-expired'));
    throw new ApiError(response.status, result);
  }
  return result as T;
}
export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const moneyInput = (cents: number) => (cents / 100).toFixed(2);
export function parseMoney(value: string) {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value.trim()))
    throw new Error('Enter an amount such as 150 or 149.50.');
  const [major, minor = ''] = value.trim().split('.');
  const result = Number(major) * 100 + Number(minor.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 100000000000)
    throw new Error('This amount is too large.');
  return result;
}
export const dateLabel = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        ...(value.length > 10 ? { hour: 'numeric', minute: '2-digit' } : {}),
        timeZone: value.length === 10 ? 'UTC' : undefined,
      }).format(new Date(value))
    : 'No due date';
export const today = () => new Date().toLocaleDateString('en-CA');
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
export function readRoute(): import('./types').Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'invite' && parts[1])
    return { workspaceId: null, section: 'invite', inviteToken: parts[1] };
  if (parts[0] !== 'w' || !parts[1]) return { workspaceId: null, section: 'home' };
  return {
    workspaceId: parts[1],
    section: parts[2] || 'home',
    id: parts[3],
    tab: parts[4] || 'overview',
  };
}
