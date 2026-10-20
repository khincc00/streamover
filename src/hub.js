import { WebSocketServer } from 'ws';

// WebSocket hub that pushes events to the control panel and every OBS overlay.
export function createHub(server, { snapshot }) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', ...snapshot() }));
  });

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  return { broadcast };
}
