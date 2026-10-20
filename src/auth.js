// Helpers for logins: reading the session cookie and slowing down guessing.
// Accounts and sessions themselves are in users.js.

export const SESSION_COOKIE = 'streamover_session';

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function sessionTokenFrom(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

// At most MAX_ATTEMPTS per key (for example "login:<ip>") every WINDOW_MS.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

export function tooManyAttempts(key) {
  const now = Date.now();
  const entry = attempts.get(key) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count > MAX_ATTEMPTS;
}
