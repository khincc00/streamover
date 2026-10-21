import { connectHub } from '/shared/ws.js';
import { chatRow } from '/shared/chatRow.js';
import { CHAT_TEMPLATES, DEFAULT_CHAT_TEMPLATE, isChatTemplate } from '/shared/chatTemplates.js';
import { CHAT_ANIMATIONS, DEFAULT_CHAT_STYLE, applyStyle, normalizeStyle } from '/shared/chatStyle.js';
import { NOWPLAYING_TEMPLATES, DEFAULT_NOWPLAYING_TEMPLATE, isNowPlayingTemplate } from '/shared/nowplayingTemplates.js';
import { DEFAULT_PERSPECTIVE, PERSPECTIVE_LIMITS } from '/shared/perspective.js';

const $ = (id) => document.getElementById(id);

const PREVIEW_WIDTH = 1920;
const FEED_MAX = 60;
const SETTINGS_KEY = 'streamover.settings';

const OVERLAYS = {
  chat: { label: 'Chat', file: 'chat.html' },
  alerts: { label: 'Alert', file: 'alerts.html' },
  nowplaying: { label: 'Musik', file: 'nowplaying.html' },
};

// Halaman kustomisasi (#/chat, #/alert, #/musik) dan overlay yang dipratinjaunya.
const VIEWS = { chat: 'chat', alert: 'alerts', musik: 'nowplaying' };

const STATE_LABEL = {
  idle: 'Belum terhubung',
  connecting: 'Menghubungkan…',
  connected: 'Terhubung ke live',
  disconnected: 'Live terputus',
  ended: 'Live sudah berakhir',
  error: 'Gagal terhubung',
};

const FEED_TEXT = {
  chat: (msg) => msg.text,
  gift: (msg) => `mengirim ${msg.gift.name} x${msg.gift.count}`,
  follow: () => 'mulai mengikuti',
  share: () => 'membagikan live ini',
};

const settings = {
  size: 22,
  max: 15,
  duration: 4,
  template: DEFAULT_CHAT_TEMPLATE,
  spotifyTemplate: DEFAULT_NOWPLAYING_TEMPLATE,
  username: '',
  ...DEFAULT_CHAT_STYLE,
  ...readJson(SETTINGS_KEY),
};

// Perspektif per overlay. Saved values are clamped so a bad saved value can't break the overlay.
const PERSP_KEYS = ['chat', 'alerts', 'nowplaying'];

// Makes sure every setting has a valid value, whether it came from this browser or the server.
function sanitizeSettings() {
  if (!isChatTemplate(settings.template)) settings.template = DEFAULT_CHAT_TEMPLATE;
  if (!isNowPlayingTemplate(settings.spotifyTemplate)) settings.spotifyTemplate = DEFAULT_NOWPLAYING_TEMPLATE;
  Object.assign(settings, normalizeStyle(settings));
  settings.persp = normalizePersp(settings.persp);
}
sanitizeSettings();

function chatStyle() {
  return normalizeStyle(settings);
}

const SAMPLE_CHAT = [
  { nickname: 'rina.live', text: 'halo semua!' },
  { nickname: 'budi_kopi', text: 'keren banget kontennya' },
  { nickname: 'sari88', text: 'siap ikut giveaway nanti' },
];

let skipWelcome = false; // Set when the user picks "Lewati, coba tanpa live".
let dashboardShown = false;
let previousState = 'idle';
let previewTimer = null;
let spotifyStatus = null;
let youtubeStatus = null;
let musicSource = 'spotify'; // Kept on the server, which decides what the overlay shows.
const counts = { chat: 0, gift: 0, follow: 0, share: 0 };

// localStorage is only used for per-browser conveniences, so every access is guarded.
function readLocal(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function readJson(key) {
  try {
    return JSON.parse(readLocal(key)) || {};
  } catch {
    return {};
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the panel still works without it.
  }
}

// Settings are kept in this browser for instant reloads and on the server, which is the copy
// that survives a cleared or different browser. Saves are batched so a slider drag sends one request.
let saveTimer = null;
function saveSettings() {
  writeLocal(SETTINGS_KEY, JSON.stringify(settings));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => pushSettings(false), 300);
}

