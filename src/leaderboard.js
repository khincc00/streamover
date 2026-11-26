// Papan skor untuk satu sesi live: penggemar gift (top gifter) dan penonton yang paling banyak tap layar (top tap).
// Skor hanya naik selama sesi berjalan. Reset dilakukan saat live baru dimulai atau dari panel.
export const BOARDS = ['gifters', 'tappers'];
const TOP = 10;

// Sample rows for previews and the "kirim contoh" button. They never touch the real scores.
export const SAMPLE_BOARDS = {
  gifters: [
    { uniqueId: 'sample_1', nickname: 'Sari', avatar: '', score: 520 },
    { uniqueId: 'sample_2', nickname: 'Budi', avatar: '', score: 310 },
    { uniqueId: 'sample_3', nickname: 'Rina', avatar: '', score: 150 },
    { uniqueId: 'sample_4', nickname: 'Andi', avatar: '', score: 80 },
    { uniqueId: 'sample_5', nickname: 'Dewi', avatar: '', score: 20 },
  ],
  tappers: [
    { uniqueId: 'sample_6', nickname: 'Tap Master', avatar: '', score: 12450 },
    { uniqueId: 'sample_7', nickname: 'Kopi', avatar: '', score: 8230 },
    { uniqueId: 'sample_8', nickname: 'Lala', avatar: '', score: 4120 },
    { uniqueId: 'sample_9', nickname: 'Yoga', avatar: '', score: 1875 },
    { uniqueId: 'sample_10', nickname: 'Mira', avatar: '', score: 640 },
  ],
};
// Papan dikirim paling sering sekali per interval, supaya tap yang sangat cepat tidak membanjiri overlay.
const SEND_MS = 300;

export class Leaderboard {
  // `send(message)` sends a message to this account's overlays.
  constructor(send) {
    this.send = send;
    this.boards = Object.fromEntries(BOARDS.map((name) => [name, new Map()]));
    this.timers = {};
  }

  // Adds a normalized gift or like event. Gifts score their diamonds, taps score their like count.
  add(event) {
    const user = event.user;
    if (!user) return;
    if (event.type === 'gift') {
      const points = (event.gift?.diamonds || 0) * (event.gift?.count || 1);
      if (points > 0) this.score('gifters', user, points);
    } else if (event.type === 'like') {
      if (event.count > 0) this.score('tappers', user, event.count);
    }
  }

  score(name, user, points) {
    const key = user.uniqueId || user.nickname || '?';
    const board = this.boards[name];
    const entry = board.get(key) || { uniqueId: key, nickname: user.nickname || key, avatar: '', score: 0 };
    entry.nickname = user.nickname || entry.nickname;
    entry.avatar = user.avatar || entry.avatar;
    entry.score += points;
    board.set(key, entry);
    this.schedule(name);
  }

  top(name) {
    return [...this.boards[name].values()].sort((a, b) => b.score - a.score).slice(0, TOP);
  }

  message(name) {
    return { type: 'leaderboard', board: name, items: this.top(name) };
  }

  schedule(name) {
    if (this.timers[name]) return;
    this.timers[name] = setTimeout(() => {
      this.timers[name] = null;
      this.send(this.message(name));
    }, SEND_MS);
  }

  reset() {
    for (const name of BOARDS) {
      this.boards[name].clear();
      this.schedule(name);
    }
  }
}
