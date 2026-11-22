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
import { lyricsFor, lyricsById, searchLyrics } from './src/lyrics.js';
import { YouTubeMusicBridge } from './src/ytmusic.js';
import { appleConfigFromEnv, developerTokenSource, appleKeyFor } from './src/applemusic.js';
import { UserStore } from './src/users.js';
import { FeedBuffer } from './src/feed.js';
import { RequestQueue, parseRequest } from './src/queue.js';
import { MusicLibrary } from './src/library.js';
import { searchVideo, searchVideos, checkEmbeddable, parseVideoId, parsePlaylistId, fetchPlaylistItems, fetchEmbeddableIds } from './src/youtube.js';
import { SESSION_COOKIE, sessionTokenFrom, tooManyAttempts } from './src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Where the server listens. The default is only this computer. On a server, set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// The address a browser uses to reach the server. Spotify's redirect goes here.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
// Needed only to find chat requests on YouTube. Playlist songs use links, so they don't need it.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
// Apple Music needs a developer key from an Apple Developer account. Without it, the feature stays off.
const appleConfig = appleConfigFromEnv();
const appleToken = appleConfig ? developerTokenSource(appleConfig) : null;
const PANEL_SETTING_KEYS = [
  'size', 'max', 'chatMode', 'chatHold', 'duration', 'template', 'spotifyTemplate', 'youtubeTemplate', 'anim', 'dur',
  'custom', 'accent', 'text', 'bg', 'gradient', 'persp', 'username',
  'runningTexts', 'runningSelected', 'npFit', 'npAlign', 'npWidth', 'lyricsFont', 'lyricsColor',
  'ttsChat', 'ttsAlert', 'ttsPrefix', 'ttsRate', 'ttsVoice',
];

// The events kept in each account's activity history.
const FEED_TYPES = new Set(['chat', 'gift', 'follow', 'share']);

const store = new UserStore(path.join(here, 'data'));
const contexts = new Map(); // account id -> that account's live connection, Spotify, and music state

const app = express();
// Behind a reverse proxy on this same computer, the real client address is in X-Forwarded-For.
// Trusting only loopback keeps login throttling per visitor, and ignores forged headers from others.
app.set('trust proxy', 'loopback');
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

// The music choice for one account: whether requests are also added to the Spotify queue.
// Spotify and YouTube Music each have their own overlay, so both are sent and the overlay picks its own.
function readMusicSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      autoQueue: saved.autoQueue === true,
      ytMode: saved.ytMode === 'extension' ? 'extension' : 'player',
      playOrder: saved.playOrder === 'shuffle' ? 'shuffle' : 'playlist',
    };
  } catch {
    return { autoQueue: false, ytMode: 'player', playOrder: 'playlist' };
  }
}

// The YouTube key an account uses: the one connected in the panel, or the one in .env as a fallback.
function youtubeKeyOf(ctx) {
  return ctx.youtubeKey || YOUTUBE_API_KEY;
}

function readYouTubeKey(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'youtube.json'), 'utf8')).key || '';
  } catch {
    return '';
  }
}

function saveYouTubeKey(ctx, key) {
  fs.writeFileSync(path.join(ctx.dir, 'youtube.json'), JSON.stringify({ key }));
}

// Only the start and end of a key are shown, so the panel never gets the whole key back.
function maskKey(key) {
  return key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '';
}

function saveMusicSettings(ctx) {
  fs.writeFileSync(ctx.musicFile, JSON.stringify({ autoQueue: ctx.autoQueue, ytMode: ctx.ytMode, playOrder: ctx.playOrder }));
}

// source is 'spotify' or 'youtube'. Each overlay asks for one of them by its ?source= link.
function nowPlayingMessage(ctx, source) {
  const nowPlaying = source === 'youtube' ? ctx.youtube.nowPlaying()
    : source === 'applemusic' ? ctx.applemusic.nowPlaying()
      : ctx.spotify.status().nowPlaying;
  return { type: 'nowplaying', source, nowPlaying };
}

function broadcastNowPlaying(ctx, source) {
  const message = nowPlayingMessage(ctx, source);
  hub.broadcast(ctx.userId, message);
  removePlayedRequests(ctx, source, message.nowPlaying);
  trackLyrics(ctx, source, message.nowPlaying);
}

// The lyrics for the song playing in one source ('spotify' or 'youtube'). The overlay gets the lines once per song,
// and keeps its place from the progress in the nowplaying messages. key says which song the lines belong to.
function lyricsMessage(ctx, source) {
  const { key, lines } = ctx.lyrics[source];
  return { type: 'lyrics', source, key, lines };
}

