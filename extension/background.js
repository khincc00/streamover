// Forwards reports from the YouTube Music tab to the Streamover server on this computer, and passes the
// commands the panel sends back (play a song, pause, next, previous) to that same tab.
// The overlay key saved in the options page tells the server which account the song belongs to.
// Requests from the extension are not blocked by the page's CORS rules.
const SERVER = 'http://127.0.0.1:3000/api/ytmusic';

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'nowplaying') return;
  chrome.storage.local
    .get('overlayKey')
    .then(async ({ overlayKey }) => {
      // Options not filled in yet: nothing to send to.
      if (!overlayKey) return;
      const key = `key=${encodeURIComponent(overlayKey)}`;
      await fetch(`${SERVER}/report?${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.data),
      });
      // Each command is handed out once, so only the tab that asked for it runs it.
      const res = await fetch(`${SERVER}/command?${key}`);
      const { command } = await res.json();
      if (command && sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { type: 'command', command });
    })
    .catch(() => {
      // Streamover is not running, or the key is wrong; the next report will try again.
    });
});