// keepalive lets the request finish even while the page is closing.
async function pushSettings(keepalive) {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      keepalive,
    });
    // A 404 here means the running server is older than this panel and needs a restart.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    if (!keepalive) toast('Pengaturan belum tersimpan di server');
  }
}

// A change made just before closing the tab is still sent.
window.addEventListener('pagehide', () => {
  if (saveTimer) pushSettings(true);
});

async function loadSettings() {
  try {
    const saved = await api('/api/settings');
    if (Object.keys(saved).length) {
      Object.assign(settings, saved);
      sanitizeSettings();
    } else {
      // First run with the server copy: send this browser's settings up.
      saveSettings();
    }
  } catch {
    // The server can't be reached, so this browser's copy stays in use.
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
}

// Template, animasi, dan warna yang sama dipakai chat dan alert.
function addStyleParams(params) {
  params.set('template', settings.template);
  const style = chatStyle();
  params.set('anim', style.anim);
  params.set('dur', style.dur);
  if (style.custom) {
    params.set('custom', '1');
    params.set('accent', style.accent.slice(1));
    params.set('text', style.text.slice(1));
    params.set('bg', style.bg.slice(1));
  }
}

// Overlay URLs carry the current settings so OBS and the preview match.
function overlayUrl(key) {
  const params = new URLSearchParams();
  if (key === 'chat') {
    params.set('size', settings.size);
    params.set('max', settings.max);
    addStyleParams(params);
  }
  if (key === 'alerts') {
    params.set('duration', settings.duration * 1000);
    addStyleParams(params);
  }
  if (key === 'nowplaying') params.set('template', settings.spotifyTemplate);
  const persp = settings.persp[key];
  params.set('rx', persp.rx);
  params.set('ry', persp.ry);
  params.set('pd', persp.depth);
  // Only set when the server has a password, so OBS can open the overlay without logging in.
  if (overlayKey) params.set('key', overlayKey);
  const query = params.toString();
  return `${location.origin}/overlay/${OVERLAYS[key].file}${query ? `?${query}` : ''}`;
}

// Whether the server asks for a password, and the key OBS overlays need when it does.
let overlayKey = '';
async function loadSession() {
  try {
    const session = await api('/api/session');
    overlayKey = session.overlayKey || '';
    $('logout').hidden = !session.authEnabled;
    // Show the redirect exactly as the server sends it, so it can be copied into Spotify's dashboard.
    if (session.publicUrl) $('spotifyRedirect').textContent = `${session.publicUrl}/api/spotify/callback`;
  } catch {
    // The panel still works without this; the overlay links just won't carry a key.
  }
}

$('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  location.href = '/login';
});

// ---- Routing: beranda dan satu halaman per kustomisasi ----

