import { connectHub } from '/shared/ws.js';
import { chatRow } from '/shared/chatRow.js';
import { CHAT_TEMPLATES, DEFAULT_CHAT_TEMPLATE, isChatTemplate } from '/shared/chatTemplates.js';
import { CHAT_ANIMATIONS, CHAT_GRADIENTS, DEFAULT_CHAT_STYLE, applyStyle, normalizeStyle } from '/shared/chatStyle.js';
import { NOWPLAYING_TEMPLATES, DEFAULT_NOWPLAYING_TEMPLATE, isNowPlayingTemplate } from '/shared/nowplayingTemplates.js';
import { DEFAULT_PERSPECTIVE, PERSPECTIVE_LIMITS } from '/shared/perspective.js';
import { RUNNING_TEXT_TEMPLATES, DEFAULT_RUNNING_TEXT_TEMPLATE, isRunningTextTemplate } from '/shared/runningTextTemplates.js';

const $ = (id) => document.getElementById(id);

const PREVIEW_WIDTH = 1920;
const FEED_MAX = 60;
const SETTINGS_KEY = 'streamover.settings';

const OVERLAYS = {
  chat: { label: 'Chat', file: 'chat.html' },
  alerts: { label: 'Alert', file: 'alerts.html' },
  nowplaying: { label: 'Musik', file: 'nowplaying.html' },
  runningtext: { label: 'Running text', file: 'running-text.html' },
};

// Halaman sesuai menu sidebar: Dashboard, Template Studio, Spotify Studio, Overlay Lab, Settings.
const VIEW_NAMES = ['home', 'chat', 'musik', 'alert', 'running', 'lab', 'settings'];

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
  chatMode: 'history', // 'history': daftar chat, 'latest': satu pesan terbaru saja
  chatHold: 6, // detik pesan terbaru tampil di mode 'latest'
  duration: 4,
  template: DEFAULT_CHAT_TEMPLATE,
  spotifyTemplate: DEFAULT_NOWPLAYING_TEMPLATE,
  runningWords: 'Photography,Videography,Streaming,Tutorial',
  runningTemplate: DEFAULT_RUNNING_TEXT_TEMPLATE,
  runningHold: 1.4, // detik tiap kata tampil
  runningSize: 96,
  runningColor: '#ffffff',
  username: '',
  ...DEFAULT_CHAT_STYLE,
  ...readJson(SETTINGS_KEY),
};

// Perspektif per overlay. Saved values are clamped so a bad saved value can't break the overlay.
const PERSP_KEYS = ['chat', 'alerts', 'nowplaying', 'runningtext'];

// Makes sure every setting has a valid value, whether it came from this browser or the server.
const CHAT_MODES = [
  { id: 'history', label: 'Riwayat chat' },
  { id: 'latest', label: '1 pesan terbaru' },
];

