import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { LiveSession } from './src/liveSession.js';
import { createHub } from './src/hub.js';
import { SAMPLES } from './src/samples.js';
import { SpotifySession } from './src/spotify.js';
import { YouTubeMusicBridge } from './src/ytmusic.js';
import { UserStore } from './src/users.js';
import { SESSION_COOKIE, sessionTokenFrom, tooManyAttempts } from './src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Where the server listens. The default is only this computer. On a server, set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// The address a browser uses to reach the server. Spotify's redirect goes here.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const MUSIC_SOURCES = ['spotify', 'youtube'];
const PANEL_SETTING_KEYS = [
  'size', 'max', 'duration', 'template', 'spotifyTemplate', 'anim', 'dur',
  'custom', 'accent', 'text', 'bg', 'persp', 'username',
];

const store = new UserStore(path.join(here, 'data'));
const contexts = new Map(); // account id -> that account's live connection, Spotify, and music state

const app = express();
app.use(express.json());

// ---- Pages ----

app.get('/login', (req, res) => {
  if (store.userForSession(sessionTokenFrom(req))) return res.redirect('/');
  res.sendFile(path.join(here, 'public', 'login.html'));
});

// The panel needs a logged-in account. Overlay files are public, but they only receive data
// over the WebSocket, which checks the overlay key.
app.get(['/', '/index.html'], (req, res, next) => (
  store.userForSession(sessionTokenFrom(req)) ? next() : res.redirect('/login')
));
app.use(express.static(path.join(here, 'public')));

// ---- Accounts ----