function currentView() {
  const name = location.hash.replace(/^#\/?/, '');
  return Object.hasOwn(VIEWS, name) ? name : 'home';
}

function currentOverlay() {
  return VIEWS[currentView()] ?? null;
}

function route() {
  const view = currentView();
  for (const section of document.querySelectorAll('[data-view]')) {
    section.hidden = section.dataset.view !== view;
  }
  refreshPreview();
}

// ---- Status ----

function renderStatus(status) {
  const state = status.state;
  if (state === 'connecting' && previousState !== 'connecting') {
    for (const key of Object.keys(counts)) counts[key] = 0;
    renderCounts();
  }
  previousState = state;

  $('status').dataset.state = state;
  $('statusText').textContent = status.username && state !== 'idle'
    ? `${STATE_LABEL[state]} · @${status.username}`
    : STATE_LABEL[state] || state;

  const busy = state === 'connecting';
  const connected = state === 'connected';
  $('connect').disabled = busy || connected;
  $('connect').textContent = busy ? 'Menghubungkan…' : 'Hubungkan';
  $('disconnect').disabled = state === 'idle';
  $('error').textContent = status.error || '';

  $('welcomeConnect').disabled = busy || connected;
  $('welcomeConnect').textContent = busy ? 'Menghubungkan…' : 'Hubungkan';
  $('welcomeError').textContent = status.error || '';

  if (!connected) $('viewers').textContent = '0';
  if (status.username && !$('username').value) $('username').value = status.username;
  if (status.username && !$('welcomeUsername').value) $('welcomeUsername').value = status.username;
  renderView(state);
}

// The start card shows until the account is connected, unless the user skips it.
// An error while the dashboard is already open stays on the dashboard.
function renderView(state) {
  const onboarding = !skipWelcome
    && (state === 'idle' || ((state === 'connecting' || state === 'error') && !dashboardShown));
  dashboardShown = !onboarding;
  $('welcome').hidden = !onboarding;
  $('dashboard').hidden = onboarding;
}

// ---- Spotify ----

function renderSpotify(status) {
  spotifyStatus = status;
  const connected = status.connected;
  if (status.clientId && !$('spotifyClientId').value) $('spotifyClientId').value = status.clientId;
  $('spotifyConnect').disabled = connected || !status.configured;
  $('spotifyConnect').textContent = connected ? 'Terhubung' : 'Hubungkan Spotify';
  $('spotifyDisconnect').disabled = !connected;

  const track = status.nowPlaying;
  let text = 'Belum terhubung';
  if (!status.configured) text = 'Isi Client ID lalu klik Simpan';
  else if (connected && track) text = `${track.playing ? 'Diputar' : 'Dijeda'}: ${track.title}${track.artist ? ` — ${track.artist}` : ''}`;
  else if (connected) text = 'Tidak ada lagu yang sedang diputar';
  if (status.error) text = status.error;
  $('spotifyText').textContent = text;
  renderSummaries();
}

// ---- Sumber musik: Spotify atau YouTube Music ----

const SOURCE_LABEL = { spotify: 'Spotify', youtube: 'YouTube Music' };

function renderMusicSource() {
  for (const chip of document.querySelectorAll('#musicSource .chip')) {
    chip.setAttribute('aria-checked', String(chip.dataset.source === musicSource));
  }
  renderSummaries();
}

async function chooseMusicSource(source) {
  try {
    const data = await api('/api/music/source', { source });
    musicSource = data.source;
    renderMusicSource();
    toast(`Sumber musik: ${SOURCE_LABEL[musicSource]}`);
  } catch (err) {
    toast(err.message);
  }
}

function renderYouTube(status) {
  youtubeStatus = status;
  const track = status.nowPlaying;
  let text = 'Belum ada data dari YouTube Music';
  if (track) text = `${track.playing ? 'Diputar' : 'Dijeda'}: ${track.title}${track.artist ? ` — ${track.artist}` : ''}`;
  else if (status.connected) text = 'Extension aktif, tidak ada lagu yang diputar';
  $('youtubeText').textContent = text;
  renderSummaries();
}

// ---- Antrean request dari chat ----

function renderQueue(items) {
  const list = $('queueList');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Belum ada permintaan.';
    list.append(empty);
    return;
  }
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const text = document.createElement('div');
    text.className = 'feed-text';
    const song = document.createElement('strong');
    song.textContent = `${index + 1}. ${item.song}`;
    const who = document.createElement('span');
    who.textContent = item.nickname;
    text.append(song, who);

    const done = document.createElement('button');
    done.className = 'btn small';
    done.type = 'button';
    done.textContent = 'Selesai';
    done.addEventListener('click', async () => {
      try {
        renderQueue(await api(`/api/queue/${encodeURIComponent(item.id)}/done`, {}));
      } catch (err) {
        toast(err.message);
      }
    });

    li.append(text, done);
    list.append(li);
  });
}

// ---- Stats and feed ----

function renderCounts() {
  for (const [key, value] of Object.entries(counts)) {
    document.querySelector(`[data-count="${key}"]`).textContent = value.toLocaleString('id-ID');
  }
}

function avatarNode(user) {
  if (user.avatar) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = user.avatar;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  const initial = document.createElement('span');
  initial.className = 'avatar';
  initial.textContent = (user.nickname || '?').charAt(0).toUpperCase();
  return initial;
}

