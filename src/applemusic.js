import crypto from 'node:crypto';
import fs from 'node:fs';
import { youtubeKey } from './lyrics.js';

// Apple Music memakai developer token: JWT ES256 yang ditandatangani dengan kunci MusicKit dari akun Apple Developer.
// Kunci privat itu rahasia. Dibaca dari environment saat server jalan, dan tidak pernah dikirim ke panel.
const TOKEN_DAYS = 30;
// Token baru dibuat sehari sebelum habis, supaya halaman yang sedang terbuka tidak kehilangan akses.
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Kalau salah satu nilai belum diisi, fitur Apple Music dimatikan dan server tetap jalan seperti biasa.
export function appleConfigFromEnv(env = process.env, read = fs.readFileSync) {
  const teamId = env.APPLE_TEAM_ID || '';
  const keyId = env.APPLE_KEY_ID || '';
  let privateKey = env.APPLE_PRIVATE_KEY || '';
  if (!privateKey && env.APPLE_PRIVATE_KEY_FILE) {
    try {
      privateKey = read(env.APPLE_PRIVATE_KEY_FILE, 'utf8');
    } catch {
      return null;
    }
  }
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey: privateKey.replace(/\\n/g, '\n'), origin: env.PUBLIC_URL || '' };
}

const b64url = (value) => Buffer.from(value).toString('base64url');

// Membuat developer token. Origin dimasukkan supaya MusicKit di browser mau memakainya di alamat server ini.
export function createDeveloperToken(config, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const exp = iat + TOKEN_DAYS * 24 * 60 * 60;
  const payload = { iss: config.teamId, iat, exp };
  if (config.origin) payload.origin = config.origin;
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: config.privateKey, dsaEncoding: 'ieee-p1363' });
  return { token: `${data}.${signature.toString('base64url')}`, expiresAt: exp * 1000 };
}

// Satu token dipakai bersama sampai hampir habis, lalu dibuat lagi.
export function developerTokenSource(config) {
  let current = null;
  return () => {
    if (!current || Date.now() > current.expiresAt - REFRESH_MS) current = createDeveloperToken(config);
    return current.token;
  };
}

// Kunci lagu Apple Music: ID lagu kalau ada, supaya lagu yang sama selalu cocok walau judulnya berubah.
export function appleKeyFor(title, artist, songId) {
  if (songId) return `am:${songId}`;
  return youtubeKey(title, artist).replace(/^yt:/, 'am:');
}
