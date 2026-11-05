// Forwards reports from the YouTube Music tab to the Streamover server on this computer.
// The overlay key saved in the options page tells the server which account the song belongs to.
// Requests from the extension are not blocked by the page's CORS rules.
const SERVER = 'http://127.0.0.1:3000/api/ytmusic/report';

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'nowplaying') return;
  chrome.storage.local
    .get('overlayKey')
    .then(({ overlayKey }) => {
      // Options not filled in yet: nothing to send to.
      if (!overlayKey) return;
      return fetch(`${SERVER}?key=${encodeURIComponent(overlayKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.data),
      });
    })
    .catch(() => {
      // Streamover is not running, or the key is wrong; the next report will try again.
    });
});
