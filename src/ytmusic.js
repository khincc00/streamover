// Receives the song playing in YouTube Music from the Chrome extension in extension/.
// The extension reports every couple of seconds. When the reports stop (tab closed),
// the track is treated as gone so the overlay clears.
const STALE_MS = 8000;
const CHECK_MS = 2000;

const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');
// Only https images are passed to the overlays, same rule as normalize.js.
const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://') ? url.slice(0, 500) : '');

export class YouTubeMusicBridge {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.track = null;
    this.lastSeen = 0;
    this.live = false;
    this.timer = null;
  }

  report(data = {}) {
    const title = text(data.title);
    this.track = title
      ? { playing: Boolean(data.playing), title, artist: text(data.artist), image: safeUrl(data.image) }
      : null;
    this.lastSeen = Date.now();
    this.onChange();
  }

  isLive() {
    return Date.now() - this.lastSeen < STALE_MS;
  }

  nowPlaying() {
    return this.isLive() ? this.track : null;
  }

  status() {
    return { connected: this.isLive(), nowPlaying: this.nowPlaying() };
  }

  // Reports stop without a final message, so check for that and tell listeners once.
  start() {
    this.timer = setInterval(() => {
      const live = this.isLive();
      if (live !== this.live) {
        this.live = live;
        this.onChange();
      }
    }, CHECK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }
}
