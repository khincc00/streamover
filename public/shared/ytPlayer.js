// The YouTube player used by the player page and by the dock in the panel. It plays the videos the server
// sends, reports what is playing every 2 seconds, and asks the server for the next track when a video ends.
// Browsers hold back sound until the page is clicked, so "unlock" is called from a button.

const STATES = { '-1': 'belum mulai', 0: 'selesai', 1: 'memutar', 2: 'dijeda', 3: 'memuat', 5: 'siap, belum diputar' };
// Messages for the errors the YouTube player reports.
const ERRORS = {
  2: 'ID video tidak valid.',
  5: 'Browser tidak bisa memutar video ini. Mencari versi lain…',
  100: 'Video tidak ditemukan atau sudah dihapus. Mencari versi lain…',
  101: 'Video ini diblokir pemiliknya di luar YouTube. Mencari versi lain…',
  150: 'Video ini diblokir pemiliknya di luar YouTube. Mencari versi lain…',
};
// Errors where the video will never play here, so the player moves on to the next one.
const SKIP_ERRORS = [2, 5, 100, 101, 150];

let apiReady = null;

// The IFrame API script loads once per page. Resolves when YT.Player can be used.
function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!apiReady) {
    apiReady = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.append(script);
    });
  }
  return apiReady;
}

// element: where the YouTube player is put. key: the overlay key, so reports are accepted.
// onStatus gets { state, lastError, needsClick, current } whenever something changes.
export function startYouTubePlayer({ element, key, onStatus = () => {} }) {
  const keyQuery = key ? `?key=${encodeURIComponent(key)}` : '';
  let player = null;
  let ready = false;
  let pending = null; // a load that came in before the player was ready
  let current = null; // { videoId, title, artist } of the track being played
  let unlocked = false; // the browser allowed sound after a click on this page
  let needsClick = false;
  let lastError = '';
  let retryTimer = null;
  let skipTimer = null;

  function emit() {
    const state = ready ? STATES[player.getPlayerState()] ?? 'tidak diketahui' : 'memuat player';
    onStatus({ state, lastError, needsClick, current });
  }

  function report() {
    const playing = ready && player.getPlayerState() === YT.PlayerState.PLAYING;
    const data = ready && current ? player.getVideoData?.() ?? {} : {};
    const source = `${keyQuery ? '&' : '?'}src=player`;
    fetch(`/api/ytmusic/report${keyQuery}${source}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: current?.title || data.title || '',
        artist: current?.artist || data.author || '',
        image: current ? `https://i.ytimg.com/vi/${current.videoId}/hqdefault.jpg` : '',
        playing,
      }),
    }).catch(() => {});
  }

  function load(message) {
    current = { videoId: message.videoId, title: message.title, artist: message.artist };
    if (!ready) {
      pending = message;
      return;
    }
    lastError = '';
    // A track was loaded by hand, so a pending skip from an earlier error must not move on again.
    clearTimeout(skipTimer);
    player.loadVideoById(message.videoId);
    // If the video hasn't started after a moment, the browser is holding the sound. Start it when the page
    // was already unlocked, otherwise ask for a click.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (player.getPlayerState() === YT.PlayerState.PLAYING) return;
      if (unlocked) player.playVideo();
      else needsClick = true;
      emit();
    }, 1500);
    emit();
  }

  function command(message) {
    if (message.action === 'load') load(message);
    if (message.action === 'toggle' && ready) {
      if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    }
  }

  // Called from a click, so the browser allows sound from now on.
  function unlock() {
    unlocked = true;
    needsClick = false;
    if (ready) player.playVideo();
    emit();
  }

  loadApi().then(() => {
    player = new YT.Player(element, {
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          ready = true;
          if (pending) {
            const next = pending;
            pending = null;
            load(next);
          }
          emit();
        },
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.PLAYING) {
            lastError = '';
            needsClick = false;
          }
          if (event.data === YT.PlayerState.ENDED) {
            fetch(`/api/player/ended${keyQuery}`, { method: 'POST' }).catch(() => {});
          }
          if (event.data === YT.PlayerState.CUED && unlocked) player.playVideo();
          emit();
        },
        onError: (event) => {
          lastError = ERRORS[event.data] || `Error YouTube ${event.data}.`;
          emit();
          // This video can't be played here, so the next one starts after a moment. The message stays
          // on screen until then, so it's clear why the song was skipped.
          if (SKIP_ERRORS.includes(event.data)) {
            clearTimeout(skipTimer);
            const blockedId = current?.videoId;
            skipTimer = setTimeout(async () => {
              // The server first looks for another upload of the same song; if there is none it moves on.
              // If it has nothing left to play, say so instead of leaving the error on screen.
              const res = await fetch(`/api/player/blocked${keyQuery}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: blockedId }),
              }).catch(() => null);
              const data = await res?.json().catch(() => ({}));
              if (data && !data.replaced && data.moved === false) {
                lastError = 'Tidak ada lagu berikutnya di antrean atau playlist. Lagu di atas dilewati.';
                emit();
              }
            }, 1500);
          }
        },
      },
    });
  });

  setInterval(() => {
    report();
    if (ready) emit();
  }, 2000);

  // For the progress bar and volume in the dock. Zeros until the player is ready.
  function progress() {
    if (!ready) return { current: 0, duration: 0 };
    return { current: player.getCurrentTime?.() ?? 0, duration: player.getDuration?.() ?? 0 };
  }

  // ratio is 0 to 1 along the track.
  function seek(ratio) {
    if (!ready) return;
    const duration = player.getDuration?.() ?? 0;
    if (duration) player.seekTo(duration * ratio, true);
  }

  function setVolume(volume) {
    if (ready) player.setVolume(volume);
  }

  return { command, unlock, progress, seek, setVolume };
}
