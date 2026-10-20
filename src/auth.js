import crypto from 'node:crypto';

// Login for the panel, needed when the server can be reached from outside this computer.
// Set PANEL_PASSWORD to turn it on. Without it, the panel is open, which is only safe on 127.0.0.1.
const PASSWORD = process.env.PANEL_PASSWORD || '';
export const authEnabled = Boolean(PASSWORD);

export const SESSION_COOKIE = 'streamover_session';

// Session and overlay keys are derived from the password, so the password itself is never stored
// in a cookie or put in a link. Changing PANEL_PASSWORD signs everyone out.
const derive = (label) => crypto.createHmac('sha256', PASSWORD).update(label).digest('hex');
export const SESSION_TOKEN = authEnabled ? derive('session') : '';
// OBS overlays can't log in, so they carry this key in their URL instead.
export const OVERLAY_KEY = authEnabled ? derive('overlay').slice(0, 32) : '';

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

// The control panel and its API are reached with the session cookie from the login page.
export function isPanelRequest(req) {
  if (!authEnabled) return true;
  return same(parseCookies(req.headers.cookie)[SESSION_COOKIE] || '', SESSION_TOKEN);
}

// Overlays and the live WebSocket carry the overlay key. The panel's own session works too.
export function isOverlayRequest(req) {
  if (!authEnabled) return true;
  const key = new URL(req.url || '/', 'http://localhost').searchParams.get('key') || '';
  return same(key, OVERLAY_KEY) || isPanelRequest(req);
}

export function checkPassword(input) {
  return authEnabled && same(input ?? '', PASSWORD);
}

// Slows down password guessing: at most MAX_ATTEMPTS tries per IP every WINDOW_MS.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

export function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  return entry.count > MAX_ATTEMPTS;
}
