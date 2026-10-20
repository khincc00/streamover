// Forwards reports from the YouTube Music tab to the Streamover server on this computer.
// Requests from the extension are not blocked by the page's CORS rules.
const SERVER = 'http://127.0.0.1:3000/api/ytmusic/report';

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'nowplaying') return;
  fetch(SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.data),
  }).catch(() => {
    // Streamover is not running; the next report will try again.
  });
});
