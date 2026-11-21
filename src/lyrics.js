// Lirik tersinkron dari LRCLIB (https://lrclib.net), basis data publik yang tidak perlu login.
// Lirik dari Spotify sendiri tidak dipakai, karena butuh cookie sp_dc milik tiap pengguna.
const API = 'https://lrclib.net/api';
const TIMEOUT_MS = 8_000;
const CACHE_MAX = 200;
// Durasi dianggap cocok kalau selisihnya tidak lebih dari ini (detik).
const DURATION_TOLERANCE_S = 3;
const USER_AGENT = 'Streamover/1.0';

// Lagu yang sama dipakai banyak akun, jadi hasilnya disimpan bersama. Yang disimpan: baris lirik, atau [] kalau tidak ada.
const cache = new Map();

// Mengubah teks LRC ("[00:12.34] baris") jadi daftar { time, text }, time dalam detik.
// Satu baris boleh punya beberapa stempel waktu (lirik yang diulang), dan baris kosong tetap disimpan sebagai jeda.
export function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, minutes, seconds] of stamps) {
      lines.push({ time: Number(minutes) * 60 + Number(seconds), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Kunci lagu YouTube dibuat dari judul dan artis, karena YouTube tidak punya ID lagu seperti Spotify.
// Dipakai untuk menyimpan pilihan lirik dan mencocokkan lirik dengan lagu yang sedang diputar.
const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function youtubeKey(title, artist) {
  return `yt:${normalize(title)}|${normalize(artist)}`;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // LRCLIB answers 400 when a required field is missing. That only means "not found" for us.
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`LRCLIB menjawab HTTP ${res.status}`);
  return res.json();
}

// Judul YouTube sering berisi keterangan seperti "(Official Video)" atau "[Lyrics]". Keterangan itu dibuang.
const NOISE = /official|video|audio|lyric|remaster|visualizer|music video|\bmv\b|\bhd\b|4k|explicit|topic/i;
export function cleanTitle(title = '') {
  return String(title)
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (match, inner) => (NOISE.test(inner) ? '' : match))
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nama channel YouTube sering diberi akhiran "VEVO" atau " - Topic".
export function cleanArtist(artist = '') {
  return String(artist)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pasangan judul dan artis yang dicoba berurutan, dari yang paling mungkin cocok.
// Judul "Artis - Lagu" (umum di YouTube) juga dicoba dengan artis dan judul ditukar posisinya.
function candidatesFor({ title = '', artist = '' }) {
  const list = [];
  const add = (t, a) => {
    if (t && !list.some((c) => c.title === t && c.artist === a)) list.push({ title: t, artist: a });
  };
  const cleanT = cleanTitle(title);
  const cleanA = cleanArtist(artist);
  add(cleanT, cleanA);
  add(String(title).trim(), cleanA);
  const dash = (cleanT || String(title).trim()).indexOf(' - ');
  if (dash > 0) {
    const base = cleanT || String(title).trim();
    add(base.slice(dash + 3).trim(), base.slice(0, dash).trim());
  }
  return list;
}

// Mencari lirik tersinkron untuk satu lagu. Setiap pasangan judul dan artis dicoba dengan pencarian yang tepat dulu,
// lalu pencarian longgar dengan durasi yang paling dekat.
export async function findSyncedLyrics({ title, artist, album, durationMs }) {
  const duration = Math.round((durationMs || 0) / 1000);
  for (const candidate of candidatesFor({ title, artist })) {
    const lrc = await findLrcFor(candidate, { album, duration });
    if (lrc) return parseLrc(lrc);
  }
  return [];
}

async function findLrcFor({ title, artist }, { album, duration }) {
  if (artist) {
    const exact = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) exact.set('album_name', album);
    if (duration) exact.set('duration', String(duration));
    const hit = await getJson(`${API}/get?${exact}`);
    if (hit?.syncedLyrics) return hit.syncedLyrics;
  }
  const query = artist ? { track_name: title, artist_name: artist } : { q: title };
  const results = (await getJson(`${API}/search?${new URLSearchParams(query)}`)) || [];
  const best = results
    .filter((r) => r.syncedLyrics && (!duration || Math.abs(r.duration - duration) <= DURATION_TOLERANCE_S))
    .sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration))[0];
  return best?.syncedLyrics || null;
}

// Kalau LRCLIB tidak menemukan lirik untuk lagu YouTube, judulnya dicari lewat Spotify.
// Hasil pencarian Spotify memberi judul dan artis yang rapi, yang lebih mudah dicocokkan.
// spotifyLookup(track) mengembalikan { name, artist, album, durationMs } atau null.
export async function findLyricsFor(track, spotifyLookup = null) {
  let lines = await findSyncedLyrics(track);
  if (lines.length === 0 && spotifyLookup) {
    const match = await spotifyLookup(track).catch(() => null);
    if (match) {
      lines = await findSyncedLyrics({ title: match.name, artist: match.artist, album: match.album, durationMs: match.durationMs });
    }
  }
  return lines;
}

// Lirik untuk satu lagu, dari cache kalau sudah pernah diambil. Error tidak disimpan, supaya dicoba lagi nanti.
export async function lyricsFor(key, track, spotifyLookup = null) {
  if (cache.has(key)) return cache.get(key);
  const lines = await findLyricsFor(track, spotifyLookup);
  cache.set(key, lines);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return lines;
}

// Daftar lirik untuk dipilih manual di panel. Hanya hasil yang punya lirik tersinkron.
export async function searchLyrics(query) {
  const results = (await getJson(`${API}/search?${new URLSearchParams({ q: query })}`)) || [];
  return results
    .filter((r) => r.syncedLyrics)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      title: r.trackName || r.name || '',
      artist: r.artistName || '',
      album: r.albumName || '',
      duration: Math.round(r.duration || 0),
    }));
}

// Lirik dari hasil pencarian yang dipilih manual.
export async function lyricsById(id) {
  const hit = await getJson(`${API}/get/${Number(id)}`);
  return hit?.syncedLyrics ? parseLrc(hit.syncedLyrics) : [];
}