// A new song asks LRCLIB once. Polls for the same song do nothing, so a missing lyric isn't retried every few seconds.
// A pick made by hand in the panel wins over the automatic search.
function trackLyrics(ctx, source, track) {
  const key = track?.key || '';
  if (!key || key === ctx.lyrics[source].key) return;
  ctx.lyrics[source] = { key, lines: null };
  hub.broadcast(ctx.userId, lyricsMessage(ctx, source));

  const finish = (lines) => {
    // The song may have changed while LRCLIB was answering. Then this answer is already out of date.
    if (ctx.lyrics[source].key !== key) return;
    ctx.lyrics[source].lines = lines;
    hub.broadcast(ctx.userId, lyricsMessage(ctx, source));
  };
  // Podcast episodes have no synced lyrics on LRCLIB, so they are not looked up.
  if (track.kind !== 'track') return finish([]);

  const override = ctx.lyricOverrides[key];
  // Spotify can help find a YouTube song, if the account is connected.
  const lookup = source !== 'spotify' && ctx.spotify.status().connected
    ? (t) => ctx.spotify.searchTrack(`${t.title} ${t.artist}`)
    : null;
  const work = override ? lyricsById(override.id) : lyricsFor(key, track, lookup);
  work.then(finish, (err) => {
    console.warn(`[lirik] ${err.message}`);
    finish([]);
  });
}

