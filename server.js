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
import { FeedBuffer } from './src/feed.js';
import { RequestQueue, parseRequest } from './src/queue.js';
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

// The events kept in each account's activity history.
const FEED_TYPES = new Set(['chat', 'gift', 'follow', 'share']);

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
  // publicUrl is the address Spotify sends people back to, so the panel can show it exactly.
  if (!user) return res.json({ authEnabled: true, panel: false, username: null, overlayKey: '', publicUrl: PUBLIC_URL });
  res.json({ authEnabled: true, panel: true, username: user.username, overlayKey: user.overlayKey, publicUrl: PUBLIC_URL });
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

// The music choice for one account: which service feeds the overlay, and whether requests
// are also added to the Spotify queue.
function readMusicSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      source: MUSIC_SOURCES.includes(saved.source) ? saved.source : 'spotify',
      autoQueue: saved.autoQueue === true,
    };
  } catch {
    return { source: 'spotify', autoQueue: false };
  }
}

function saveMusicSettings(ctx) {
  fs.writeFileSync(ctx.musicFile, JSON.stringify({ source: ctx.musicSource, autoQueue: ctx.autoQueue }));
}

// The overlay only listens to one message, whichever source the account has chosen.
function broadcastNowPlaying(ctx) {
  const nowPlaying = ctx.musicSource === 'youtube' ? ctx.youtube.nowPlaying() : ctx.spotify.status().nowPlaying;
  hub.broadcast(ctx.userId, { type: 'nowplaying', source: ctx.musicSource, nowPlaying });
}

function broadcastQueue(ctx) {
  hub.broadcast(ctx.userId, { type: 'queue', items: ctx.queue.list() });
}

// A chat message like "!req judul lagu" goes into the account's request list.
function handleChat(ctx, event) {
  const song = parseRequest(event.text);
  if (!song) return;
  const uniqueId = event.user?.uniqueId || event.user?.nickname || '';
  const nickname = event.user?.nickname || 'Penonton';
  const { item } = ctx.queue.add({ uniqueId, nickname, song });
  if (!item) return;
  broadcastQueue(ctx);
  if (ctx.autoQueue && ctx.musicSource === 'spotify') queueOnSpotify(ctx, item);
}

// Finds the requested song on Spotify and adds it to the queue. The outcome is saved on the request,
// so the panel can show whether it worked and why not.
async function queueOnSpotify(ctx, item) {
  const note = (text, extra = {}) => {
    ctx.queue.update(item.id, { note: text, ...extra });
    broadcastQueue(ctx);
  };
  if (!ctx.spotify.status().connected) return note('Spotify belum terhubung');
  try {
    const track = await ctx.spotify.searchTrack(item.song);
    if (!track) return note('Lagu tidak ditemukan di Spotify');
    await ctx.spotify.addToQueue(track.uri);
    note(`Masuk antrean Spotify: ${track.name} - ${track.artist}`, { sent: true });
  } catch (err) {
    note(err.message);
  }
}

function contextFor(userId) {
  const existing = contexts.get(userId);
  if (existing) return existing;

  const dir = store.userDir(userId);
  const send = (message) => hub.broadcast(userId, message);
  const music = readMusicSettings(path.join(dir, 'music.json'));
  const ctx = {
    userId,
    dir,
    settingsFile: path.join(dir, 'settings.json'),
    musicFile: path.join(dir, 'music.json'),
    musicSource: music.source,
    autoQueue: music.autoQueue,
    feed: new FeedBuffer(path.join(dir, 'feed.json')),
    queue: new RequestQueue(path.join(dir, 'queue.json')),
  };
  ctx.live = new LiveSession({
    onEvent: (event) => {
      if (FEED_TYPES.has(event.type)) ctx.feed.add(event);
      if (event.type === 'chat') handleChat(ctx, event);
      send(event);
    },
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
  const sample = make();
  if (FEED_TYPES.has(sample.type)) req.ctx.feed.add(sample);
  if (sample.type === 'chat') handleChat(req.ctx, sample);
  hub.broadcast(req.user.id, sample);
  res.json({ ok: true });
});

// ---- Song requests ----

app.get('/api/queue', (req, res) => {
  res.json(req.ctx.queue.list());
});

// Played or skipped: the streamer removes the request from the list.
app.post('/api/queue/:id/done', (req, res) => {
  if (!req.ctx.queue.remove(req.params.id)) {
    return res.status(404).json({ error: 'Permintaan tidak ditemukan' });
  }
  broadcastQueue(req.ctx);
  res.json(req.ctx.queue.list());
});

app.post('/api/queue/clear', (req, res) => {
  req.ctx.queue.clear();
  broadcastQueue(req.ctx);
  res.json(req.ctx.queue.list());
});

// Recent activity for this account. The panel asks for at most 60 at a time.
app.get('/api/feed', (req, res) => {
  res.json(req.ctx.feed.recent(req.query.limit));
});

app.post('/api/feed/clear', (req, res) => {
  req.ctx.feed.clear();
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
  res.json({ source: ctx.musicSource, autoQueue: ctx.autoQueue, spotify: ctx.spotify.status(), youtube: ctx.youtube.status() });
});

app.post('/api/music/autoqueue', (req, res) => {
  const ctx = req.ctx;
  ctx.autoQueue = req.body?.enabled === true;
  saveMusicSettings(ctx);
  res.json({ autoQueue: ctx.autoQueue });
});

app.post('/api/music/source', (req, res) => {
  const ctx = req.ctx;
  const source = req.body?.source;
  if (!MUSIC_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Sumber musik tidak dikenal' });
  }
  ctx.musicSource = source;
  saveMusicSettings(ctx);
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
    ctx.feed.flush();
    await ctx.live.stop();
  }
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