function addFeed(msg) {
  const feed = $('feed');
  feed.querySelector('.empty')?.remove();

  const item = document.createElement('li');

  const text = document.createElement('div');
  text.className = 'feed-text';
  const name = document.createElement('strong');
  name.textContent = msg.user.nickname;
  const detail = document.createElement('span');
  detail.textContent = FEED_TEXT[msg.type](msg);
  text.append(name, detail);

  const badge = document.createElement('span');
  badge.className = `badge ${msg.type}`;
  badge.textContent = msg.type;

  item.append(avatarNode(msg.user), text, badge);
  feed.prepend(item);
  while (feed.children.length > FEED_MAX) feed.lastElementChild.remove();
}

// ---- Beranda: ringkasan kartu kustomisasi ----

function renderSummaries() {
  const chatLabel = CHAT_TEMPLATES.find((t) => t.id === settings.template)?.label ?? '';
  const spotifyLabel = NOWPLAYING_TEMPLATES.find((t) => t.id === settings.spotifyTemplate)?.label ?? '';
  const sourceOn = musicSource === 'youtube'
    ? (youtubeStatus?.connected ? 'YouTube Music terhubung' : 'YouTube Music belum terhubung')
    : (spotifyStatus?.connected ? 'Spotify terhubung' : 'Spotify belum terhubung');
  setSummary('chat', `Template ${chatLabel} · teks ${settings.size}px`);
  setSummary('alert', `Template ${chatLabel} · tampil ${settings.duration} detik`);
  setSummary('musik', `Template ${spotifyLabel} · ${sourceOn}`);
}

function setSummary(key, text) {
  const el = document.querySelector(`[data-summary="${key}"]`);
  if (el) el.textContent = text;
}

// ---- Link dan pratinjau ----

function renderLinks() {
  for (const wrap of document.querySelectorAll('[data-link]')) {
    wrap.replaceChildren();
    const key = wrap.dataset.link;
    const overlay = OVERLAYS[key];
    const url = overlayUrl(key);

    const card = document.createElement('div');
    card.className = 'link';

    const top = document.createElement('div');
    top.className = 'link-top';
    const label = document.createElement('b');
    label.textContent = overlay.label;

    const actions = document.createElement('div');
    actions.className = 'link-actions';
    const copy = document.createElement('button');
    copy.className = 'btn small';
    copy.type = 'button';
    copy.textContent = 'Salin';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast(`Link ${overlay.label} disalin`);
      } catch {
        toast('Gagal menyalin, salin manual dari teks di bawah');
      }
    });
    const open = document.createElement('a');
    open.className = 'btn small';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Buka';
    actions.append(copy, open);
    top.append(label, actions);

    const code = document.createElement('code');
    code.textContent = url;

    card.append(top, code);
    wrap.append(card);
  }
}

// Each page has one preview frame, so only the page that is open loads an overlay.
function setPreview(key) {
  const frame = document.querySelector(`[data-frame="${key}"]`);
  if (frame) frame.src = overlayUrl(key);
}

function refreshPreview() {
  const key = currentOverlay();
  if (key) setPreview(key);
}

function refreshPreviewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 300);
}

// The overlays are sized for 1920×1080, so each preview scales that canvas to fit its card.
function fitStages() {
  for (const stage of document.querySelectorAll('.stage')) {
    stage.style.setProperty('--scale', stage.clientWidth / PREVIEW_WIDTH);
  }
}

// ---- Template chat dan alert ----

// Each card shows a small static sample rendered with the same template CSS as the overlay.
function renderTemplates() {
  for (const wrap of document.querySelectorAll('[data-chat-templates]')) {
    wrap.replaceChildren();

    for (const template of CHAT_TEMPLATES) {
      const selected = template.id === settings.template;

      const card = document.createElement('button');
      card.className = 'tpl';
      card.type = 'button';
      card.dataset.template = template.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(selected));
      card.addEventListener('click', () => selectTemplate(template.id));

      const thumb = document.createElement('div');
      thumb.className = 'tpl-thumb';
      const sample = document.createElement('div');
      sample.className = `chat tpl-${template.id}`;
      applyStyle(sample, chatStyle());
      for (const line of SAMPLE_CHAT) sample.append(chatRow(line));
      thumb.append(sample);

      const name = document.createElement('span');
      name.className = 'tpl-name';
      name.textContent = template.label;
      const hint = document.createElement('span');
      hint.className = 'tpl-hint';
      hint.textContent = template.hint;

      card.append(thumb, name, hint);
      wrap.append(card);
    }
  }
}

