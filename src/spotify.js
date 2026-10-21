import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PLAYER_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
// Adding songs to the queue needs the playback permission too. Accounts connected before this
// change must connect again to grant it.
const SCOPE = 'user-read-currently-playing user-modify-playback-state';
// Short interval so a track change shows up within a couple of seconds.
const POLL_MS = 2000;

const b64url = (buf) => buf.toString('base64url');

// Only https images are passed to the overlays, same rule as normalize.js.
const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : '');

// Turns the currently-playing response into the small shape the overlays use.
function toNowPlaying(data) {
  const item = data?.item;
  if (!item) return null;
  const isEpisode = item.type === 'episode';
  return {
    playing: Boolean(data.is_playing),
    uri: item.uri || '',
    title: item.name || '',
    artist: isEpisode ? item.show?.name || '' : (item.artists || []).map((a) => a.name).join(', '),
    image: safeUrl(item.album?.images?.[0]?.url ?? item.images?.[0]?.url),
  };
}

// Connects one Spotify account with Authorization Code + PKCE, so no client secret is needed.
// The Client ID (set from the panel) and the refresh token are saved to one local file,
// so the connection survives a restart.
export class SpotifySession {
  constructor({ redirectUri, tokenFile, onChange }) {
    this.clientId = '';
    this.redirectUri = redirectUri;
    this.tokenFile = tokenFile;
    this.onChange = onChange;
    this.pending = null; // { state, verifier } while waiting for the browser to come back
    this.tokens = null; // { refreshToken, accessToken, expiresAt }
    this.nowPlaying = null;
    this.error = null;
    this.timer = null;
    this.polling = false;
    this.retryAt = 0;
  }

  status() {
    return {
      clientId: this.clientId,
      configured: Boolean(this.clientId),
      connected: Boolean(this.tokens),
      nowPlaying: this.nowPlaying,
      error: this.error,
    };
  }

  // Called once at startup to restore the saved Client ID and connection.
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.tokenFile, 'utf8'));
      this.clientId = saved.clientId || '';
      if (saved.refreshToken) {
        this.tokens = { refreshToken: saved.refreshToken, accessToken: null, expiresAt: 0 };
        this.startPolling();
      }
    } catch {
      // No saved settings yet.
    }
  }

  async setClientId(clientId) {
    if (!/^[A-Za-z0-9]{20,64}$/.test(clientId)) {
      throw new Error('Client ID Spotify tidak valid');
    }
    if (clientId !== this.clientId) {
      // A token belongs to the Client ID it was issued for, so a new ID means connecting again.
      this.stopPolling();
      this.tokens = null;
      this.nowPlaying = null;
      this.pending = null;
    }
    this.clientId = clientId;
    this.error = null;
    await this.save();
    this.onChange({ type: 'spotify', ...this.status() });
  }

  loginUrl() {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    this.pending = { state, verifier };

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPE,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return `${AUTH_URL}?${params}`;
  }

  async finishLogin(code, state) {
    if (!this.pending || this.pending.state !== state) {
      throw new Error('Sesi login Spotify tidak valid, coba lagi');
    }
    const { verifier } = this.pending;
    this.pending = null;

    const data = await this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
    });
    this.tokens = { refreshToken: data.refresh_token, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    this.error = null;
    await this.save();
    this.startPolling();
  }

  async disconnect() {
    this.stopPolling();
    this.tokens = null;
    this.nowPlaying = null;
    this.error = null;
    await this.save();
    this.onChange({ type: 'spotify', ...this.status() });
  }

  stop() {
    this.stopPolling();
  }

  startPolling() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (!this.tokens || this.polling || Date.now() < this.retryAt) return;
    this.polling = true;
    try {
      let res = await this.authorizedGet(PLAYER_URL);
      if (res.status === 401) {
        // Access token expired early. Refresh once and try again.
        this.tokens.expiresAt = 0;
        res = await this.authorizedGet(PLAYER_URL);
      }
      if (res.status === 429) {
        // Rate limited. Wait as long as Spotify asks before polling again.
        const seconds = Number(res.headers.get('Retry-After')) || 30;
        this.retryAt = Date.now() + seconds * 1000;
        throw new Error(`Spotify membatasi permintaan, dicoba lagi dalam ${seconds} detik`);
      }
      if (res.status === 204) {
        this.nowPlaying = null; // Nothing is playing.
      } else if (res.ok) {
        this.nowPlaying = toNowPlaying(await res.json());
      } else {
        throw new Error(`Spotify menjawab HTTP ${res.status}`);
      }
      this.error = null;
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // The refresh token was revoked. Ask the user to connect again.
        await this.disconnect();
        this.error = 'Koneksi Spotify berakhir, hubungkan ulang';
      } else {
        this.error = err.message;
      }
    } finally {
      this.polling = false;
      this.onChange({ type: 'spotify', ...this.status() });
    }
  }

  async authorizedGet(url) {
    const token = await this.accessToken();
    return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  // Sends a request with the account's token. If the token was rejected, refresh it once and try again.
  async authorized(url, init = {}) {
    const send = async () => fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${await this.accessToken()}` },
    });
    let res = await send();
    if (res.status === 401) {
      this.tokens.expiresAt = 0;
      res = await send();
    }
    return res;
  }

  // Finds the best match for a song request and returns it, or null if nothing matched.
  async searchTrack(query) {
    const params = new URLSearchParams({ q: query, type: 'track', limit: '1' });
    const res = await this.authorized(`https://api.spotify.com/v1/search?${params}`);
    if (!res.ok) throw new Error(`Pencarian Spotify gagal (HTTP ${res.status})`);
    const track = (await res.json()).tracks?.items?.[0];
    if (!track) return null;
    return { uri: track.uri, name: track.name, artist: (track.artists || []).map((a) => a.name).join(', ') };
  }

  // Adds a track to the account's Spotify queue. Needs Premium and an active Spotify device.
  async addToQueue(uri) {
    const res = await this.authorized(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
    if (res.status === 403) throw new Error('Izin antrean belum ada. Klik Hubungkan Spotify lagi di panel.');
    if (res.status === 404) throw new Error('Tidak ada perangkat Spotify yang aktif. Buka Spotify dulu.');
    if (!res.ok) throw new Error(`Gagal menambah ke antrean Spotify (HTTP ${res.status})`);
  }

  async accessToken() {
    if (!this.tokens) throw new Error('Spotify belum terhubung');
    if (this.tokens.accessToken && Date.now() < this.tokens.expiresAt - 60_000) {
      return this.tokens.accessToken;
    }
    const data = await this.requestToken({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken });
    this.tokens.accessToken = data.access_token;
    this.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    // Spotify may rotate the refresh token, so keep the newest one.
    if (data.refresh_token) {
      this.tokens.refreshToken = data.refresh_token;
      await this.save();
    }
    return this.tokens.accessToken;
  }

  async requestToken(fields) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...fields }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
      err.code = data.error;
      throw err;
    }
    return data;
  }

  async save() {
    const data = { clientId: this.clientId, refreshToken: this.tokens?.refreshToken ?? null };
    // Owner-only permissions, because the refresh token grants access to the account.
    await fs.writeFile(this.tokenFile, JSON.stringify(data), { mode: 0o600 });
  }
}