// Reads the saved lyric picks of one account. A missing or broken file means no picks.
function readLyricOverrides(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveLyricOverrides(ctx) {
  const tmp = `${ctx.lyricsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ctx.lyricOverrides, null, 2));
  fs.renameSync(tmp, ctx.lyricsFile);
}

// After a pick changes, the song playing now (if it is that song) gets its lyrics again.
function refreshLyrics(ctx, key) {
  for (const source of ['spotify', 'youtube', 'applemusic']) {
    const track = nowPlayingMessage(ctx, source).nowPlaying;
    if (track?.key !== key || ctx.lyrics[source].key !== key) continue;
    ctx.lyrics[source] = { key: '', lines: null };
    trackLyrics(ctx, source, track);
  }
}

// When a new song starts, the requests for it leave the list. The same song playing on and on
// doesn't remove anything again, so a request for the song that is already playing waits for its next play.
// Each source remembers its own song, so Spotify and YouTube Music don't reset each other.
function removePlayedRequests(ctx, source, nowPlaying) {
  if (!nowPlaying?.playing) return;
  const key = nowPlaying.uri || `${nowPlaying.title}|${nowPlaying.artist}`;
  if (key === ctx.lastTrackKey[source]) return;
  ctx.lastTrackKey[source] = key;
  if (ctx.queue.removePlayed(nowPlaying).length > 0) broadcastQueue(ctx);
}

function broadcastQueue(ctx) {
  hub.broadcast(ctx.userId, { type: 'queue', items: ctx.queue.list() });
}

// A chat message like "!req judul lagu" goes into the account's request list.
function handleChat(ctx, event) {
  const song = parseRequest(event.text);
  if (!song) return;
  // Blacklisted viewers and songs are ignored; they still show in the activity feed.
  if (ctx.library.isBlocked(event.user, song)) return;
  const uniqueId = event.user?.uniqueId || event.user?.nickname || '';
  const nickname = event.user?.nickname || 'Penonton';
  const { item } = ctx.queue.add({ uniqueId, nickname, song });
  if (!item) return;
  broadcastQueue(ctx);
  if (ctx.autoQueue) queueOnSpotify(ctx, item);
  findRequestVideo(ctx, item);
}

// Looks the request up on YouTube, so the player can play it. The result is saved on the request.
async function findRequestVideo(ctx, item) {
  // In extension mode the tab searches YT Music itself, so the YouTube lookup isn't needed.
  if (ctx.ytMode === 'extension') return;
  const note = (text) => {
    ctx.queue.update(item.id, { note: text });
    broadcastQueue(ctx);
  };
  const key = youtubeKeyOf(ctx);
  if (!key) return note('Pencarian YouTube belum diatur. Hubungkan YouTube API di Settings.');
  try {
    const video = await searchVideo(item.song, key);
    if (!video) return note('Lagu tidak ketemu di YouTube');
    ctx.queue.update(item.id, { videoId: video.videoId, videoTitle: video.title, channel: video.channel });
    broadcastQueue(ctx);
  } catch (err) {
    note(`Pencarian YouTube gagal: ${err.message}`);
  }
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
    note(`Masuk antrean Spotify: ${track.name} - ${track.artist}`, { sent: true, uri: track.uri });
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
    autoQueue: music.autoQueue,
    ytMode: music.ytMode, // 'player' (YouTube player) or 'extension' (YT Music tab)
    playOrder: music.playOrder, // 'playlist' (in order) or 'shuffle'
    youtubeCommands: [], // extension mode: commands waiting for the YT Music tab
    lastTrackKey: {},
    // Per source: the song (key) the lyrics are for. lines is null while loading, [] when none exist.
    lyrics: { spotify: { key: '', lines: null }, youtube: { key: '', lines: null }, applemusic: { key: '', lines: null } },
    lyricsFile: path.join(dir, 'lyrics.json'),
    lyricOverrides: readLyricOverrides(path.join(dir, 'lyrics.json')), // song key -> { id } of the LRCLIB lyrics picked by hand
    youtubeKey: readYouTubeKey(dir), // connected in the panel; empty means use .env
    player: { current: null, history: [], cursor: null, bag: null }, // what the player page is playing, and its playlist position
    feed: new FeedBuffer(path.join(dir, 'feed.json')),
    queue: new RequestQueue(path.join(dir, 'queue.json')),
    library: new MusicLibrary(path.join(dir, 'library.json')),
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
    // Spotify's rate limit is shared by every account, so nobody watching means no requests.
    isWatched: () => hub.hasClients(userId),
    onChange: (message) => {
      send(message);
      broadcastNowPlaying(ctx, 'spotify');
    },
  });
  ctx.spotify.load();
  ctx.youtube = new YouTubeMusicBridge({
    onChange: () => {
      send({ type: 'youtube', ...ctx.youtube.status() });
      broadcastNowPlaying(ctx, 'youtube');
    },
  });
  ctx.youtube.start();
  // Apple Music reports from the Apple Music page in the browser (public/applemusic.html), like the YT Music extension.
  ctx.applemusic = new YouTubeMusicBridge({
    keyFor: appleKeyFor,
    onChange: () => broadcastNowPlaying(ctx, 'applemusic'),
  });
  ctx.applemusic.start();

  contexts.set(userId, ctx);
  return ctx;
}

// Every /api route below this point needs an account, except the ones listed here.
const OPEN_API = new Set(['/api/session', '/api/login', '/api/register', '/api/logout']);
app.use('/api', (req, res, next) => {
  req.user = store.userForSession(sessionTokenFrom(req));
  const pathname = req.originalUrl.split('?')[0];
  if (OPEN_API.has(pathname)) return next();

  // The player page reports and asks for the next track with its overlay key instead of a login.
  if (['/api/ytmusic/report', '/api/ytmusic/command', '/api/player/ended', '/api/player/blocked'].includes(pathname)) {
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

// Plays the next request, then takes it off the list.
app.post('/api/queue/play-next', (req, res) => {
  if (!playerReady(req.ctx)) return res.status(409).json({ error: notConnectedMessage(req.ctx) });
  if (!nextRequest(req.ctx)) return res.status(404).json({ error: 'Tidak ada request yang bisa diputar' });
  if (!takeRequest(req.ctx)) return res.status(409).json({ error: NO_LINK });
  res.json(req.ctx.queue.list());
});

// ---- Playlists and blacklist (YT Music Studio) ----

// Runs a library change and answers with the whole library, so the panel shows what was saved.
// Errors become a message for the panel.
function libraryAction(req, res, change) {
  try {
    const result = change();
    if (result === null) return res.status(404).json({ error: 'Playlist tidak ditemukan' });
    if (result === false) return res.status(404).json({ error: 'Data tidak ditemukan' });
    res.json(req.ctx.library.snapshot());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

app.get('/api/library', (req, res) => {
  res.json(req.ctx.library.snapshot());
});

app.post('/api/library/playlists', (req, res) => {
  libraryAction(req, res, () => req.ctx.library.createPlaylist(req.body?.name));
});

app.post('/api/library/playlists/:id/rename', (req, res) => {
  libraryAction(req, res, () => req.ctx.library.renamePlaylist(req.params.id, req.body?.name));
});

app.post('/api/library/playlists/:id/delete', (req, res) => {
  libraryAction(req, res, () => req.ctx.library.deletePlaylist(req.params.id));
});

// With a YouTube key, a link the player can't play is refused here, instead of failing later on air.
// If YouTube can't be asked, the song is still added.
app.post('/api/library/playlists/:id/songs', async (req, res) => {
  const videoId = parseVideoId(req.body?.link);
  const key = youtubeKeyOf(req.ctx);
  let body = req.body || {};
  let replaced = null;
  if (videoId && key) {
    const check = await checkEmbeddable(videoId, key).catch(() => 'ok');
    if (check === 'missing') return res.status(400).json({ error: 'Video tidak ditemukan. Cek link-nya.' });
    // A link the owner blocked is swapped for another upload of the same song that can be played.
    if (check === 'blocked') {
      const query = [body.title, body.artist].filter(Boolean).join(' ');
      const video = query ? await searchVideo(query, key).catch(() => null) : null;
      if (!video) {
        return res.status(400).json({ error: 'Video ini melarang diputar di luar YouTube, dan versi lain tidak ditemukan. Pakai link lain.' });
      }
      body = { ...body, link: video.videoId };
      replaced = { title: video.title, channel: video.channel };
    }
  }
  try {
    if (!req.ctx.library.addSong(req.params.id, body)) return res.status(404).json({ error: 'Playlist tidak ditemukan' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ...req.ctx.library.snapshot(), replaced });
});

app.post('/api/library/playlists/:id/songs/:songId/delete', (req, res) => {
  libraryAction(req, res, () => req.ctx.library.removeSong(req.params.id, req.params.songId));
});

// ---- YouTube API (Settings) ----

app.get('/api/youtube/key', (req, res) => {
  const key = youtubeKeyOf(req.ctx);
  res.json({ connected: Boolean(key), source: req.ctx.youtubeKey ? 'panel' : key ? 'env' : '', masked: maskKey(key) });
});

// Connecting asks YouTube once, so a wrong key is refused here rather than failing later.
app.post('/api/youtube/key', async (req, res) => {
  const key = String(req.body?.key ?? '').trim();
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(key)) {
    return res.status(400).json({ error: 'Key YouTube tidak valid. Salin ulang dari Google Cloud Console.' });
  }
  try {
    await checkEmbeddable('dQw4w9WgXcQ', key);
  } catch (err) {
    return res.status(400).json({ error: `YouTube menolak key ini: ${err.message}` });
  }
  req.ctx.youtubeKey = key;
  saveYouTubeKey(req.ctx, key);
  res.json({ connected: true, source: 'panel', masked: maskKey(key) });
});

// Removes the key connected in the panel. A key in .env still applies, since that's the server's own setting.
app.post('/api/youtube/key/delete', (req, res) => {
  req.ctx.youtubeKey = '';
  fs.rmSync(path.join(req.ctx.dir, 'youtube.json'), { force: true });
  const key = youtubeKeyOf(req.ctx);
  res.json({ connected: Boolean(key), source: key ? 'env' : '', masked: maskKey(key) });
});

// Imports a YouTube playlist link into a playlist. Songs the owner blocked from playing outside YouTube are skipped.
const IMPORT_MAX = 200;
const IMPORT_REPLACE_MAX = 10;
app.post('/api/library/playlists/:id/import', async (req, res) => {
  const playlist = req.ctx.library.findPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist tidak ditemukan' });
  const key = youtubeKeyOf(req.ctx);
  if (!key) return res.status(400).json({ error: 'Import playlist butuh YouTube API. Hubungkan di Settings.' });
  const listId = parsePlaylistId(req.body?.link);
  if (!listId) return res.status(400).json({ error: 'Link playlist YouTube tidak valid' });
  try {
    const items = await fetchPlaylistItems(listId, key, IMPORT_MAX);
    const playable = await fetchEmbeddableIds(items.map((item) => item.videoId), key);
    // Blocked songs get another upload of the same song, up to IMPORT_REPLACE_MAX, since each one costs a search.
    let replaced = 0;
    const songs = [];
    for (const item of items) {
      if (playable.has(item.videoId)) {
        songs.push({ title: item.title, artist: item.channel, videoId: item.videoId });
      } else if (replaced < IMPORT_REPLACE_MAX) {
        const video = await searchVideo(item.title, key).catch(() => null);
        if (video) {
          replaced += 1;
          songs.push({ title: item.title, artist: video.channel, videoId: video.videoId });
        }
      }
    }
    const added = req.ctx.library.addSongs(playlist.id, songs);
    res.json({ ...req.ctx.library.snapshot(), summary: { added, replaced, skipped: items.length - songs.length } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Puts one song from a playlist into the request list, so it can be played in order.
app.post('/api/library/playlists/:id/songs/:songId/queue', (req, res) => {
  const playlist = req.ctx.library.findPlaylist(req.params.id);
  const song = playlist?.songs.find((entry) => entry.id === req.params.songId);
  if (!song) return res.status(404).json({ error: 'Lagu tidak ditemukan' });
  req.ctx.queue.addFromPanel(requestFromSong(playlist, song));
  broadcastQueue(req.ctx);
  res.json(req.ctx.queue.list());
});

// "Tambah semua ke antrian": every song in the playlist, in its order.
app.post('/api/library/playlists/:id/queue', (req, res) => {
  const playlist = req.ctx.library.findPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist tidak ditemukan' });
  for (const song of playlist.songs) {
    req.ctx.queue.addFromPanel(requestFromSong(playlist, song));
  }
  broadcastQueue(req.ctx);
  res.json(req.ctx.queue.list());
});

app.post('/api/library/blacklist', (req, res) => {
  libraryAction(req, res, () => req.ctx.library.addBlocked(req.body?.type, req.body?.value));
});

app.post('/api/library/blacklist/delete', (req, res) => {
  libraryAction(req, res, () => {
    req.ctx.library.removeBlocked(req.body?.type, String(req.body?.value ?? ''));
    return true;
  });
});

// A playlist song as a request: it keeps its YouTube video, so the player can play it.
function requestFromSong(playlist, song) {
  const label = song.artist ? `${song.title} - ${song.artist}` : song.title;
  return { nickname: playlist.name, song: label, videoId: song.videoId, videoTitle: song.title, channel: song.artist };
}

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
  const fail = (message) => res.redirect(`/?spotify=error&message=${encodeURIComponent(message)}#/musik`);
  if (!req.ctx.spotify.clientId) return fail('Isi Client ID Spotify di panel dulu');
  res.redirect(req.ctx.spotify.loginUrl());
});