function setSession(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PUBLIC_URL.startsWith('https://'),
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// The first account to register takes over the settings and Spotify token saved before accounts existed.
function adoptLegacyFiles(user) {
  if (store.users.length !== 1) return;
  const dir = store.userDir(user.id);
  const legacy = [['panel-settings.json', 'settings.json'], ['.spotify.json', 'spotify.json'], ['.music.json', 'music.json']];
  for (const [from, to] of legacy) {
    const source = path.join(here, from);
    if (fs.existsSync(source)) fs.renameSync(source, path.join(dir, to));
  }
}

app.get('/api/session', (req, res) => {
  const user = store.userForSession(sessionTokenFrom(req));
  if (!user) return res.json({ authEnabled: true, panel: false, username: null, overlayKey: '' });
  res.json({ authEnabled: true, panel: true, username: user.username, overlayKey: user.overlayKey });
});

app.post('/api/register', (req, res) => {
  if (tooManyAttempts(`register:${req.ip}`)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit.' });
  }
  let user;
  try {
    user = store.createUser(req.body?.username, req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  adoptLegacyFiles(user);
  setSession(res, store.createSession(user.id));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  if (tooManyAttempts(`login:${req.ip}`)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit.' });
  }
  const user = store.verify(req.body?.username, req.body?.password);
  if (!user) return res.status(401).json({ error: 'Username atau password salah' });
  setSession(res, store.createSession(user.id));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  store.deleteSession(sessionTokenFrom(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---- Per-account state ----

function readMusicSource(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).source;
    return MUSIC_SOURCES.includes(saved) ? saved : 'spotify';
  } catch {
    return 'spotify';
  }
}

// The overlay only listens to one message, whichever source the account has chosen.
function broadcastNowPlaying(ctx) {
  const nowPlaying = ctx.musicSource === 'youtube' ? ctx.youtube.nowPlaying() : ctx.spotify.status().nowPlaying;
  hub.broadcast(ctx.userId, { type: 'nowplaying', source: ctx.musicSource, nowPlaying });
}

function contextFor(userId) {
  const existing = contexts.get(userId);
  if (existing) return existing;

  const dir = store.userDir(userId);
  const send = (message) => hub.broadcast(userId, message);
  const ctx = {
    userId,
    dir,
    settingsFile: path.join(dir, 'settings.json'),
    musicFile: path.join(dir, 'music.json'),
    musicSource: readMusicSource(path.join(dir, 'music.json')),
  };
  ctx.live = new LiveSession({
    onEvent: send,
    onStatus: (status) => send({ type: 'status', ...status }),
  });
  ctx.spotify = new SpotifySession({
    redirectUri: `${PUBLIC_URL}/api/spotify/callback`,
    tokenFile: path.join(dir, 'spotify.json'),
    onChange: (message) => {
      send(message);
      broadcastNowPlaying(ctx);
    },
  });
  ctx.spotify.load();
  ctx.youtube = new YouTubeMusicBridge({
    onChange: () => {
      send({ type: 'youtube', ...ctx.youtube.status() });
      broadcastNowPlaying(ctx);
    },
  });
  ctx.youtube.start();

  contexts.set(userId, ctx);
  return ctx;
}

// Every /api route below this point needs an account, except the ones listed here.
const OPEN_API = new Set(['/api/session', '/api/login', '/api/register', '/api/logout']);
app.use('/api', (req, res, next) => {
  req.user = store.userForSession(sessionTokenFrom(req));
  const pathname = req.originalUrl.split('?')[0];
  if (OPEN_API.has(pathname)) return next();

  // The Chrome extension sends YouTube Music reports with an overlay key instead of a login.
  if (pathname === '/api/ytmusic/report') {
    const user = store.byOverlayKey(req.query.key);
    if (!user) return res.status(401).json({ error: 'Perlu kunci overlay' });
    req.ctx = contextFor(user.id);
    return next();
  }

  if (!req.user) {
    if (pathname === '/api/spotify/callback') return res.redirect('/login');
    return res.status(401).json({ error: 'Perlu login' });
  }
  req.ctx = contextFor(req.user.id);
  next();
});

// ---- Connection status and TikTok ----

app.get('/api/status', (req, res) => {
  res.json(req.ctx.live.status());
});

app.post('/api/connect', async (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{2,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username TikTok tidak valid' });
  }
  try {
    await req.ctx.live.start(username);
    res.json(req.ctx.live.status());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  await req.ctx.live.stop();
  res.json(req.ctx.live.status());
});

app.post('/api/test/:kind', (req, res) => {
  const make = SAMPLES[req.params.kind];
  if (!make) return res.status(404).json({ error: 'Jenis tes tidak dikenal' });
  hub.broadcast(req.user.id, make());
  res.json({ ok: true });
});

// ---- Spotify ----

app.get('/api/spotify/status', (req, res) => {
  res.json(req.ctx.spotify.status());
});

app.post('/api/spotify/config', async (req, res) => {
  try {
    await req.ctx.spotify.setClientId(String(req.body?.clientId || '').trim());
    res.json(req.ctx.spotify.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/spotify/login', (req, res) => {
  if (!req.ctx.spotify.clientId) {
    return res.redirect(`/?spotify=error&message=${encodeURIComponent('Isi Client ID Spotify di panel dulu')}#/musik`);
  }
  res.redirect(req.ctx.spotify.loginUrl());
});

// Results land on the Musik page, where the Spotify card and its messages are.
app.get('/api/spotify/callback', async (req, res) => {
  if (req.query.error) {
    return res.redirect(`/?spotify=error&message=${encodeURIComponent('Login Spotify dibatalkan')}#/musik`);
  }
  try {
    await req.ctx.spotify.finishLogin(String(req.query.code || ''), String(req.query.state || ''));
    res.redirect('/?spotify=connected#/musik');
  } catch (err) {
    res.redirect(`/?spotify=error&message=${encodeURIComponent(err.message)}#/musik`);
  }
});

app.post('/api/spotify/disconnect', async (req, res) => {
  await req.ctx.spotify.disconnect();
  res.json(req.ctx.spotify.status());
});

// ---- Music source ----

app.get('/api/music/status', (req, res) => {
  const ctx = req.ctx;
  res.json({ source: ctx.musicSource, spotify: ctx.spotify.status(), youtube: ctx.youtube.status() });
});

app.post('/api/music/source', (req, res) => {
  const ctx = req.ctx;
  const source = req.body?.source;
  if (!MUSIC_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Sumber musik tidak dikenal' });
  }
  ctx.musicSource = source;
  fs.writeFileSync(ctx.musicFile, JSON.stringify({ source }));
  broadcastNowPlaying(ctx);
  res.json({ source });
});

app.post('/api/ytmusic/report', (req, res) => {
  req.ctx.youtube.report(req.body || {});
  res.json({ ok: true });
});

// ---- Panel settings (per account) ----

app.get('/api/settings', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(req.ctx.settingsFile, 'utf8')));
  } catch {
    res.json({});
  }
});

app.post('/api/settings', (req, res) => {
  const next = {};
  for (const key of PANEL_SETTING_KEYS) {
    if (req.body?.[key] !== undefined) next[key] = req.body[key];
  }
  // Write to a temporary file first, so a crash mid-write can't leave a broken settings file.
  const tmp = `${req.ctx.settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, req.ctx.settingsFile);
  res.json({ ok: true });
});

// ---- Live channel ----

// An overlay key identifies the account for OBS. A logged-in panel identifies it by cookie.
const server = http.createServer(app);
const hub = createHub(server, {
  resolveUser: (req) => {
    const key = new URL(req.url || '/', 'http://localhost').searchParams.get('key');
    const user = store.byOverlayKey(key) || store.userForSession(sessionTokenFrom(req));
    if (!user) return null;
    contextFor(user.id);
    return user.id;
  },
  snapshotFor: (userId) => contextFor(userId).live.status(),
});

server.listen(PORT, HOST, () => {
  console.log(`Listening     : ${HOST}:${PORT}`);
  console.log(`Panel kontrol : ${PUBLIC_URL}`);
  console.log(`Daftar / masuk: ${PUBLIC_URL}/login`);
});

async function shutdown() {
  for (const ctx of contexts.values()) {
    ctx.spotify.stop();
    ctx.youtube.stop();
    await ctx.live.stop();
  }
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
