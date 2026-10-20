// Reads the song playing on music.youtube.com and passes it to the background worker.
const INTERVAL_MS = 2000;

const textOf = (selector) => document.querySelector(selector)?.textContent?.trim() || '';

function readTrack() {
  const media = navigator.mediaSession?.metadata;
  const video = document.querySelector('video');
  const title = media?.title || textOf('ytmusic-player-bar .title');
  // The subtitle reads "Artist • Album • Year", so the artist is the first part.
  const artist = media?.artist || textOf('ytmusic-player-bar .subtitle').split('•')[0].trim();
  const image = media?.artwork?.at(-1)?.src || document.querySelector('ytmusic-player-bar img')?.src || '';
  const playing = navigator.mediaSession?.playbackState === 'playing' || Boolean(video && !video.paused);
  return { title, artist, image, playing };
}

setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: 'nowplaying', data: readTrack() });
  } catch {
    // The extension was reloaded; this page needs a refresh to reconnect.
  }
}, INTERVAL_MS);
