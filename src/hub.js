import { WebSocketServer } from 'ws';

// WebSocket hub. Every connection belongs to one account, so a user's chat, alerts, and
// status are only sent to that user's panel and overlays.
// `resolveUser(req)` returns the account id for a connection, or null to refuse it.
// `snapshotFor(userId)` returns the messages sent right after connecting.
export function createHub(server, { resolveUser, snapshotFor }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, done) => {
      const userId = resolveUser(info.req);
      if (!userId) return done(false);
      info.req.userId = userId;
      done(true);
    },
  });

  wss.on('connection', (ws, req) => {
    ws.userId = req.userId;
    for (const message of snapshotFor(req.userId)) ws.send(JSON.stringify(message));
  });

  function broadcast(userId, message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.userId === userId && client.readyState === client.OPEN) client.send(data);
    }
  }

  return { broadcast };
}
