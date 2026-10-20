import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError } from 'tiktok-live-connector';
import { normalizeEvent } from './normalize.js';

// Keeps one TikTok Live connection at a time and reports its state.
export class LiveSession {
  constructor({ onEvent, onStatus }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.conn = null;
    this.state = 'idle';
    this.username = null;
    this.roomId = null;
    this.error = null;
  }

  status() {
    return { state: this.state, username: this.username, roomId: this.roomId, error: this.error };
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onStatus(this.status());
  }

  async start(username) {
    await this.stop();

    // processInitialData: false skips the chat history TikTok sends on join,
    // so old messages don't show up on the overlay.
    const conn = new TikTokLiveConnection(username, { processInitialData: false });
    this.conn = conn;
    this.username = username;
    this.roomId = null;
    this.setState('connecting');

    const relay = [WebcastEvent.CHAT, WebcastEvent.GIFT, WebcastEvent.FOLLOW, WebcastEvent.SHARE, WebcastEvent.ROOM_USER];
    for (const type of relay) {
      conn.on(type, (data) => {
        if (this.conn !== conn) return;
        const event = normalizeEvent(type, data);
        if (event) this.onEvent(event);
      });
    }

    conn.on(ControlEvent.DISCONNECTED, () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.setState('disconnected');
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.setState('ended');
    });

    try {
      const state = await conn.connect();
      if (this.conn !== conn) return;
      this.roomId = state.roomId;
      this.setState('connected');
    } catch (err) {
      if (this.conn === conn) this.conn = null;
      const message = err instanceof UserOfflineError ? 'Akun ini sedang tidak live' : err.message;
      this.setState('error', message);
      throw new Error(message);
    }
  }

  async stop() {
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        await conn.disconnect();
      } catch {
        // Already closed; nothing else to clean up.
      }
    }
    this.username = null;
    this.roomId = null;
    this.setState('idle');
  }
}