function selectTemplate(id) {
  const template = CHAT_TEMPLATES.find((t) => t.id === id);
  settings.template = id;
  saveSettings();
  for (const card of document.querySelectorAll('[data-chat-templates] .tpl')) {
    card.setAttribute('aria-checked', String(card.dataset.template === id));
  }
  renderLinks();
  renderSummaries();
  refreshPreview();
  toast(`Template ${template.label} dipakai`);
}

// ---- Settings ----

function bindSetting(id, key, outputId) {
  const input = $(id);
  const output = $(outputId);
  input.value = settings[key];
  output.textContent = settings[key];

  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    output.textContent = settings[key];
    saveSettings();
    renderLinks();
    renderSummaries();
    refreshPreviewSoon();
  });
}

// ---- Template Spotify ----

// Each card shows a static sample of the now-playing card with the same template CSS as OBS.
function sampleNowPlaying(id) {
  const box = document.createElement('div');
  box.className = `np np-${id} playing`;

  const art = document.createElement('div');
  art.className = 'art';
  art.style.background = 'linear-gradient(135deg, #f97316, #db2777)';

  const info = document.createElement('div');
  info.className = 'info';
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Sedang diputar';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'Lagu contoh';
  const artist = document.createElement('div');
  artist.className = 'artist';
  artist.textContent = 'Nama artis';
  info.append(state, title, artist);

  box.append(art, info);
  return box;
}

function renderSpotifyTemplates() {
  const wrap = $('spotifyTemplates');
  wrap.replaceChildren();

  for (const template of NOWPLAYING_TEMPLATES) {
    const card = document.createElement('button');
    card.className = 'tpl';
    card.type = 'button';
    card.dataset.template = template.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(template.id === settings.spotifyTemplate));
    card.addEventListener('click', () => selectSpotifyTemplate(template.id));

    const thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    thumb.append(sampleNowPlaying(template.id));

    const name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = template.label;
    const hint = document.createElement('span');
    hint.className = 'tpl-hint';
    hint.textContent = template.hint;

    card.append(thumb, name, hint);
    wrap.append(card);
  }
}

function selectSpotifyTemplate(id) {
  const template = NOWPLAYING_TEMPLATES.find((t) => t.id === id);
  settings.spotifyTemplate = id;
  saveSettings();
  for (const card of document.querySelectorAll('#spotifyTemplates .tpl')) {
    card.setAttribute('aria-checked', String(card.dataset.template === id));
  }
  renderLinks();
  renderSummaries();
  refreshPreview();
  toast(`Template Spotify ${template.label} dipakai`);
}

// ---- Animasi dan warna (chat dan alert) ----

function refreshChatStyle() {
  saveSettings();
  renderTemplates();
  renderLinks();
  renderSummaries();
  refreshPreviewSoon();
}

function renderAnims() {
  for (const wrap of document.querySelectorAll('.js-anims')) {
    wrap.replaceChildren();

    for (const anim of CHAT_ANIMATIONS) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.dataset.anim = anim.id;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(chatStyle().anim === anim.id));
      chip.textContent = anim.label;
      chip.addEventListener('click', () => {
        settings.anim = anim.id;
        renderAnims();
        refreshChatStyle();
      });
      wrap.append(chip);
    }
  }
}

function renderColorControls() {
  const style = chatStyle();
  for (const box of document.querySelectorAll('.js-custom-colors')) box.checked = style.custom;
  for (const input of document.querySelectorAll('.js-color')) {
    input.value = style[input.dataset.key];
    input.disabled = !style.custom;
  }
}

