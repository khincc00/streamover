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

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Only this computer can reach the server. OBS runs on the same machine.
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(here, 'public')));

const server = http.createServer(app);

const live = new LiveSession({
  onEvent: (event) => hub.broadcast(event),
  onStatus: (status) => hub.broadcast({ type: 'status', ...status }),
});

const hub = createHub(server, { snapshot: () => live.status() });

const spotify = new SpotifySession({
  redirectUri: `http://${HOST}:${PORT}/api/spotify/callback`,
  tokenFile: path.join(here, '.spotify.json'),
  onChange: (message) => {
    hub.broadcast(message);
    broadcastNowPlaying();
  },
});
spotify.load();

// Which service feeds the music overlay: 'spotify' or 'youtube'. Saved so it survives a restart.
const MUSIC_SOURCES = ['spotify', 'youtube'];
const musicFile = path.join(here, '.music.json');
let musicSource = 'spotify';
try {
  const saved = JSON.parse(fs.readFileSync(musicFile, 'utf8')).source;
  if (MUSIC_SOURCES.includes(saved)) musicSource = saved;
} catch {
  // No saved choice yet.
}

const youtube = new YouTubeMusicBridge({
  onChange: () => {
    hub.broadcast({ type: 'youtube', ...youtube.status() });
    broadcastNowPlaying();
  },
});
youtube.start();

// The overlay only listens to this one message, whichever source is active.
function broadcastNowPlaying() {
  const nowPlaying = musicSource === 'youtube' ? youtube.nowPlaying() : spotify.status().nowPlaying;
  hub.broadcast({ type: 'nowplaying', source: musicSource, nowPlaying });
}

app.get('/api/status', (req, res) => {
  res.json(live.status());
});

app.get('/api/spotify/status', (req, res) => {
  res.json(spotify.status());
});

app.post('/api/spotify/config', async (req, res) => {
  try {
    await spotify.setClientId(String(req.body?.clientId || '').trim());
    res.json(spotify.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/spotify/login', (req, res) => {
  if (!spotify.clientId) {
    return res.redirect(`/?spotify=error&message=${encodeURIComponent('Isi Client ID Spotify di panel dulu')}#/musik`);
  }
  res.redirect(spotify.loginUrl());
});

// Results land on the Musik page, where the Spotify card and its messages are.
app.get('/api/spotify/callback', async (req, res) => {
  if (req.query.error) {
    return res.redirect(`/?spotify=error&message=${encodeURIComponent('Login Spotify dibatalkan')}#/musik`);
  }
  try {
    await spotify.finishLogin(String(req.query.code || ''), String(req.query.state || ''));
    res.redirect('/?spotify=connected#/musik');
  } catch (err) {
    res.redirect(`/?spotify=error&message=${encodeURIComponent(err.message)}#/musik`);
  }
});

app.post('/api/spotify/disconnect', async (req, res) => {
  await spotify.disconnect();
  res.json(spotify.status());
});

app.get('/api/music/status', (req, res) => {
  res.json({ source: musicSource, spotify: spotify.status(), youtube: youtube.status() });
});

app.post('/api/music/source', (req, res) => {
  const source = req.body?.source;
  if (!MUSIC_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Sumber musik tidak dikenal' });
  }
  musicSource = source;
  fs.writeFileSync(musicFile, JSON.stringify({ source }));
  broadcastNowPlaying();
  res.json({ source });
});

// Panel settings (template, animasi, warna, perspektif, ukuran, dan username) disimpan di server
// supaya tidak hilang kalau data browser dihapus atau panel dibuka dari browser lain.
const settingsFile = path.join(here, 'panel-settings.json');
const PANEL_SETTING_KEYS = [
  'size', 'max', 'duration', 'template', 'spotifyTemplate', 'anim', 'dur',
  'custom', 'accent', 'text', 'bg', 'persp', 'username',
];
let panelSettings = {};
try {
  panelSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch {
  // No saved settings yet.
}

app.get('/api/settings', (req, res) => {
  res.json(panelSettings);
});

app.post('/api/settings', (req, res) => {
  const next = {};
  for (const key of PANEL_SETTING_KEYS) {
    if (req.body?.[key] !== undefined) next[key] = req.body[key];
  }
  // Write to a temporary file first, so a crash mid-write can't leave a broken settings file.
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, settingsFile);
  panelSettings = next;
  res.json({ ok: true });
});

// Called by the Chrome extension in extension/ every couple of seconds.
app.post('/api/ytmusic/report', (req, res) => {
  youtube.report(req.body || {});
  res.json({ ok: true });
});

app.post('/api/connect', async (req, res) => {
  const username = String(req.body?.username || process.env.TIKTOK_USERNAME || '')
    .trim()
    .replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{2,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username TikTok tidak valid' });
  }
  try {
    await live.start(username);
    res.json(live.status());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  await live.stop();
  res.json(live.status());
});

app.post('/api/test/:kind', (req, res) => {
  const make = SAMPLES[req.params.kind];
  if (!make) return res.status(404).json({ error: 'Jenis tes tidak dikenal' });
  hub.broadcast(make());
  res.json({ ok: true });
});

server.listen(PORT, HOST, () => {
  console.log(`Panel kontrol : http://${HOST}:${PORT}`);
  console.log(`Overlay chat  : http://${HOST}:${PORT}/overlay/chat.html`);
  console.log(`Overlay alert : http://${HOST}:${PORT}/overlay/alerts.html`);
});

async function shutdown() {
  spotify.stop();
  youtube.stop();
  await live.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
