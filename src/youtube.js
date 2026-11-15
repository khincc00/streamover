// YouTube helpers for the built-in player. Playlist songs use links the streamer pastes; chat requests
// are found with a search, which needs a YouTube Data API key (YOUTUBE_API_KEY in .env).

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Returns the video ID from a YouTube link (youtu.be, watch, shorts, embed, music.youtube.com) or a bare ID,
// or null when the text doesn't contain one.
export function parseVideoId(input) {
  const text = String(input ?? '').trim();
  if (VIDEO_ID.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return VIDEO_ID.test(id) ? id : null;
  }
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
  const fromQuery = url.searchParams.get('v');
  if (VIDEO_ID.test(fromQuery ?? '')) return fromQuery;
  const match = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
  return match ? match[1] : null;
}

// The country the stream is played from. Videos blocked there won't play. Indonesia unless YOUTUBE_REGION is set.
function region() {
  return (process.env.YOUTUBE_REGION || 'ID').toUpperCase();
}

// Whether a video (as videos.list returns it, with status and contentDetails) can play in the player here:
// the owner allows embedding, it isn't age-restricted (those never play embedded), and it isn't blocked in the region.
function canPlay(video) {
  if (!video.status?.embeddable) return false;
  if (video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') return false;
  const limits = video.contentDetails?.regionRestriction;
  if (limits?.blocked?.includes(region())) return false;
  if (limits?.allowed && !limits.allowed.includes(region())) return false;
  return true;
}

// Status and restrictions for these videos, 50 per call (1 quota unit each).
async function videoDetails(ids, apiKey) {
  const videos = [];
  for (let start = 0; start < ids.length; start += 50) {
    const params = new URLSearchParams({ part: 'status,contentDetails', id: ids.slice(start, start + 50).join(','), key: apiKey });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `YouTube menolak cek video (HTTP ${res.status})`);
    videos.push(...(data.items ?? []));
  }
  return videos;
}

// Versions that aren't the song as recorded. They go after the originals, unless the search asks for one.
const VARIANT = /slowed|reverb|sped ?up|nightcore|8d|karaoke|cover|remix|drum|transcription|instrumental|1 hour|loop|reaction/i;

function originalsFirst(videos, query) {
  if (VARIANT.test(query)) return videos;
  return [...videos].sort((a, b) => Number(VARIANT.test(a.title)) - Number(VARIANT.test(b.title)));
}

// Finds videos for a song that can play here, best match first. Each is { videoId, title, channel }.
// max is how many search results are looked at; fewer may come back once unplayable ones are left out.
// Throws when YouTube refuses the call (for example a wrong key or a used-up quota), so the caller can show why.
export async function searchVideos(query, apiKey, max = 5) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: String(max),
    q: query,
    videoEmbeddable: 'true',
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `YouTube menolak pencarian (HTTP ${res.status})`);
  const found = (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({ videoId: item.id.videoId, title: item.snippet?.title ?? query, channel: item.snippet?.channelTitle ?? '' }));
  // The search filter only knows about embedding; age and region limits need the videos' own details.
  const playable = new Set((await videoDetails(found.map((video) => video.videoId), apiKey)).filter(canPlay).map((video) => video.id));
  return originalsFirst(found.filter((video) => playable.has(video.videoId)), query);
}

// The best playable video for a request, or null when nothing matched.
export async function searchVideo(query, apiKey) {
  const [video] = await searchVideos(query, apiKey, 5);
  return video ?? null;
}

// Whether a video can be played in the player here. Returns 'ok', 'blocked' (embedding off, age-restricted, or
// blocked in the region), or 'missing' (the video doesn't exist). Throws if YouTube refuses the call.
export async function checkEmbeddable(videoId, apiKey) {
  const [video] = await videoDetails([videoId], apiKey);
  if (!video) return 'missing';
  return canPlay(video) ? 'ok' : 'blocked';
}

// The playlist ID from a YouTube playlist link, or a bare playlist ID. Returns null when there isn't one.
export function parsePlaylistId(input) {
  const text = String(input ?? '').trim();
  if (/^(PL|UU|LL|FL|OL|RD)[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
  const list = url.searchParams.get('list');
  return list && /^[A-Za-z0-9_-]{10,}$/.test(list) ? list : null;
}

// Reads the videos of a YouTube playlist, up to max. Deleted and private videos are left out.
export async function fetchPlaylistItems(listId, apiKey, max) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId: listId, maxResults: '50', key: apiKey });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // YouTube answers a playlist it can't open with one of these reasons; the message says what to check.
      const reason = data?.error?.errors?.[0]?.reason;
      if (reason === 'playlistNotFound' || reason === 'invalidValue' || res.status === 404) {
        throw new Error('Playlist tidak ditemukan atau tidak bisa dibuka. Pastikan playlist-nya publik dan link-nya benar.');
      }
      throw new Error(data?.error?.message || `YouTube menolak import (HTTP ${res.status})`);
    }
    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const title = item.snippet?.title ?? '';
      if (!videoId || title === 'Deleted video' || title === 'Private video') continue;
      items.push({ videoId, title, channel: item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? '' });
      if (items.length >= max) return items;
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
  return items;
}

// The IDs, out of these, that can be played in the player here.
export async function fetchEmbeddableIds(ids, apiKey) {
  return new Set((await videoDetails(ids, apiKey)).filter(canPlay).map((video) => video.id));
}