function bindAnimDur() {
  for (const input of document.querySelectorAll('.js-animdur')) {
    input.value = chatStyle().dur;
    input.closest('.field').querySelector('.js-animdur-out').textContent = `${input.value} ms`;

    input.addEventListener('input', () => {
      settings.dur = Number(input.value);
      // Keep the chat and alert sliders in step, since they edit the same setting.
      for (const other of document.querySelectorAll('.js-animdur')) {
        other.value = input.value;
        other.closest('.field').querySelector('.js-animdur-out').textContent = `${input.value} ms`;
      }
      refreshChatStyle();
    });
  }
}

// ---- Perspektif overlay ----

function clampTo(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function normalizePersp(saved = {}) {
  const result = {};
  for (const key of PERSP_KEYS) {
    const value = saved?.[key] ?? {};
    result[key] = {
      rx: clampTo(Number(value.rx) || 0, PERSPECTIVE_LIMITS.tilt),
      ry: clampTo(Number(value.ry) || 0, PERSPECTIVE_LIMITS.tilt),
      depth: clampTo(Number(value.depth) || DEFAULT_PERSPECTIVE.depth, PERSPECTIVE_LIMITS.depth),
    };
  }
  return result;
}

function perspOutput(axis, value) {
  return axis === 'depth' ? `${value} px` : `${value}°`;
}

function renderPerspective(key) {
  const persp = settings.persp[key];
  for (const input of document.querySelectorAll(`.js-persp[data-persp="${key}"]`)) {
    const axis = input.dataset.axis;
    input.value = persp[axis];
    input.closest('.field').querySelector('.js-persp-out').textContent = perspOutput(axis, persp[axis]);
  }
}

function refreshPerspective(key) {
  saveSettings();
  renderLinks();
  refreshPreviewSoon();
}

function bindPerspective() {
  for (const key of PERSP_KEYS) renderPerspective(key);

  for (const input of document.querySelectorAll('.js-persp')) {
    input.addEventListener('input', () => {
      const key = input.dataset.persp;
      const axis = input.dataset.axis;
      settings.persp[key][axis] = Number(input.value);
      input.closest('.field').querySelector('.js-persp-out').textContent = perspOutput(axis, Number(input.value));
      refreshPerspective(key);
    });
  }

  for (const button of document.querySelectorAll('.js-persp-reset')) {
    button.addEventListener('click', () => {
      const key = button.dataset.persp;
      settings.persp[key] = { ...DEFAULT_PERSPECTIVE };
      renderPerspective(key);
      refreshPerspective(key);
    });
  }
}

// ---- Events ----

// Shared by the start card and the Koneksi card, so both fill the same username.
async function connectTo(username) {
  $('error').textContent = '';
  $('welcomeError').textContent = '';
  settings.username = username;
  saveSettings();
  $('username').value = username;
  $('welcomeUsername').value = username;
  try {
    renderStatus(await api('/api/connect', { username }));
  } catch (err) {
    renderStatus({ state: 'error', error: err.message });
  }
}

// The username is remembered as it is typed, not only when connecting.
for (const id of ['username', 'welcomeUsername']) {
  $(id).addEventListener('input', () => {
    settings.username = $(id).value.trim();
    saveSettings();
  });
}

$('connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  connectTo($('username').value.trim());
});

$('welcomeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  connectTo($('welcomeUsername').value.trim());
});

$('welcomeSkip').addEventListener('click', () => {
  skipWelcome = true;
  renderView(previousState);
});

$('disconnect').addEventListener('click', async () => {
  try {
    renderStatus(await api('/api/disconnect', {}));
  } catch (err) {
    $('error').textContent = err.message;
  }
});

for (const button of document.querySelectorAll('.js-reload')) {
  button.addEventListener('click', () => refreshPreview());
}

for (const button of document.querySelectorAll('.js-replay')) {
  // Replays the entrance animation on the template cards. Use "Tes" to see it on the overlay.
  button.addEventListener('click', () => renderTemplates());
}

for (const button of document.querySelectorAll('[data-test]')) {
  button.addEventListener('click', () => {
    api(`/api/test/${button.dataset.test}`, {}).catch((err) => {
      $('error').textContent = err.message;
    });
  });
}

