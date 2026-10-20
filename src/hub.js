import { WebSocketServer } from 'ws';

// WebSocket hub that pushes events to the control panel and every OBS overlay.
// `allow(req)` decides whether a connection may listen, so chat isn't readable by anyone with the URL.
export function createHub(server, { snapshot, allow = () => true }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, done) => done(allow(info.req)),
  });

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
