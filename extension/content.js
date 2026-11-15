// Reads the song playing on music.youtube.com and passes it to the background worker.
// It also runs the panel's commands: play a song (found by search), pause, next, and previous.
const INTERVAL_MS = 2000;
const PENDING_KEY = 'streamover.pendingSearch';
// The player bar buttons. YT Music keeps these classes on its player.
const CONTROLS = {
  toggle: '#play-pause-button',
  next: '.next-button',
  prev: '.previous-button',
};

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

// Waits for an element that appears after the page loads, for up to about 10 seconds.
async function waitFor(find) {
  for (let tries = 0; tries < 40; tries += 1) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// Starts the first song in the search results. Double-clicking a row is how YT Music plays it.
async function playFirstResult() {
  const row = await waitFor(() => document.querySelector('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer'));
  if (!row) return;
  const button = row.querySelector('ytmusic-play-button-renderer');
  if (button) button.click();
  else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

// A play command opens the search page first. The search page then starts the first song.
const pending = sessionStorage.getItem(PENDING_KEY);
if (pending && location.pathname.startsWith('/search')) {
  sessionStorage.removeItem(PENDING_KEY);
  playFirstResult();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'command') return;
  const { command } = message;
  if (command.type === 'play') {
    sessionStorage.setItem(PENDING_KEY, command.query);
    location.href = `https://music.youtube.com/search?q=${encodeURIComponent(command.query)}`;
    return;
  }
  const selector = CONTROLS[command.type];
  if (selector) document.querySelector(selector)?.click();
});
