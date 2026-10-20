import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Accounts and sessions. Each account gets its own folder for settings and tokens.
// Passwords are stored as scrypt hashes, and sessions are stored as hashes of their token,
// so a copy of the data files can't be used to log in.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temporary file first, so a crash mid-write can't leave a broken file.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function samePassword(password, user) {
  const attempt = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

export class UserStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.users = readJson(this.usersFile, []);
    this.sessions = readJson(this.sessionsFile, {});
  }

  publicUser(user) {
    return { id: user.id, username: user.username, overlayKey: user.overlayKey };
  }

  createUser(rawUsername, password) {
    const username = String(rawUsername || '').trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error('Username 3–20 karakter: huruf kecil, angka, atau garis bawah');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new Error('Password minimal 8 karakter');
    }
    if (this.users.some((user) => user.username === username)) {
      throw new Error('Username sudah dipakai');
    }
    const { salt, hash } = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      username,
      salt,
      hash,
      overlayKey: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    writeJson(this.usersFile, this.users);
    return user;
  }

  verify(rawUsername, password) {
    const username = String(rawUsername || '').trim().toLowerCase();
    const user = this.users.find((item) => item.username === username);
    // Still hash when the user doesn't exist, so the response time doesn't reveal which names exist.
    if (!user) {
      hashPassword(String(password ?? ''));
      return null;
    }
    return samePassword(String(password ?? ''), user) ? user : null;
  }

  byId(id) {
    return this.users.find((user) => user.id === id) || null;
  }

  byOverlayKey(key) {
    if (!key) return null;
    const given = Buffer.from(String(key));
    return this.users.find((user) => {
      const stored = Buffer.from(user.overlayKey);
      return stored.length === given.length && crypto.timingSafeEqual(stored, given);
    }) || null;
  }

  // Returns a new session token. Only its hash is saved.
  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[sha256(token)] = { userId, expiresAt: Date.now() + SESSION_MS };
    writeJson(this.sessionsFile, this.sessions);
    return token;
  }

  userForSession(token) {
    if (!token) return null;
    const key = sha256(token);
    const session = this.sessions[key];
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      delete this.sessions[key];
      writeJson(this.sessionsFile, this.sessions);
      return null;
    }
    return this.byId(session.userId);
  }

  deleteSession(token) {
    if (!token) return;
    delete this.sessions[sha256(token)];
    writeJson(this.sessionsFile, this.sessions);
  }

  userDir(userId) {
    const dir = path.join(this.dataDir, 'users', userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