function sanitizeSettings() {
  if (!isChatTemplate(settings.template)) settings.template = DEFAULT_CHAT_TEMPLATE;
  if (!isNowPlayingTemplate(settings.spotifyTemplate)) settings.spotifyTemplate = DEFAULT_NOWPLAYING_TEMPLATE;
  if (!CHAT_MODES.some((m) => m.id === settings.chatMode)) settings.chatMode = 'history';
  settings.chatHold = clampTo(Number(settings.chatHold) || 6, { min: 2, max: 60 });
  if (!isRunningTextTemplate(settings.runningTemplate)) settings.runningTemplate = DEFAULT_RUNNING_TEXT_TEMPLATE;
  settings.runningWords = String(settings.runningWords ?? '').slice(0, 400);
  settings.runningHold = clampTo(Number(settings.runningHold) || 1.4, { min: 0.5, max: 10 });
  settings.runningSize = clampTo(Number(settings.runningSize) || 96, { min: 16, max: 300 });
  if (!/^#[0-9a-f]{6}$/i.test(settings.runningColor)) settings.runningColor = '#ffffff';
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
  params.set('grad', style.gradient);
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
    params.set('mode', settings.chatMode);
    params.set('hold', settings.chatHold * 1000);
    addStyleParams(params);
  }
  if (key === 'alerts') {
    params.set('duration', settings.duration * 1000);
    addStyleParams(params);
  }
  if (key === 'nowplaying') params.set('template', settings.spotifyTemplate);
  if (key === 'runningtext') {
    params.set('template', settings.runningTemplate);
    params.set('words', settings.runningWords);
    params.set('hold', Math.round(settings.runningHold * 1000));
    params.set('size', settings.runningSize);
    params.set('color', settings.runningColor);
  }
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
let publicUrl = '';
async function loadSession() {
  try {
    const session = await api('/api/session');
    overlayKey = session.overlayKey || '';
    $('logout').hidden = !session.authEnabled;
    // Show the redirect exactly as the server sends it, so it can be copied into Spotify's dashboard.
    publicUrl = session.publicUrl || '';
    $('accountName').textContent = session.username || '—';
    $('accountInitial').textContent = (session.username || 'K').charAt(0).toUpperCase();
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
  return VIEW_NAMES.includes(name) ? name : 'home';
}

function route() {
  const view = currentView();
  for (const section of document.querySelectorAll('[data-view]')) {
    section.hidden = section.dataset.view !== view;
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
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

  $('liveBadge').textContent = connected ? '● LIVE' : '○ PAUSED';
  $('headerUser').textContent = status.username ? `@${status.username}` : '—';
  $('settingsTikTok').textContent = status.username && state !== 'idle' ? `${STATE_LABEL[state]} · @${status.username}` : STATE_LABEL[state] || state;
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
  // Dashboard selalu tampil; kartu sambutan muncul di atasnya sampai akun terhubung.
  $('dashboard').hidden = false;
  // Kartu Koneksi hanya tampil setelah kartu sambutan selesai, supaya formnya tidak ganda.
  $('connectCard').hidden = onboarding;
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
  if (connected && status.account) text = `Akun Spotify: ${status.account} · ${text}`;
  $('spotifyText').textContent = text;
  $('spotifyPill').textContent = connected ? 'Spotify terhubung' : 'Spotify belum terhubung';
  $('settingsSpotify').textContent = connected ? 'Terhubung' : 'Belum terhubung';
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
    if (item.note) {
      const note = document.createElement('span');
      note.textContent = item.note;
      text.append(note);
    }

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
  if (msg.type === 'gift') $('lastGift').textContent = `${msg.user.nickname} • ${msg.gift.name} x${msg.gift.count}`;
  feed.prepend(item);
  while (feed.children.length > FEED_MAX) feed.lastElementChild.remove();
}

// ---- Beranda: ringkasan kartu kustomisasi ----

function renderSummaries() {
  renderActiveTemplate();
  const connected = spotifyStatus?.connected;
  $('spotifySummary').textContent = `Sumber: Spotify · ${connected ? 'Spotify terhubung' : 'Spotify belum terhubung'}`;
}

// Nama, deskripsi, warna, dan gambar template yang dipilih diambil dari kartu di Template Studio,
// jadi tampilannya sama dengan kartu yang diklik.
function renderActiveTemplate() {
  const card = document.querySelector(`#chatGrid [data-template="${settings.template}"]`);
  const info = card?.querySelector('.mt-2.px-1');
  const name = info?.querySelector('.font-extrabold')?.textContent
    ?? CHAT_TEMPLATES.find((t) => t.id === settings.template)?.label
    ?? 'Template lama';
  const desc = info?.querySelector('.opacity-50')?.textContent ?? '';
  for (const id of ['activeTemplateName', 'dashTemplateName', 'detailName', 'crumbTemplate', 'spotifyChatName']) {
    $(id).textContent = name;
  }
  for (const id of ['dashTemplateDesc', 'featuredDesc']) $(id).textContent = desc;
  const colors = info?.querySelector('.mt-1.flex.gap-1');
  $('activeTemplateColors').replaceChildren(...(colors ? [...colors.children].map((dot) => dot.cloneNode(true)) : []));
  const art = card?.querySelector('.aspect-\\[16\\/10\\]');
  $('featuredArt').replaceChildren(...(art ? [art.cloneNode(true)] : []));
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

// Setiap pratinjau di halaman yang sedang terbuka dimuat ulang dengan pengaturan terbaru.
function refreshPreview() {
  for (const frame of document.querySelectorAll('[data-view]:not([hidden]) [data-frame]')) {
    frame.src = overlayUrl(frame.dataset.frame);
  }
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

// Kartu template ada di HTML (Template Studio). Di sini hanya dipasang klik dan penanda pilihan.
function bindChatCards() {
  for (const card of document.querySelectorAll('#chatGrid [data-template]')) {
    card.addEventListener('click', () => selectTemplate(card.dataset.template));
  }
}

function markChatCards() {
  for (const card of document.querySelectorAll('#chatGrid [data-template]')) {
    const on = card.dataset.template === settings.template;
    card.setAttribute('aria-checked', String(on));
    const art = card.querySelector('.aspect-\\[16\\/10\\]');
    for (const cls of ['ring-2', 'ring-black', 'scale-[1.02]']) art?.classList.toggle(cls, on);
  }
}

// Contoh chat di Template Studio memakai template dan pengaturan yang sedang dipilih.
function renderSample() {
  const sample = $('chatSample');
  sample.className = `chat tpl-${settings.template}`;
  applyStyle(sample, chatStyle());
  sample.replaceChildren(...SAMPLE_CHAT.map((line) => chatRow(line)));
}

function selectTemplate(id) {
  const template = CHAT_TEMPLATES.find((t) => t.id === id);
  settings.template = id;
  saveSettings();
  markChatCards();
  renderSample();
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

// ---- Running text: template, daftar kata, dan warna. Lama dan ukuran memakai bindSetting. ----

// Kartu template dibuat dari daftar bersama. Contoh teks memakai warna yang sedang dipilih.
function renderRunningTemplates() {
  const grid = $('runningGrid');
  grid.replaceChildren();
  for (const template of RUNNING_TEXT_TEMPLATES) {
    const on = settings.runningTemplate === template.id;
    const card = document.createElement('button');
    card.className = `text-left rounded-[14px] border p-3 bg-white/70 dark:bg-white/5 ${on ? 'border-black ring-1 ring-black dark:border-white dark:ring-white' : 'border-black/10 dark:border-white/10'}`;
    card.type = 'button';
    card.dataset.template = template.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(on));

    const thumb = document.createElement('div');
    thumb.className = 'h-16 rounded-[10px] bg-black flex items-center justify-center overflow-hidden';
    const sample = document.createElement('span');
    sample.className = `rt-word rt-${template.id}`;
    sample.style.fontSize = '26px';
    sample.style.setProperty('--rt-color', settings.runningColor);
    sample.textContent = 'Giveaway';
    thumb.append(sample);

    const name = document.createElement('div');
    name.className = 'mt-2 text-[12px] font-bold';
    name.textContent = template.label;
    const desc = document.createElement('div');
    desc.className = 'text-[10px] opacity-60';
    desc.textContent = template.desc;

    card.append(thumb, name, desc);
    card.addEventListener('click', () => selectRunningTemplate(template.id));
    grid.append(card);
  }
}

function selectRunningTemplate(id) {
  const template = RUNNING_TEXT_TEMPLATES.find((t) => t.id === id);
  settings.runningTemplate = id;
  saveSettings();
  renderRunningTemplates();
  renderLinks();
  refreshPreview();
  toast(`Template ${template.label} dipakai`);
}

function bindRunningText() {
  const words = $('runningWords');
  words.value = settings.runningWords;
  words.addEventListener('input', () => {
    settings.runningWords = words.value;
    saveSettings();
    renderLinks();
    refreshPreviewSoon();
  });

  const color = $('runningColor');
  color.value = settings.runningColor;
  color.addEventListener('input', () => {
    settings.runningColor = color.value;
    saveSettings();
    renderRunningTemplates();
    renderLinks();
    refreshPreviewSoon();
  });

  renderRunningTemplates();
}

// ---- Template Spotify ----

// Kartu template Spotify dibuat dari daftar yang sama dengan overlay, dengan kelas np-* yang sama.
// Semua ukuran .np memakai em, jadi font-size yang kecil membuat kartu contoh ini ikut mengecil.
function renderSpotifyTemplates() {
  const grid = $('spotifyGrid');
  grid.replaceChildren();
  for (const template of NOWPLAYING_TEMPLATES) {
    const on = settings.spotifyTemplate === template.id;
    const card = document.createElement('button');
    card.className = `text-left rounded-[14px] border p-3 bg-white/70 dark:bg-white/5 ${on ? 'border-black ring-1 ring-black dark:border-white dark:ring-white' : 'border-black/10 dark:border-white/10'}`;
    card.type = 'button';
    card.dataset.template = template.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(on));

    const thumb = document.createElement('div');
    thumb.className = 'h-20 rounded-[10px] bg-[#2a2a2e] flex items-center justify-center overflow-hidden px-2';
    const np = document.createElement('div');
    np.className = `np np-${template.id}`;
    np.style.fontSize = '6px';
    const art = document.createElement('div');
    art.className = 'art';
    const info = document.createElement('div');
    info.className = 'info';
    const state = document.createElement('div');
    state.className = 'state';
    state.textContent = '♪ Sedang diputar';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Lagu Contoh';
    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = 'Nama Artis';
    info.append(state, title, artist);
    np.append(art, info);
    thumb.append(np);

    const name = document.createElement('div');
    name.className = 'mt-2 text-[12px] font-bold';
    name.textContent = template.label;
    const hint = document.createElement('div');
    hint.className = 'text-[10px] opacity-60';
    hint.textContent = template.hint;

    card.append(thumb, name, hint);
    card.addEventListener('click', () => selectSpotifyTemplate(template.id));
    grid.append(card);
  }
}

function selectSpotifyTemplate(id) {
  const template = NOWPLAYING_TEMPLATES.find((t) => t.id === id);
  settings.spotifyTemplate = id;
  saveSettings();
  renderSpotifyTemplates();
  renderLinks();
  refreshPreview();
  toast(`Template Spotify ${template.label} dipakai`);
}

// ---- Animasi dan warna (chat dan alert) ----

function refreshChatStyle() {
  saveSettings();
  renderSample();
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

// Mode chat: riwayat atau satu pesan terbaru. Durasi tampil hanya dipakai di mode satu pesan.
function renderChatMode() {
  for (const wrap of document.querySelectorAll('.js-chatmode')) {
    wrap.replaceChildren();
    for (const mode of CHAT_MODES) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.dataset.mode = mode.id;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(settings.chatMode === mode.id));
      chip.textContent = mode.label;
      chip.addEventListener('click', () => {
        settings.chatMode = mode.id;
        renderChatMode();
        saveSettings();
        renderLinks();
        renderSummaries();
        refreshPreviewSoon();
      });
      wrap.append(chip);
    }
  }
  for (const field of document.querySelectorAll('.js-chathold-field')) {
    field.classList.toggle('dimmed', settings.chatMode !== 'latest');
  }
}

// Kartu gradasi: contoh chat di atas latar gradasi, supaya hasilnya terlihat sebelum dipilih.
function renderGradients() {
  for (const wrap of document.querySelectorAll('.js-gradients')) {
    wrap.replaceChildren();
    const current = chatStyle().gradient;

    for (const gradient of CHAT_GRADIENTS) {
      const card = document.createElement('button');
      card.className = 'tpl grad-card';
      card.type = 'button';
      card.dataset.gradient = gradient.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(current === gradient.id));
      card.addEventListener('click', () => {
        settings.gradient = gradient.id;
        renderGradients();
        renderColorControls();
        refreshChatStyle();
      });

      const thumb = document.createElement('div');
      thumb.className = 'tpl-thumb grad-thumb';
      if (gradient.from) thumb.style.background = `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`;
      const sample = document.createElement('div');
      sample.className = `chat tpl-${settings.template}`;
      // The card shows the gradient behind the sample, so the sample itself uses no gradient.
      applyStyle(sample, { ...chatStyle(), gradient: 'none' });
      sample.append(chatRow(SAMPLE_CHAT[1]));
      thumb.append(sample);

      const name = document.createElement('span');
      name.className = 'tpl-name';
      name.textContent = gradient.label;
      card.append(thumb, name);
      wrap.append(card);
    }
  }
}

function renderColorControls() {
  const style = chatStyle();
  for (const box of document.querySelectorAll('.js-custom-colors')) box.checked = style.custom;
  for (const input of document.querySelectorAll('.js-color')) {
    input.value = style[input.dataset.key];
    // A gradient replaces the background color, so the background picker has no effect while one is chosen.
    input.disabled = !style.custom || (input.dataset.key === 'bg' && style.gradient !== 'none');
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
  // Spotify sends the browser back to PUBLIC_URL. On any other address the login cookie is
  // missing there and the connection fails, so stop before leaving. Only the browser knows the
  // real address; behind a proxy the server sees its own.
  if (publicUrl && publicUrl !== location.origin) {
    $('spotifyText').textContent = `Callback Spotify mengarah ke ${publicUrl}, tapi panel dibuka di ${location.origin}. Atur PUBLIC_URL di .env server sesuai alamat panel, lalu restart server.`;
    return;
  }
  location.href = '/api/spotify/login';
});

$('spotifyDisconnect').addEventListener('click', async () => {
  try {
    renderSpotify(await api('/api/spotify/disconnect', {}));
  } catch (err) {
    $('error').textContent = err.message;
  }
});


$('autoQueue').addEventListener('change', async () => {
  try {
    const data = await api('/api/music/autoqueue', { enabled: $('autoQueue').checked });
    $('autoQueue').checked = data.autoQueue;
    toast(data.autoQueue ? 'Request masuk antrean Spotify otomatis' : 'Request hanya masuk daftar');
  } catch (err) {
    $('autoQueue').checked = !$('autoQueue').checked;
    toast(err.message);
  }
});

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

// ---- Tema siang dan malam ----

// Pilihan disimpan di browser ini. Kalau belum pernah dipilih, panel mengikuti tema sistem.
// Kelas "dark" di <html> dipakai template untuk varian dark:, dan data-theme untuk token warna.
const THEME_KEY = 'streamover.theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  const saved = readLocal(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return systemDark.matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = currentTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  const toggle = $('themeToggle');
  toggle.textContent = theme === 'dark' ? '☀ Siang' : '☾ Malam';
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

$('themeToggle').addEventListener('click', () => {
  writeLocal(THEME_KEY, currentTheme() === 'dark' ? 'light' : 'dark');
  applyTheme();
});

systemDark.addEventListener('change', () => {
  if (readLocal(THEME_KEY) !== 'light' && readLocal(THEME_KEY) !== 'dark') applyTheme();
});

applyTheme();

// ---- Start ----

// Load the saved settings before anything is drawn, so every control shows the saved values.
await loadSettings();
// The overlay key has to be known before the overlay links are drawn.
await loadSession();

bindSetting('size', 'size', 'sizeOut');
bindSetting('max', 'max', 'maxOut');
bindSetting('chatHold', 'chatHold', 'chatHoldOut');
renderChatMode();
bindSetting('duration', 'duration', 'durOut');
bindSetting('runningHold', 'runningHold', 'runningHoldOut');
bindSetting('runningSize', 'runningSize', 'runningSizeOut');
bindRunningText();
bindAnimDur();
bindPerspective();

renderAnims();
renderGradients();
renderColorControls();

$('username').value = settings.username;
$('welcomeUsername').value = $('username').value;
renderCounts();
bindChatCards();
markChatCards();
renderSpotifyTemplates();
renderSample();
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
    $('autoQueue').checked = status.autoQueue === true;
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
