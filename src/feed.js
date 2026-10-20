import fs from 'node:fs';

// Recent activity (chat, gift, follow, share) for one account. Only the newest LIMIT events are kept,
// so the file stays small. Writes are batched so a busy chat doesn't write the file for every message.
export const FEED_LIMIT = 200;
const SAVE_DELAY_MS = 2000;

export class FeedBuffer {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) this.events = saved.slice(-FEED_LIMIT);
    } catch {
      // No history yet.
    }
  }

  add(event) {
    this.events.push({ ...event, at: Date.now() });
    if (this.events.length > FEED_LIMIT) this.events.splice(0, this.events.length - FEED_LIMIT);
    this.scheduleSave();
  }

  // Newest first. The caller asks for as many as it needs, up to FEED_LIMIT.
  recent(limit) {
    const count = Math.min(Math.max(Number(limit) || 60, 1), FEED_LIMIT);
    return this.events.slice(-count).reverse();
  }

  clear() {
    this.events = [];
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.events));
    fs.renameSync(tmp, this.file);
  }
}