for (const box of document.querySelectorAll('.js-custom-colors')) {
  box.addEventListener('change', () => {
    settings.custom = box.checked;
    renderColorControls();
    refreshChatStyle();
  });
}

for (const input of document.querySelectorAll('.js-color')) {
  input.addEventListener('input', () => {
    settings[input.dataset.key] = input.value;
    refreshChatStyle();
  });
}

$('spotifyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const status = await api('/api/spotify/config', { clientId: $('spotifyClientId').value.trim() });
    renderSpotify(status);
    toast('Client ID Spotify disimpan');
  } catch (err) {
    $('spotifyText').textContent = err.message;
  }
});

// The login page redirects back here, so this is a full navigation, not a fetch.
$('spotifyConnect').addEventListener('click', () => {
  location.href = '/api/spotify/login';
});

$('spotifyDisconnect').addEventListener('click', async () => {
  try {
    renderSpotify(await api('/api/spotify/disconnect', {}));
  } catch (err) {
    $('error').textContent = err.message;
  }
});

for (const chip of document.querySelectorAll('#musicSource .chip')) {
  chip.addEventListener('click', () => chooseMusicSource(chip.dataset.source));
}

$('queueClear').addEventListener('click', async () => {
  try {
    renderQueue(await api('/api/queue/clear', {}));
  } catch (err) {
    toast(err.message);
  }
});

$('clearFeed').addEventListener('click', async () => {
  try {
    await api('/api/feed/clear', {});
  } catch (err) {
    toast(err.message);
    return;
  }
  $('feed').replaceChildren();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = 'Aktivitas dibersihkan.';
  $('feed').append(empty);
});

connectHub((msg) => {
  switch (msg.type) {
    case 'status':
      return renderStatus(msg);
    case 'viewers':
      $('viewers').textContent = msg.count.toLocaleString('id-ID');
      return;
    case 'spotify':
      return renderSpotify(msg);
    case 'youtube':
      return renderYouTube(msg);
    case 'queue':
      return renderQueue(msg.items);
    case 'chat':
    case 'gift':
    case 'follow':
    case 'share':
      counts[msg.type] += 1;
      renderCounts();
      addFeed(msg);
      return;
    default:
      return;
  }
});

// ---- Start ----

// Load the saved settings before anything is drawn, so every control shows the saved values.
await loadSettings();
// The overlay key has to be known before the overlay links are drawn.
await loadSession();

bindSetting('size', 'size', 'sizeOut');
bindSetting('max', 'max', 'maxOut');
bindSetting('duration', 'duration', 'durOut');
bindAnimDur();
bindPerspective();

renderAnims();
renderColorControls();

$('username').value = settings.username;
$('welcomeUsername').value = $('username').value;
renderCounts();
renderTemplates();
renderSpotifyTemplates();
renderLinks();
renderSummaries();
for (const stage of document.querySelectorAll('.stage')) new ResizeObserver(fitStages).observe(stage);
fitStages();
window.addEventListener('hashchange', route);
route();

api('/api/status').then(renderStatus).catch(() => {});

// Spotify login returns here with ?spotify=connected or ?spotify=error&message=...
const spotifyResult = new URLSearchParams(location.search);
const spotifyError = spotifyResult.get('spotify') === 'error'
  ? spotifyResult.get('message') || 'Gagal menghubungkan Spotify'
  : '';
if (spotifyResult.get('spotify') === 'connected') toast('Spotify terhubung');
if (spotifyResult.has('spotify')) history.replaceState(null, '', `/${location.hash}`);

api('/api/spotify/status')
  .then((status) => renderSpotify(spotifyError ? { ...status, error: spotifyError } : status))
  .catch(() => {});

api('/api/music/status')
  .then((status) => {
    musicSource = status.source;
    renderMusicSource();
    renderYouTube(status.youtube);
  })
  .catch(() => {});

// Recent activity from earlier visits. The server returns newest first; the list shows the
// newest at the top, so the oldest one is added first.
api('/api/queue').then(renderQueue).catch(() => {});

api('/api/feed?limit=60')
  .then((events) => {
    for (const event of events.reverse()) addFeed(event);
  })
  .catch(() => {});
