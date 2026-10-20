// Connects to the local hub and reconnects if the server restarts.
export function connectHub(onMessage) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // Overlays in OBS have no login, so the overlay key from their URL is passed along.
  const key = new URLSearchParams(location.search).get('key');
  const url = `${scheme}://${location.host}/ws${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  let delay = 1000;

  function open() {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 1000;
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // Ignore malformed messages.
      }
    };
    ws.onclose = () => {
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10000);
    };
  }

  open();
}
