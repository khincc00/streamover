import crypto from 'node:crypto';
import fs from 'node:fs';

// Song requests from chat, written as "!req judul lagu". Each viewer can have one request waiting at a
// time, and the list is capped, so a busy chat can't flood it. The streamer removes a request when it's played.
export const QUEUE_LIMIT = 50;
const REQUEST_PATTERN = /^!req\s+(.{2,100})$/i;

// Returns the requested song, or null if the chat message isn't a request.
export function parseRequest(text) {
  const match = REQUEST_PATTERN.exec(String(text ?? '').trim());
  return match ? match[1].trim() : null;
}

export class RequestQueue {
  constructor(file) {
    this.file = file;
    this.items = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) this.items = saved;
    } catch {
      // No requests yet.
    }
  }

  // Oldest first, so the list reads in the order songs were asked for.
  list() {
    return this.items.slice();
  }

  // Returns { item } when added, or { error } with the reason.
  add({ uniqueId, nickname, song }) {
    if (this.items.length >= QUEUE_LIMIT) return { error: 'full' };
    if (this.items.some((item) => item.uniqueId === uniqueId)) return { error: 'already' };
    const item = {
      id: crypto.randomUUID(),
      uniqueId,
      nickname,
      song,
      at: Date.now(),
    };
    this.items.push(item);
    this.save();
    return { item };
  }

  // Adds details such as the Spotify match or an error, and returns the updated item.
  update(id, patch) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  clear() {
    this.items = [];
    this.save();
  }

  save() {
    // Write to a temporary file first, so a crash mid-write can't leave a broken list.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file);
  }
}