// Results land on the Musik page, where the Spotify card and its messages are.
app.get('/api/spotify/callback', async (req, res) => {
  if (req.query.error) {
    const message = req.query.error === 'access_denied'
      ? 'Login Spotify dibatalkan'
      : `Spotify menolak login: ${req.query.error}`;
    return res.redirect(`/?spotify=error&message=${encodeURIComponent(message)}#/musik`);
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

// ---- Music: Spotify and YouTube Music ----

app.get('/api/music/status', (req, res) => {
  const ctx = req.ctx;
  res.json({ autoQueue: ctx.autoQueue, ytMode: ctx.ytMode, playOrder: ctx.playOrder, spotify: ctx.spotify.status(), youtube: ctx.youtube.status() });
});

app.post('/api/music/autoqueue', (req, res) => {
  const ctx = req.ctx;
  ctx.autoQueue = req.body?.enabled === true;
  saveMusicSettings(ctx);
  res.json({ autoQueue: ctx.autoQueue });
});

// The player page (src=player) and the extension both report what plays. Only the source of the chosen mode counts,
// so the two never overwrite each other.
app.post('/api/ytmusic/report', (req, res) => {
  const fromPlayer = req.query.src === 'player';
  if (fromPlayer === (req.ctx.ytMode !== 'extension')) req.ctx.youtube.report(req.body || {});
  res.json({ ok: true });
});

// ---- YT Music playback: YouTube player or YT Music tab (extension) ----

// Player mode: the player page (overlay/player.html) plays YouTube videos, so a song needs a YouTube link.
// Extension mode: the Chrome extension opens YT Music, searches the title and artist, and plays the first result.
// In both modes the server decides what plays next: chat requests first, then the playlist the streamer last started.
const PLAYER_NOT_CONNECTED = 'Player YT Music belum terbuka. Buka link player di browser, lalu klik Mulai di halamannya.';
const EXTENSION_NOT_CONNECTED = 'Tab YT Music belum terhubung. Buka music.youtube.com dan pastikan extension aktif.';
const NO_LINK = 'Lagu ini belum punya link YouTube, jadi tidak bisa diputar di player.';
const PLAYER_HISTORY_MAX = 20;
const COMMAND_TTL_MS = 60000;

function playerReady(ctx) {
  return ctx.youtube.status().connected;
}

function notConnectedMessage(ctx) {
  return ctx.ytMode === 'extension' ? EXTENSION_NOT_CONNECTED : PLAYER_NOT_CONNECTED;
}

// Extension mode only: the command waits until the YT Music tab asks for it with its next report.
function queueCommand(ctx, command) {
  ctx.youtubeCommands = [...ctx.youtubeCommands, { ...command, at: Date.now() }].slice(-5);
}

// Sends a track to whichever place plays it. Returns false when this mode can't play the track.
function sendTrack(ctx, entry) {
  if (ctx.ytMode === 'extension') {
    const query = entry.query || [entry.title, entry.artist].filter(Boolean).join(' ');
    queueCommand(ctx, { type: 'play', query });
    return true;
  }
  if (!entry.videoId) return false;
  hub.broadcast(ctx.userId, { type: 'player', action: 'load', videoId: entry.videoId, title: entry.title, artist: entry.artist });
  return true;
}

function sendControl(ctx, action) {
  if (ctx.ytMode === 'extension') queueCommand(ctx, { type: action });
  else hub.broadcast(ctx.userId, { type: 'player', action });
}

// Starts a track and remembers it, so "Sebelumnya" can go back to it. Returns false when nothing was sent.
function playTrack(ctx, entry) {
  if (!sendTrack(ctx, entry)) return false;
  if (ctx.player.current) ctx.player.history = [...ctx.player.history, ctx.player.current].slice(-PLAYER_HISTORY_MAX);
  setCurrent(ctx, entry);
  return true;
}

function setCurrent(ctx, entry) {
  ctx.player.current = entry;
  // A playlist song moves the playlist position. A request leaves it where it was.
  if (entry.playlistId) ctx.player.cursor = { playlistId: entry.playlistId, index: entry.index };
}

// The request that plays next: the first one this mode can play.
function nextRequest(ctx) {
  return ctx.queue.list().find((item) => ctx.ytMode === 'extension' || item.videoId) ?? null;
}

function takeRequest(ctx) {
  const item = nextRequest(ctx);
  if (!item) return false;
  const track = { videoId: item.videoId, title: item.videoTitle || item.song, artist: item.channel || '', query: item.song };
  if (!playTrack(ctx, track)) return false;
  ctx.queue.remove(item.id);
  broadcastQueue(ctx);
  return true;
}

// Next track: a request if there is one, otherwise the next track for the play order.
function nextTrack(ctx) {
  if (nextRequest(ctx)) return takeRequest(ctx);
  const { cursor } = ctx.player;
  const playlist = cursor && ctx.library.findPlaylist(cursor.playlistId);
  // Shuffle keeps playing even with no playlist in use, or an empty one: it then picks from the whole library.
  if (ctx.playOrder === 'shuffle') return playRandom(ctx, playlist);
  if (!playlist) return false;
  const song = playlist.songs[cursor.index + 1];
  if (!song) return false;
  return playTrack(ctx, { ...songTrack(song), playlistId: playlist.id, index: cursor.index + 1 });
}

// The songs shuffle picks from: the playlist in use, or every song in the library when that playlist has none.
function shufflePool(ctx, playlist) {
  if (playlist?.songs.length) return playlist.songs.map((song) => ({ song, playlistId: playlist.id }));
  const seen = new Set();
  const pool = [];
  for (const pl of ctx.library.playlists) {
    for (const song of pl.songs) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      pool.push({ song, playlistId: pl.id });
    }
  }
  return pool;
}

// Shuffle: every song in the pool plays once before any repeats. A new round starts when it's done.
function shuffleNext(ctx, playlist) {
  const pool = shufflePool(ctx, playlist);
  if (!pool.length) return null;
  const scope = playlist?.songs.length ? playlist.id : 'library';
  let bag = ctx.player.bag;
  if (!bag || bag.scope !== scope) bag = { scope, ids: [] };
  // Songs removed from the pool since the round started are left out.
  bag.ids = bag.ids.filter((id) => pool.some(({ song }) => song.id === id));
  if (!bag.ids.length) {
    const playing = ctx.player.current?.songId;
    bag.ids = pool.map(({ song }) => song.id).filter((id) => id !== playing);
    // A pool with a single song plays it again.
    if (!bag.ids.length) bag.ids = pool.map(({ song }) => song.id);
  }
  const [id] = bag.ids.splice(Math.floor(Math.random() * bag.ids.length), 1);
  ctx.player.bag = bag;
  return pool.find(({ song }) => song.id === id) ?? null;
}

function playRandom(ctx, playlist) {
  const pick = shuffleNext(ctx, playlist);
  if (!pick) return false;
  const index = ctx.library.findPlaylist(pick.playlistId).songs.findIndex((song) => song.id === pick.song.id);
  return playTrack(ctx, { ...songTrack(pick.song), playlistId: pick.playlistId, index });
}

// Starts a whole playlist: its first song, or a random one in shuffle order.
function startPlaylist(ctx, playlist) {
  if (ctx.playOrder === 'shuffle') return playRandom(ctx, playlist);
  const song = playlist.songs[0];
  if (!song) return false;
  return playTrack(ctx, { ...songTrack(song), playlistId: playlist.id, index: 0 });
}

function previousTrack(ctx) {
  const previous = ctx.player.history.at(-1);
  if (!previous || !sendTrack(ctx, previous)) return false;
  ctx.player.history = ctx.player.history.slice(0, -1);
  setCurrent(ctx, previous);
  return true;
}

function songTrack(song) {
  return { songId: song.id, videoId: song.videoId, title: song.title, artist: song.artist };
}

// The extension asks for the next command with every report. Each command is handed out once.
app.get('/api/ytmusic/command', (req, res) => {
  const now = Date.now();
  req.ctx.youtubeCommands = req.ctx.youtubeCommands.filter((entry) => now - entry.at < COMMAND_TTL_MS);
  const next = req.ctx.youtubeCommands.shift() ?? null;
  res.json({ command: next && { type: next.type, query: next.query } });
});

// Plays a playlist song now. Checks that the chosen player is connected first, so nothing changes when it isn't.
app.post('/api/player/play', (req, res) => {
  const playlist = req.ctx.library.findPlaylist(req.body?.playlistId);
  const index = playlist?.songs.findIndex((song) => song.id === req.body?.songId) ?? -1;
  if (index < 0) return res.status(404).json({ error: 'Lagu tidak ditemukan' });
  if (!playerReady(req.ctx)) return res.status(409).json({ error: notConnectedMessage(req.ctx) });
  if (!playTrack(req.ctx, { ...songTrack(playlist.songs[index]), playlistId: playlist.id, index })) {
    return res.status(409).json({ error: NO_LINK });
  }
  res.json({ ok: true });
});

app.post('/api/player/control', (req, res) => {
  const action = req.body?.action;
  if (!['toggle', 'next', 'prev'].includes(action)) return res.status(400).json({ error: 'Kontrol tidak dikenal' });
  if (!playerReady(req.ctx)) return res.status(409).json({ error: notConnectedMessage(req.ctx) });
  if (action === 'toggle') {
    sendControl(req.ctx, 'toggle');
    return res.json({ ok: true });
  }
  const moved = action === 'next' ? nextTrack(req.ctx) : previousTrack(req.ctx);
  if (!moved) return res.status(404).json({ error: action === 'next' ? 'Tidak ada lagu berikutnya' : 'Tidak ada lagu sebelumnya' });
  res.json({ ok: true });
});

// The player page calls this when a video ends, so the next one starts on its own.
app.post('/api/player/ended', (req, res) => {
  res.json({ ok: true, moved: nextTrack(req.ctx) });
});

// The player page calls this when a video can't be played here (blocked by its owner, age or region limits,
// or removed). The server tries other uploads of the same song: ten from one search, then, if all of those fail,
// ten more from a search for its lyrics video. Each one that fails is remembered, so none is tried twice.
// The playlist's link is updated to the upload being tried, so a song that worked once keeps working.
// With no YouTube key, or no upload left, the player moves on to the next track.
const REPLACEMENT_SEARCHES = ['', ' lyrics'];

app.post('/api/player/blocked', async (req, res) => {
  const ctx = req.ctx;
  const entry = ctx.player.current;
  const key = youtubeKeyOf(ctx);
  if (entry && key && entry.videoId === req.body?.videoId) {
    const tried = new Set([...(entry.tried ?? []), entry.videoId]);
    let candidates = entry.candidates ?? [];
    let searches = entry.searches ?? 0;
    let next = candidates.find((video) => !tried.has(video.videoId));
    while (!next && searches < REPLACEMENT_SEARCHES.length) {
      const query = [entry.title, entry.artist].filter(Boolean).join(' ') + REPLACEMENT_SEARCHES[searches];
      searches += 1;
      const found = await searchVideos(query, key, 10).catch(() => []);
      candidates = [...candidates, ...found];
      next = candidates.find((video) => !tried.has(video.videoId));
    }
    if (next) {
      const replacement = { ...entry, videoId: next.videoId, tried: [...tried], candidates, searches };
      if (sendTrack(ctx, replacement)) {
        setCurrent(ctx, replacement);
        if (entry.songId) ctx.library.replaceVideo(entry.songId, next.videoId);
        return res.json({ ok: true, replaced: true });
      }
    }
  }
  res.json({ ok: true, replaced: false, moved: nextTrack(ctx) });
});

// Plays a whole playlist from the start, or a random song from it in shuffle order.
app.post('/api/player/start-playlist', (req, res) => {
  const playlist = req.ctx.library.findPlaylist(req.body?.playlistId);
  if (!playlist) return res.status(404).json({ error: 'Playlist tidak ditemukan' });
  if (!playlist.songs.length && req.ctx.playOrder !== 'shuffle') {
    return res.status(400).json({ error: 'Playlist ini masih kosong' });
  }
  if (!playerReady(req.ctx)) return res.status(409).json({ error: notConnectedMessage(req.ctx) });
  if (!startPlaylist(req.ctx, playlist)) {
    return res.status(409).json({ error: 'Tidak ada lagu yang bisa diputar. Di mode player, lagu perlu link YouTube.' });
  }
  res.json({ ok: true });
});

app.post('/api/music/playorder', (req, res) => {
  const order = req.body?.order;
  if (!['playlist', 'shuffle'].includes(order)) return res.status(400).json({ error: 'Urutan tidak dikenal' });
  req.ctx.playOrder = order;
  req.ctx.player.bag = null;
  saveMusicSettings(req.ctx);
  res.json({ playOrder: order });
});

// Chooses how songs are played. The panel shows the choice; the extension only plays in extension mode.
app.post('/api/music/ytmode', (req, res) => {
  const mode = req.body?.mode;
  if (!['player', 'extension'].includes(mode)) return res.status(400).json({ error: 'Mode tidak dikenal' });
  req.ctx.ytMode = mode;
  saveMusicSettings(req.ctx);
  res.json({ ytMode: mode, playOrder: req.ctx.playOrder });
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

// ---- Apple Music: token untuk MusicKit dan laporan lagu dari halaman Apple Music ----

// The Apple Music page asks for a token when it opens. The private key itself never leaves the server.
app.get('/api/applemusic/token', (req, res) => {
  if (!appleToken) {
    return res.status(503).json({ error: 'Apple Music belum disiapkan di server. Isi APPLE_TEAM_ID, APPLE_KEY_ID, dan kunci di .env.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ token: appleToken() });
});

app.post('/api/applemusic/report', (req, res) => {
  req.ctx.applemusic.report(req.body || {});
  res.json({ ok: true });
});

// ---- Lirik: cari dan pilih lirik per lagu ----

app.get('/api/lyrics/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.json({ results: [] });
  try {
    res.json({ results: await searchLyrics(query) });
  } catch {
    res.status(502).json({ error: 'Pencarian lirik gagal, coba lagi' });
  }
});

// id null removes the pick, so the song goes back to automatic lyrics.
app.post('/api/lyrics/override', (req, res) => {
  const key = String(req.body?.key || '').slice(0, 300);
  const id = req.body?.id ?? null;
  if (!key) return res.status(400).json({ error: 'Belum ada lagu yang diputar' });
  if (id === null) {
    delete req.ctx.lyricOverrides[key];
  } else if (Number.isInteger(Number(id)) && Number(id) > 0) {
    req.ctx.lyricOverrides[key] = { id: Number(id) };
  } else {
    return res.status(400).json({ error: 'Pilihan lirik tidak valid' });
  }
  saveLyricOverrides(req.ctx);
  refreshLyrics(req.ctx, key);
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
  // The overlay shows the current song right away instead of waiting for the next change.
  snapshotFor: (userId) => {
    const ctx = contextFor(userId);
    return [
      { type: 'status', ...ctx.live.status() },
      nowPlayingMessage(ctx, 'spotify'),
      nowPlayingMessage(ctx, 'youtube'),
      nowPlayingMessage(ctx, 'applemusic'),
      lyricsMessage(ctx, 'spotify'),
      lyricsMessage(ctx, 'youtube'),
      lyricsMessage(ctx, 'applemusic'),
    ];
  },
});

server.listen(PORT, HOST, () => {
  console.log(`Listening     : ${HOST}:${PORT}`);
  console.log(`Panel kontrol : ${PUBLIC_URL}`);
  console.log(`Daftar / masuk: ${PUBLIC_URL}/login`);
  console.log(`Callback Spotify: ${PUBLIC_URL}/api/spotify/callback`);
  if (!process.env.PUBLIC_URL && HOST !== '127.0.0.1') {
    console.warn('PERINGATAN: PUBLIC_URL belum diisi, jadi login Spotify akan kembali ke 127.0.0.1 dan gagal.');
  }
});

async function shutdown() {
  for (const ctx of contexts.values()) {
    ctx.spotify.stop();
    ctx.youtube.stop();
    ctx.applemusic.stop();
    ctx.feed.flush();
    await ctx.live.stop();
  }
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
