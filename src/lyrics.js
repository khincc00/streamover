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

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB menjawab HTTP ${res.status}`);
  return res.json();
}

// Mencari lirik tersinkron untuk satu lagu. Pencarian pertama cocok persis (judul, artis, album, durasi).
// Kalau tidak ada, cari lewat judul dan artis, lalu ambil hasil yang durasinya paling dekat.
export async function findSyncedLyrics({ title, artist, album, durationMs }) {
  const duration = Math.round((durationMs || 0) / 1000);
  const exact = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) exact.set('album_name', album);
  if (duration) exact.set('duration', String(duration));

  let hit = await getJson(`${API}/get?${exact}`);
  if (!hit?.syncedLyrics) {
    const results = (await getJson(`${API}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`)) || [];
    hit = results
      .filter((r) => r.syncedLyrics && (!duration || Math.abs(r.duration - duration) <= DURATION_TOLERANCE_S))
      .sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration))[0];
  }
  return hit?.syncedLyrics ? parseLrc(hit.syncedLyrics) : [];
}

// Lirik untuk satu lagu Spotify, dari cache kalau sudah pernah diambil. Error tidak disimpan, supaya dicoba lagi nanti.
export async function lyricsFor(track) {
  if (cache.has(track.uri)) return cache.get(track.uri);
  const lines = await findSyncedLyrics(track);
  cache.set(track.uri, lines);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return lines;
}
