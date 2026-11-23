import { connectHub } from '/shared/ws.js';
import { startYouTubePlayer } from '/shared/ytPlayer.js';
import { chatRow } from '/shared/chatRow.js';
import { CHAT_TEMPLATES, DEFAULT_CHAT_TEMPLATE, isChatTemplate } from '/shared/chatTemplates.js';
import { CHAT_ANIMATIONS, CHAT_GRADIENTS, DEFAULT_CHAT_STYLE, applyStyle, normalizeStyle } from '/shared/chatStyle.js';
import { NOWPLAYING_TEMPLATES, DEFAULT_NOWPLAYING_TEMPLATE, isNowPlayingTemplate } from '/shared/nowplayingTemplates.js';
import { DEFAULT_PERSPECTIVE, PERSPECTIVE_LIMITS } from '/shared/perspective.js';
import { RUNNING_TEXT_TEMPLATES, DEFAULT_RUNNING_TEXT_TEMPLATE, isRunningTextTemplate, RUNNING_TEXT_FONTS, DEFAULT_RUNNING_TEXT_FONT, isRunningTextFont, runningTextFontStyle } from '/shared/runningTextTemplates.js';

const $ = (id) => document.getElementById(id);

const PREVIEW_WIDTH = 1920;
const FEED_MAX = 60;
const SETTINGS_KEY = 'streamover.settings';
// Warna bawaan template custom, dipakai kalau nilai yang tersimpan tidak valid.
const DEFAULT_SETTINGS_COLORS = { npBgColor: '#121212', npTextColor: '#ffffff', npAccentColor: '#1ed760' };

// Spotify dan YT Music punya overlay sendiri. Keduanya memakai nowplaying.html, dan ?source= memilih sumbernya.
const OVERLAYS = {
  chat: { label: 'Chat', file: 'chat.html' },
  alerts: { label: 'Alert', file: 'alerts.html' },
  nowplaying: { label: 'Spotify', file: 'nowplaying.html', source: 'spotify' },
  youtube: { label: 'YT Music', file: 'nowplaying.html', source: 'youtube' },
  lyrics: { label: 'Lirik Spotify', file: 'lyrics.html', source: 'spotify' },
  lyricsyt: { label: 'Lirik YT Music', file: 'lyrics.html', source: 'youtube' },
  lyricsam: { label: 'Lirik Apple Music', file: 'lyrics.html', source: 'applemusic' },
  tts: { label: 'Pembaca komentar', file: 'tts.html' },
  soundboard: { label: 'Soundboard', file: 'soundboard.html' },
  runningtext: { label: 'Running text', file: 'running-text.html' },
};

// Halaman sesuai menu sidebar: Dashboard, Template Studio, Spotify Studio, YT Music Studio, Alert, Running text, Overlay Lab, Settings.
const VIEW_NAMES = ['home', 'musik', 'ytmusic', 'running', 'soundboard', 'settings'];
// Template chat, alert, dan Overlay Lab ada di satu halaman dengan tab. Link lama (#/chat, #/alert, #/lab) tetap membuka tab yang sama.
const STUDIO_TABS = { studio: 'chat', chat: 'chat', alert: 'alert', lab: 'lab' };

// Batas overlay running text. Tiap overlay punya link OBS sendiri.
const RUNNING_MAX = 6;
// Kunci running text versi lama (satu overlay). Dipindahkan ke runningTexts lalu dihapus.
const LEGACY_RUNNING_KEYS = ['runningWords', 'runningHold', 'runningSize', 'runningColor', 'runningTemplate'];

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
  chatNames: 'side', // posisi nama penonton: 'side' di samping komentar, 'top' di atas komentar
  duration: 4,
  template: DEFAULT_CHAT_TEMPLATE,
  spotifyTemplate: DEFAULT_NOWPLAYING_TEMPLATE,
  youtubeTemplate: DEFAULT_NOWPLAYING_TEMPLATE,
  npFit: 'content', // overlay lagu: 'content' (sesuai lagu) or 'fixed' (ukuran tetap)
  npAlign: 'left', // 'left', 'center', or 'right'
  npWidth: 560, // width in px for fixed size
  lyricsFont: 'default', // jenis huruf lirik: id dari RUNNING_TEXT_FONTS, 'default' memakai huruf sistem
  lyricsColor: '#ffffff', // warna teks lirik
  npBgColor: '#121212', // template custom: warna background
  npTextColor: '#ffffff', // template custom: warna teks
  npAccentColor: '#1ed760', // template custom: warna status (Sedang diputar / Dijeda)
  npFont: 'default', // template custom: jenis huruf, id dari RUNNING_TEXT_FONTS
  npBgVer: 0, // template custom: versi background, berubah setiap upload agar overlay memuat ulang
  ttsChat: false, // baca komentar chat
  ttsAlert: false, // baca alert gift, follow, dan share
  ttsPrefix: false, // kalau aktif, hanya komentar yang diawali !tts yang dibaca
  ttsRate: 1, // kecepatan bicara, 0.5 sampai 2
  ttsVoice: '', // nama suara. Kosong berarti otomatis, suara bahasa Indonesia kalau ada
  username: '',
  ...DEFAULT_CHAT_STYLE,
  ...readJson(SETTINGS_KEY),
};

// Perspektif per overlay. Saved values are clamped so a bad saved value can't break the overlay.
// Running text punya perspektif sendiri di tiap overlay, jadi tidak ada di sini.
const PERSP_KEYS = ['chat', 'alerts', 'nowplaying', 'youtube', 'lyrics'];
const PERSP_TARGETS = [...PERSP_KEYS, 'runningtext'];

// Makes sure every setting has a valid value, whether it came from this browser or the server.
const CHAT_MODES = [
  { id: 'history', label: 'Riwayat chat' },
  { id: 'latest', label: '1 pesan terbaru' },
];

function sanitizeSettings() {
  if (!isChatTemplate(settings.template)) settings.template = DEFAULT_CHAT_TEMPLATE;
  if (!isNowPlayingTemplate(settings.spotifyTemplate)) settings.spotifyTemplate = DEFAULT_NOWPLAYING_TEMPLATE;
  if (!isNowPlayingTemplate(settings.youtubeTemplate)) settings.youtubeTemplate = DEFAULT_NOWPLAYING_TEMPLATE;
  if (!['content', 'fixed'].includes(settings.npFit)) settings.npFit = 'content';
  if (!['left', 'center', 'right'].includes(settings.npAlign)) settings.npAlign = 'left';
  if (!isRunningTextFont(settings.lyricsFont)) settings.lyricsFont = 'default';
  for (const key of ['npBgColor', 'npTextColor', 'npAccentColor']) {
    if (!/^#[0-9a-f]{6}$/i.test(settings[key])) settings[key] = DEFAULT_SETTINGS_COLORS[key];
  }
  if (!isRunningTextFont(settings.npFont)) settings.npFont = 'default';
  settings.npBgVer = Number(settings.npBgVer) || 0;
  if (!/^#[0-9a-f]{6}$/i.test(settings.lyricsColor)) settings.lyricsColor = '#ffffff';
  settings.ttsChat = Boolean(settings.ttsChat);
  settings.ttsAlert = Boolean(settings.ttsAlert);
  settings.ttsPrefix = Boolean(settings.ttsPrefix);
  settings.ttsRate = clampTo(Number(settings.ttsRate) || 1, { min: 0.5, max: 2 });
  settings.ttsVoice = typeof settings.ttsVoice === 'string' ? settings.ttsVoice.slice(0, 100) : '';
  settings.npWidth = clampTo(Number(settings.npWidth) || 560, { min: 300, max: 1000 });
  if (!CHAT_MODES.some((m) => m.id === settings.chatMode)) settings.chatMode = 'history';
  settings.chatHold = clampTo(Number(settings.chatHold) || 6, { min: 2, max: 120 });
  if (!['side', 'top'].includes(settings.chatNames)) settings.chatNames = 'side';
  sanitizeRunningTexts();
  Object.assign(settings, normalizeStyle(settings));
  settings.persp = normalizePersp(settings.persp);
}
sanitizeSettings();

// Setiap overlay running text: nama, template, font, kata, lama, ukuran, warna, dan perspektif.
function newRunningText(name) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name,
    template: DEFAULT_RUNNING_TEXT_TEMPLATE,
    font: DEFAULT_RUNNING_TEXT_FONT,
    words: 'Photography,Videography,Streaming,Tutorial',
    hold: 1.4, // detik tiap kata tampil
    size: 96,
    color: '#ffffff',
    persp: { ...DEFAULT_PERSPECTIVE },
  };
}

// Memastikan daftar overlay ada dan valid. Versi lama hanya punya satu running text di kunci terpisah,
// jadi itu dipindah menjadi overlay pertama.
function sanitizeRunningTexts() {
  if (!Array.isArray(settings.runningTexts) || !settings.runningTexts.length) {
    const first = newRunningText('Running text 1');
    const legacy = {
      words: settings.runningWords,
      template: settings.runningTemplate,
      hold: settings.runningHold,
      size: settings.runningSize,
      color: settings.runningColor,
      persp: settings.persp?.runningtext,
    };
    for (const [key, value] of Object.entries(legacy)) {
      if (value !== undefined) first[key] = value;
    }
    settings.runningTexts = [first];
  }
  for (const key of LEGACY_RUNNING_KEYS) delete settings[key];
  settings.runningTexts = settings.runningTexts.slice(0, RUNNING_MAX).map(cleanRunningText);
  if (!settings.runningTexts.some((t) => t.id === settings.runningSelected)) {
    settings.runningSelected = settings.runningTexts[0].id;
  }
}

function cleanRunningText(item, index) {
  const id = typeof item.id === 'string' && item.id ? item.id.slice(0, 40) : newRunningText('').id;
  return {
    id,
    name: String(item.name ?? '').slice(0, 30) || `Running text ${index + 1}`,
    template: isRunningTextTemplate(item.template) ? item.template : DEFAULT_RUNNING_TEXT_TEMPLATE,
    font: isRunningTextFont(item.font) ? item.font : DEFAULT_RUNNING_TEXT_FONT,
    words: String(item.words ?? '').slice(0, 400),
    hold: clampTo(Number(item.hold) || 1.4, { min: 0.5, max: 10 }),
    size: clampTo(Number(item.size) || 96, { min: 16, max: 300 }),
    color: /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#ffffff',
    persp: normalizeAxes(item.persp),
  };
}

function selectedRunningText() {
  return settings.runningTexts.find((t) => t.id === settings.runningSelected) ?? settings.runningTexts[0];
}

// Perspektif untuk satu overlay. Running text mengambil dari overlay yang sedang dipilih.
function perspOf(key) {
  return key === 'runningtext' ? selectedRunningText().persp : settings.persp[key];
}

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
let dockPlayer = null; // the YT Music player in the bottom dock
let ytMode = 'player'; // 'player' (YouTube player in the dock) or 'extension' (YT Music tab)
let playOrder = 'playlist'; // 'playlist' (in order) or 'shuffle'
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
      // Daftar default dari startup tidak boleh menutupi running text versi lama di server.
      if (!Array.isArray(saved.runningTexts)) delete settings.runningTexts;
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
// Item running text dikirim sendiri, jadi tiap overlay punya link sendiri. Untuk overlay lain item diabaikan.
function overlayUrl(key, item = selectedRunningText()) {
  const params = new URLSearchParams();
  if (key === 'chat') {
    params.set('size', settings.size);
    params.set('max', settings.max);
    params.set('mode', settings.chatMode);
    params.set('hold', settings.chatHold * 1000);
    params.set('names', settings.chatNames);
    addStyleParams(params);
  }
  if (key === 'alerts') {
    params.set('duration', settings.duration * 1000);
    addStyleParams(params);
  }
  if (key === 'nowplaying') params.set('template', settings.spotifyTemplate);
  if (key === 'youtube') params.set('template', settings.youtubeTemplate);
  // Template custom: warna, font, dan background dari pengaturan Custom di Spotify Studio.
  if ((key === 'nowplaying' && settings.spotifyTemplate === 'custom') || (key === 'youtube' && settings.youtubeTemplate === 'custom')) {
    params.set('bgc', settings.npBgColor.slice(1));
    params.set('tc', settings.npTextColor.slice(1));
    params.set('ac', settings.npAccentColor.slice(1));
    params.set('font', settings.npFont);
    if (settings.npBgVer) {
      params.set('bgimg', '1');
      params.set('bgv', settings.npBgVer);
    }
  }
  if (key === 'nowplaying' || key === 'youtube') {
    params.set('fit', settings.npFit);
    params.set('align', settings.npAlign);
    params.set('width', settings.npWidth);
  }
  if (OVERLAYS[key].source) params.set('source', OVERLAYS[key].source);
  if (key === 'runningtext') {
    params.set('template', item.template);
    params.set('font', item.font);
    params.set('words', item.words);
    params.set('hold', Math.round(item.hold * 1000));
    params.set('size', item.size);
    params.set('color', item.color);
  }
  // Lirik YT Music memakai font, warna, dan perspektif yang sama dengan lirik Spotify.
  const styleKey = ['lyricsyt', 'lyricsam'].includes(key) ? 'lyrics' : key;
  if (styleKey === 'lyrics') {
    params.set('font', settings.lyricsFont);
    params.set('color', settings.lyricsColor.slice(1));
  }
  if (key === 'tts') {
    params.set('chat', settings.ttsChat ? '1' : '0');
    params.set('alert', settings.ttsAlert ? '1' : '0');
    params.set('prefix', settings.ttsPrefix ? '1' : '0');
    params.set('rate', settings.ttsRate);
    if (settings.ttsVoice) params.set('voice', settings.ttsVoice);
  }
  // Pembaca komentar dan soundboard tidak tampil di layar, jadi tidak ada perspektif.
  if (!['tts', 'soundboard'].includes(key)) {
    const persp = key === 'runningtext' ? item.persp : settings.persp[styleKey];
    params.set('rx', persp.rx);
    params.set('ry', persp.ry);
    params.set('pd', persp.depth);
  }
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
    $('ytPlayerUrl').textContent = `${location.origin}/overlay/player.html${overlayKey ? `?key=${overlayKey}` : ''}`;
    // The player runs in the dock below the panel, so its sound comes from this browser.
    if (overlayKey) {
      dockPlayer = startYouTubePlayer({ element: $('ytDockPlayer'), key: overlayKey, onStatus: renderDock });
      setInterval(updateDockProgress, 500);
    }
    renderYtMode();
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

function currentRouteName() {
  return location.hash.replace(/^#\/?/, '');
}

function currentView() {
  const name = currentRouteName();
  if (Object.hasOwn(STUDIO_TABS, name)) return 'studio';
  return VIEW_NAMES.includes(name) ? name : 'home';
}

function currentStudioTab() {
  return STUDIO_TABS[currentRouteName()] || 'chat';
}

function route() {
  const view = currentView();
  for (const section of document.querySelectorAll('[data-view]')) {
    section.hidden = section.dataset.view !== view;
  }
  // Di halaman gabungan, hanya satu tab yang tampil.
  const tab = currentStudioTab();
  for (const sub of document.querySelectorAll('[data-subview]')) {
    sub.hidden = sub.dataset.subview !== tab;
  }
  for (const link of document.querySelectorAll('[data-studio-tab]')) {
    link.setAttribute('aria-selected', String(link.dataset.studioTab === tab));
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  refreshPreview();
  if (view === 'soundboard') loadSoundboard().catch((err) => toast(err.message));
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

// ---- YT Music (lewat extension Chrome) ----

// Shows the track and the player's state in the dock. Called by the player module on every change.
function renderDock({ state, lastError, needsClick, current }) {
  $('dockNow').textContent = current ? `${current.title}${current.artist ? ` — ${current.artist}` : ''}` : 'Belum ada lagu';
  $('dockStatus').textContent = [lastError, `Status: ${state}`].filter(Boolean).join(' — ');
  $('dockStart').hidden = !needsClick;
  // The thumbnail of the video that is playing, set only when it changes.
  const thumb = $('dockThumb');
  const src = current?.videoId ? `https://i.ytimg.com/vi/${current.videoId}/mqdefault.jpg` : '';
  if (thumb.dataset.src !== src) {
    thumb.dataset.src = src;
    thumb.src = src;
  }
  thumb.hidden = !src;
}

// Progress bar and time in the dock. While the bar is being dragged it isn't moved by the player.
let dockSeeking = false;
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function updateDockProgress() {
  if (!dockPlayer) return;
  const { current, duration } = dockPlayer.progress();
  $('dockTime').textContent = `${clock(current)} / ${clock(duration)}`;
  if (!dockSeeking && duration) $('dockSeek').value = String(Math.round((current / duration) * 1000));
}

// Shows the chosen way of playing: the chooser, its hint, the setup steps, and the dock (player mode only).
function renderYtMode() {
  const extension = ytMode === 'extension';
  for (const [id, active] of [['ytModePlayer', !extension], ['ytModeExtension', extension]]) {
    $(id).setAttribute('aria-checked', String(active));
    $(id).setAttribute('aria-selected', String(active));
  }
  $('ytModeHint').textContent = extension
    ? 'Lagu dicari dan diputar di tab music.youtube.com yang terbuka di Chrome. Cukup isi judul dan artis, link tidak perlu.'
    : 'Lagu diputar di player YouTube, di dock bawah panel. Audionya keluar dari browser ini. Tiap lagu di playlist perlu link YouTube.';
  $('ytExtensionSteps').hidden = !extension;
  for (const [id, order] of [['ytOrderPlaylist', 'playlist'], ['ytOrderShuffle', 'shuffle']]) {
    const on = playOrder === order;
    $(id).setAttribute('aria-checked', String(on));
    $(id).setAttribute('aria-selected', String(on));
  }
  $('ytOrderHint').textContent = playOrder === 'shuffle'
    ? 'Lagu diputar acak. Setiap lagu diputar sekali dulu sebelum ada yang diulang. Kalau playlist kosong, acak mengambil dari semua lagu.'
    : 'Lagu diputar dari atas playlist.';
  $('ytPlayerRow').hidden = extension;
  $('dock').hidden = extension || !overlayKey;
  document.body.classList.toggle('has-dock', !$('dock').hidden);
  renderYouTube(youtubeStatus ?? { connected: false, nowPlaying: null });
}

function renderYouTube(status) {
  youtubeStatus = status;
  const track = status.nowPlaying;
  const name = ytMode === 'extension' ? 'Tab YT Music' : 'Player';
  let text = `${name} belum terhubung`;
  if (track) text = `${track.playing ? 'Diputar' : 'Dijeda'}: ${track.title}${track.artist ? ` — ${track.artist}` : ''}`;
  else if (status.connected) text = `${name} aktif, belum ada lagu`;
  $('youtubeText').textContent = text;
  $('settingsYouTube').textContent = status.connected ? 'Terhubung' : 'Belum terhubung';
  renderSummaries();
}

// ---- YT Music: playlist, antrian, dan blacklist ----

// Isi library dari server. Setiap perubahan dijawab dengan library lengkap, jadi tampilan sama dengan yang tersimpan.
let library = { playlists: [], blacklist: { songs: [], users: [] } };
let selectedPlaylistId = null;

function selectedPlaylist() {
  return library.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? null;
}

function setLibrary(data) {
  library = data;
  if (!selectedPlaylist()) selectedPlaylistId = library.playlists[0]?.id ?? null;
  renderLibrary();
}

// Mengirim perubahan ke server. Error ditampilkan lewat toast, dan hasilnya true kalau berhasil.
async function changeLibrary(path, body) {
  try {
    setLibrary(await api(path, body));
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function songLabel(song) {
  return song.artist ? `${song.title} — ${song.artist}` : song.title;
}

// Opens the song in YT Music in a new tab: the exact video when the song has a link, otherwise a search.
function songOpenUrl(song) {
  if (song.videoId) return `https://music.youtube.com/watch?v=${song.videoId}`;
  const query = [song.title, song.artist].filter(Boolean).join(' ');
  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
}

// ---- YouTube API di Settings ----

function renderYouTubeKey(info) {
  const from = info.source === 'panel' ? 'dari panel' : 'dari .env';
  $('ytKeyStatus').textContent = info.connected
    ? `Terhubung (${from}): ${info.masked}`
    : 'Belum terhubung. Pencarian request dan import playlist tidak aktif.';
  // Only a key connected here can be removed here; a key in .env belongs to the server.
  $('ytKeyDisconnect').disabled = info.source !== 'panel';
}

api('/api/youtube/key').then(renderYouTubeKey).catch(() => {});

$('ytKeyConnect').addEventListener('click', async () => {
  const key = $('ytKeyInput').value.trim();
  if (!key) {
    toast('Tempel key dulu');
    return;
  }
  $('ytKeyConnect').disabled = true;
  try {
    renderYouTubeKey(await api('/api/youtube/key', { key }));
    $('ytKeyInput').value = '';
    toast('YouTube API terhubung');
  } catch (err) {
    toast(err.message);
  } finally {
    $('ytKeyConnect').disabled = false;
  }
});

$('ytKeyDisconnect').addEventListener('click', async () => {
  if (!window.confirm('Putuskan YouTube API? Pencarian request dan import playlist berhenti.')) return;
  try {
    renderYouTubeKey(await api('/api/youtube/key/delete', {}));
    toast('YouTube API diputuskan');
  } catch (err) {
    toast(err.message);
  }
});

// Imports a YouTube playlist link into the open playlist. The server skips songs that can't be played outside YouTube.
async function importPlaylist() {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  const input = $('plImportLink');
  const button = $('plImport');
  button.disabled = true;
  button.textContent = 'Mengimpor…';
  try {
    const data = await api(`/api/library/playlists/${playlist.id}/import`, { link: input.value.trim() });
    setLibrary(data);
    input.value = '';
    const { added, replaced, skipped } = data.summary;
    const parts = [`${added} lagu ditambahkan`];
    if (replaced) parts.push(`${replaced} diganti versi lain`);
    if (skipped) parts.push(`${skipped} dilewati`);
    toast(parts.join(', '));
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Import playlist';
  }
}

// Plays a playlist song on the player page. Errors (such as the player page not being open) show in a toast.
async function playSong(playlistId, songId) {
  try {
    await api('/api/player/play', { playlistId, songId });
    toast('Lagu diputar di player');
  } catch (err) {
    toast(err.message);
  }
}

async function playerControl(action) {
  try {
    await api('/api/player/control', { action });
  } catch (err) {
    toast(err.message);
  }
}

async function playNextFromQueue() {
  try {
    renderQueue(await api('/api/queue/play-next', {}));
    toast('Lagu berikutnya dikirim ke YT Music');
  } catch (err) {
    toast(err.message);
  }
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

// Satu baris lagu. openHref, onPlay, onQueue, dan onRemove boleh kosong, supaya tombolnya tidak muncul.
function libRow(label, { openHref, onPlay, onQueue, onRemove }) {
  const li = document.createElement('li');
  li.className = 'lib-item';
  const text = document.createElement('span');
  text.className = 'lib-text';
  text.textContent = label;
  const actions = document.createElement('div');
  actions.className = 'lib-actions';
  if (openHref) {
    const open = document.createElement('a');
    open.className = 'btn ghost small';
    open.href = openHref;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Buka di YT Music';
    actions.append(open);
  }
  if (onPlay) {
    const play = document.createElement('button');
    play.className = 'btn small';
    play.type = 'button';
    play.textContent = 'Putar';
    play.addEventListener('click', onPlay);
    actions.append(play);
  }
  if (onQueue) {
    const queue = document.createElement('button');
    queue.className = 'btn small';
    queue.type = 'button';
    queue.textContent = 'Antrikan';
    queue.addEventListener('click', onQueue);
    actions.append(queue);
  }
  if (onRemove) {
    const remove = document.createElement('button');
    remove.className = 'btn ghost danger small';
    remove.type = 'button';
    remove.textContent = 'Hapus';
    remove.addEventListener('click', onRemove);
    actions.append(remove);
  }
  li.append(text, actions);
  return li;
}

function renderLibrary() {
  renderPlaylistList();
  renderPlaylistDetail();
  renderSearch();
  renderBlacklist();
}

function renderPlaylistList() {
  const list = $('plList');
  list.replaceChildren();
  if (!library.playlists.length) {
    list.append(emptyItem('Belum ada playlist.'));
    return;
  }
  for (const playlist of library.playlists) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lib-item';
    button.setAttribute('aria-current', String(playlist.id === selectedPlaylistId));
    const name = document.createElement('span');
    name.className = 'lib-text';
    name.textContent = playlist.name;
    const count = document.createElement('small');
    count.textContent = `${playlist.songs.length} lagu`;
    button.append(name, count);
    button.addEventListener('click', () => {
      selectedPlaylistId = playlist.id;
      renderLibrary();
    });
    li.append(button);
    list.append(li);
  }
}

function renderPlaylistDetail() {
  const playlist = selectedPlaylist();
  $('plEmpty').hidden = Boolean(playlist);
  $('plDetail').hidden = !playlist;
  if (!playlist) return;
  $('plName').textContent = playlist.name;
  $('plCount').textContent = `${playlist.songs.length} lagu`;
  $('plQueueAll').disabled = playlist.songs.length === 0;
  const list = $('plSongs');
  list.replaceChildren();
  if (!playlist.songs.length) {
    list.append(emptyItem('Belum ada lagu di playlist ini.'));
    return;
  }
  playlist.songs.forEach((song, index) => {
    list.append(libRow(`${index + 1}. ${songLabel(song)}`, {
      openHref: songOpenUrl(song),
      onPlay: () => playSong(playlist.id, song.id),
      onQueue: () => queueSong(playlist.id, song.id),
      onRemove: () => changeLibrary(`/api/library/playlists/${playlist.id}/songs/${song.id}/delete`, {}),
    }));
  });
}

// Pencarian di semua playlist. Hasilnya muncul di atas daftar lagu.
function renderSearch() {
  const query = $('plSearch').value.trim().toLowerCase();
  const list = $('plResults');
  list.hidden = !query;
  list.replaceChildren();
  if (!query) return;
  const matches = library.playlists.flatMap((playlist) => playlist.songs
    .filter((song) => songLabel(song).toLowerCase().includes(query))
    .map((song) => ({ playlist, song })));
  if (!matches.length) {
    list.append(emptyItem('Tidak ada lagu yang cocok.'));
    return;
  }
  for (const { playlist, song } of matches) {
    list.append(libRow(`${songLabel(song)} · ${playlist.name}`, {
      openHref: songOpenUrl(song),
      onPlay: () => playSong(playlist.id, song.id),
      onQueue: () => queueSong(playlist.id, song.id),
    }));
  }
}

function renderBlacklist() {
  renderBlockList($('blSongs'), library.blacklist.songs, 'song');
  renderBlockList($('blUsers'), library.blacklist.users, 'user');
}

function renderBlockList(list, entries, type) {
  list.replaceChildren();
  if (!entries.length) {
    list.append(emptyItem('Kosong.'));
    return;
  }
  for (const value of entries) {
    list.append(libRow(value, {
      onRemove: () => changeLibrary('/api/library/blacklist/delete', { type, value }),
    }));
  }
}

async function createPlaylist() {
  const input = $('plNewName');
  if (!await changeLibrary('/api/library/playlists', { name: input.value.trim() })) return;
  input.value = '';
  selectedPlaylistId = library.playlists.at(-1).id;
  renderLibrary();
}

async function renamePlaylist() {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  const name = window.prompt('Nama baru untuk playlist', playlist.name);
  if (name === null) return;
  await changeLibrary(`/api/library/playlists/${playlist.id}/rename`, { name: name.trim() });
}

async function deletePlaylist() {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  if (!window.confirm(`Hapus playlist "${playlist.name}" beserta isinya?`)) return;
  await changeLibrary(`/api/library/playlists/${playlist.id}/delete`, {});
}

async function addSong() {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  const title = $('plTitle').value.trim();
  const artist = $('plArtist').value.trim();
  const link = $('plLink').value.trim();
  let data;
  try {
    data = await api(`/api/library/playlists/${playlist.id}/songs`, { title, artist, link });
  } catch (err) {
    toast(err.message);
    return;
  }
  setLibrary(data);
  // The pasted link was blocked by its owner, so the server saved another upload of the song.
  if (data.replaced) toast(`Link asli diblokir pemiliknya, diganti: ${data.replaced.title}`);
  $('plTitle').value = '';
  $('plArtist').value = '';
  $('plLink').value = '';
  $('plTitle').focus();
}

// Satu lagu dari playlist masuk ke antrean, sama seperti request dari chat.
async function queueSong(playlistId, songId) {
  try {
    renderQueue(await api(`/api/library/playlists/${playlistId}/songs/${songId}/queue`, {}));
    toast('Lagu masuk antrean');
  } catch (err) {
    toast(err.message);
  }
}

async function queuePlaylist() {
  const playlist = selectedPlaylist();
  if (!playlist) return;
  try {
    renderQueue(await api(`/api/library/playlists/${playlist.id}/queue`, {}));
    toast(`${playlist.songs.length} lagu masuk antrean`);
  } catch (err) {
    toast(err.message);
  }
}

async function addBlocked(type, inputId) {
  const input = $(inputId);
  if (!await changeLibrary('/api/library/blacklist', { type, value: input.value.trim() })) return;
  input.value = '';
}

// Tiga bagian di kartu YT Music: Playlist, Song Requests, dan Blacklist.
function bindYouTubeTabs() {
  const tabs = document.querySelectorAll('.js-yt-tab');
  const show = (name) => {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const pane of document.querySelectorAll('[data-ytpane]')) pane.hidden = pane.dataset.ytpane !== name;
  };
  for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.tab));
}

function bindLibrary() {
  bindYouTubeTabs();
  $('plCreate').addEventListener('click', createPlaylist);
  $('plNewName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createPlaylist();
  });
  $('plSearch').addEventListener('input', renderSearch);
  $('plQueueAll').addEventListener('click', queuePlaylist);
  $('plRename').addEventListener('click', renamePlaylist);
  $('plDelete').addEventListener('click', deletePlaylist);
  $('plAddSong').addEventListener('click', addSong);
  $('plImport').addEventListener('click', importPlaylist);
  $('plImportLink').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') importPlaylist();
  });
  for (const id of ['plTitle', 'plArtist', 'plLink']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addSong();
    });
  }
  $('blSongAdd').addEventListener('click', () => addBlocked('song', 'blSongInput'));
  $('blSongInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addBlocked('song', 'blSongInput');
  });
  $('blUserAdd').addEventListener('click', () => addBlocked('user', 'blUserInput'));
  $('blUserInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addBlocked('user', 'blUserInput');
  });
  $('dockStart').addEventListener('click', () => dockPlayer?.unlock());
  for (const [id, order] of [['ytOrderPlaylist', 'playlist'], ['ytOrderShuffle', 'shuffle']]) {
    $(id).addEventListener('click', async () => {
      try {
        const data = await api('/api/music/playorder', { order });
        playOrder = data.playOrder;
        renderYtMode();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  $('plPlayAll').addEventListener('click', async () => {
    const playlist = selectedPlaylist();
    if (!playlist) return;
    try {
      await api('/api/player/start-playlist', { playlistId: playlist.id });
      toast(`Playlist ${playlist.name} mulai diputar`);
    } catch (err) {
      toast(err.message);
    }
  });
  $('dockSeek').addEventListener('input', () => {
    dockSeeking = true;
  });
  $('dockSeek').addEventListener('change', () => {
    dockPlayer?.seek(Number($('dockSeek').value) / 1000);
    dockSeeking = false;
  });
  $('dockVolume').addEventListener('input', () => dockPlayer?.setVolume(Number($('dockVolume').value)));
  $('dockVideoToggle').addEventListener('click', () => $('dockVideo').classList.toggle('quiet'));
  for (const [id, mode] of [['ytModePlayer', 'player'], ['ytModeExtension', 'extension']]) {
    $(id).addEventListener('click', async () => {
      try {
        const data = await api('/api/music/ytmode', { mode });
        ytMode = data.ytMode;
        playOrder = data.playOrder;
        renderYtMode();
        toast(ytMode === 'extension' ? 'Lagu diputar lewat tab YT Music' : 'Lagu diputar lewat player YouTube');
      } catch (err) {
        toast(err.message);
      }
    });
  }
  $('ytPlayerCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('ytPlayerUrl').textContent);
      toast('Link player disalin');
    } catch {
      toast('Gagal menyalin, salin manual dari teks di atas');
    }
  });
  $('ytPrev').addEventListener('click', () => playerControl('prev'));
  $('ytToggle').addEventListener('click', () => playerControl('toggle'));
  $('ytNext').addEventListener('click', () => playerControl('next'));
  $('ytPlayNext').addEventListener('click', playNextFromQueue);
  $('dockPrev').addEventListener('click', () => playerControl('prev'));
  $('dockToggle').addEventListener('click', () => playerControl('toggle'));
  $('dockNext').addEventListener('click', () => playerControl('next'));
  $('ytQueueClear').addEventListener('click', async () => {
    try {
      renderQueue(await api('/api/queue/clear', {}));
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---- Antrean request dari chat ----

// Antrean dipakai bersama, jadi halaman Spotify dan YT Music menampilkan daftar yang sama.
function renderQueue(items) {
  for (const list of [$('queueList'), $('ytQueueList')]) fillQueue(list, items);
}

function fillQueue(list, items) {
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
  const spotifyOn = spotifyStatus?.connected;
  $('spotifySummary').textContent = `Sumber: Spotify · ${spotifyOn ? 'Spotify terhubung' : 'Spotify belum terhubung'}`;
  const youtubeOn = youtubeStatus?.connected;
  $('youtubeSummary').textContent = `Sumber: YT Music · ${youtubeOn ? 'YT Music terhubung' : 'YT Music belum terhubung'}`;
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
  for (const id of ['activeTemplateName', 'dashTemplateName', 'detailName', 'crumbTemplate', 'spotifyChatName', 'youtubeChatName']) {
    $(id).textContent = name;
  }
  for (const id of ['dashTemplateDesc', 'featuredDesc']) $(id).textContent = desc;
  const colors = info?.querySelector('.mt-1.flex.gap-1');
  $('activeTemplateColors').replaceChildren(...(colors ? [...colors.children].map((dot) => dot.cloneNode(true)) : []));
  const art = card?.querySelector('.aspect-\\[16\\/10\\]');
  $('featuredArt').replaceChildren(...(art ? [art.cloneNode(true)] : []));
}

// ---- Link dan pratinjau ----

// Running text punya satu kartu per overlay. Overlay lain hanya punya satu kartu.
function renderLinks() {
  for (const wrap of document.querySelectorAll('[data-link]')) {
    wrap.replaceChildren();
    const key = wrap.dataset.link;
    const targets = key === 'runningtext'
      ? settings.runningTexts.map((item) => ({ item, label: item.name.trim() || 'Running text' }))
      : [{ item: null, label: OVERLAYS[key].label }];

    for (const { item, label: name } of targets) {
      const url = overlayUrl(key, item);

      const card = document.createElement('div');
      card.className = 'link';

      const top = document.createElement('div');
      top.className = 'link-top';
      const label = document.createElement('b');
      label.textContent = name;

      const actions = document.createElement('div');
      actions.className = 'link-actions';
      const copy = document.createElement('button');
      copy.className = 'btn small';
      copy.type = 'button';
      copy.textContent = 'Salin';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast(`Link ${name} disalin`);
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
}

// Setiap pratinjau di halaman yang sedang terbuka dimuat ulang dengan pengaturan terbaru.
// Pratinjau running text menampilkan overlay yang sedang dipilih.
function refreshPreview() {
  for (const frame of document.querySelectorAll('[data-view]:not([hidden]) [data-frame]')) {
    // Pratinjau di tab yang tidak tampil tidak perlu dimuat. Tab itu dimuat saat dibuka.
    if (frame.closest('[data-subview][hidden]')) continue;
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
  sample.className = `chat tpl-${settings.template}${settings.chatNames === 'top' ? ' names-top' : ''}`;
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

// Kartu template dibuat dari daftar bersama. Contoh teks memakai warna dan font overlay yang dipilih.
function renderRunningTemplates() {
  const grid = $('runningGrid');
  grid.replaceChildren();
  const item = selectedRunningText();
  for (const template of RUNNING_TEXT_TEMPLATES) {
    const on = item.template === template.id;
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
    sample.style.setProperty('--rt-color', item.color);
    const fontStyle = runningTextFontStyle(item.font);
    if (fontStyle) Object.assign(sample.style, fontStyle);
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

// Mengubah satu overlay yang dipilih, lalu menyimpan dan memperbarui link serta pratinjau.
function updateRunningText(patch) {
  Object.assign(selectedRunningText(), patch);
  saveSettings();
  renderLinks();
  refreshPreviewSoon();
}

function selectRunningTemplate(id) {
  const template = RUNNING_TEXT_TEMPLATES.find((t) => t.id === id);
  updateRunningText({ template: id });
  renderRunningTemplates();
  refreshPreview();
  toast(`Template ${template.label} dipakai`);
}

// Daftar overlay: satu tombol per overlay. Yang dipilih menentukan isi form dan pratinjau.
function renderRunningList() {
  const list = $('runningList');
  list.replaceChildren();
  for (const item of settings.runningTexts) {
    const on = item.id === settings.runningSelected;
    const chip = document.createElement('button');
    chip.className = `h-8 px-3 rounded-full border text-[12px] font-bold ${on ? 'bg-black text-white border-black dark:bg-white dark:text-black dark:border-white' : 'bg-white/70 border-black/10 dark:bg-white/5 dark:border-white/10'}`;
    chip.type = 'button';
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(on));
    chip.textContent = item.name.trim() || 'Running text';
    chip.addEventListener('click', () => selectRunningText(item.id));
    list.append(chip);
  }
  $('runningAdd').disabled = settings.runningTexts.length >= RUNNING_MAX;
  $('runningRemove').disabled = settings.runningTexts.length <= 1;
}

// Mengisi semua kontrol running text dari overlay yang dipilih.
function renderRunningText() {
  const item = selectedRunningText();
  $('runningName').value = item.name;
  $('runningFont').value = item.font;
  $('runningWords').value = item.words;
  $('runningHold').value = item.hold;
  $('runningHoldOut').textContent = item.hold;
  $('runningSize').value = item.size;
  $('runningSizeOut').textContent = item.size;
  $('runningColor').value = item.color;
  renderPerspective('runningtext');
  renderRunningTemplates();
  renderRunningList();
}

function selectRunningText(id) {
  settings.runningSelected = id;
  saveSettings();
  renderRunningText();
  refreshPreview();
}

function addRunningText() {
  if (settings.runningTexts.length >= RUNNING_MAX) return;
  const item = newRunningText(`Running text ${settings.runningTexts.length + 1}`);
  settings.runningTexts.push(item);
  settings.runningSelected = item.id;
  saveSettings();
  renderRunningText();
  renderLinks();
  refreshPreview();
  toast('Overlay running text baru dibuat');
}

// Link OBS overlay yang dihapus berhenti bekerja, jadi minta konfirmasi dulu.
function removeRunningText() {
  if (settings.runningTexts.length <= 1) return;
  const item = selectedRunningText();
  if (!window.confirm(`Hapus overlay "${item.name}"? Browser Source di OBS yang memakai linknya akan berhenti.`)) return;
  const index = settings.runningTexts.indexOf(item);
  settings.runningTexts.splice(index, 1);
  settings.runningSelected = settings.runningTexts[Math.max(0, index - 1)].id;
  saveSettings();
  renderRunningText();
  renderLinks();
  refreshPreview();
  toast('Overlay running text dihapus');
}

function bindRunningText() {
  const font = $('runningFont');
  for (const f of RUNNING_TEXT_FONTS) font.append(new Option(f.label, f.id));
  font.addEventListener('change', () => {
    updateRunningText({ font: font.value });
    renderRunningTemplates();
  });

  const name = $('runningName');
  name.addEventListener('input', () => {
    selectedRunningText().name = name.value;
    saveSettings();
    renderRunningList();
    renderLinks();
  });

  const words = $('runningWords');
  words.addEventListener('input', () => updateRunningText({ words: words.value }));

  const hold = $('runningHold');
  hold.addEventListener('input', () => {
    $('runningHoldOut').textContent = hold.value;
    updateRunningText({ hold: Number(hold.value) });
  });

  const size = $('runningSize');
  size.addEventListener('input', () => {
    $('runningSizeOut').textContent = size.value;
    updateRunningText({ size: Number(size.value) });
  });

  const color = $('runningColor');
  color.addEventListener('input', () => {
    updateRunningText({ color: color.value });
    renderRunningTemplates();
  });

  $('runningAdd').addEventListener('click', addRunningText);
  $('runningRemove').addEventListener('click', removeRunningText);

  renderRunningText();
}

// ---- Ukuran dan rata teks overlay lagu (Spotify dan YT Music) ----

// The same choice is on both studio pages, so every control is found by class and kept in sync.
function renderNpOptions() {
  for (const [selector, key] of [['.js-np-fit', 'npFit'], ['.js-np-align', 'npAlign']]) {
    for (const button of document.querySelectorAll(selector)) {
      const on = button.dataset.value === settings[key];
      button.setAttribute('aria-checked', String(on));
      button.setAttribute('aria-selected', String(on));
    }
  }
  for (const input of document.querySelectorAll('.js-np-width')) input.value = settings.npWidth;
  for (const output of document.querySelectorAll('.js-np-width-out')) output.textContent = `${settings.npWidth} px`;
}

function setNpOption(key, value) {
  settings[key] = value;
  saveSettings();
  renderNpOptions();
  renderLinks();
  refreshPreview();
}

function bindNpOptions() {
  for (const button of document.querySelectorAll('.js-np-fit')) {
    button.addEventListener('click', () => setNpOption('npFit', button.dataset.value));
  }
  for (const button of document.querySelectorAll('.js-np-align')) {
    button.addEventListener('click', () => setNpOption('npAlign', button.dataset.value));
  }
  for (const input of document.querySelectorAll('.js-np-width')) {
    input.addEventListener('input', () => {
      settings.npWidth = Number(input.value);
      saveSettings();
      renderNpOptions();
      renderLinks();
      refreshPreviewSoon();
    });
  }
  renderNpOptions();
}

// ---- Lirik Spotify: jenis huruf dan warna. Perspektif memakai bindPerspective seperti overlay lain. ----

function bindLyricsStyle() {
  const font = $('lyricsFont');
  for (const f of RUNNING_TEXT_FONTS) font.append(new Option(f.label, f.id));
  font.value = settings.lyricsFont;
  font.addEventListener('change', () => {
    settings.lyricsFont = font.value;
    saveSettings();
    renderLinks();
    refreshPreviewSoon();
  });

  const color = $('lyricsColor');
  color.value = settings.lyricsColor;
  color.addEventListener('input', () => {
    settings.lyricsColor = color.value;
    saveSettings();
    renderLinks();
    refreshPreviewSoon();
  });
}

// ---- Pembaca komentar dan alert. Suaranya dibuat di overlay (OBS), jadi pilihan suara dibaca dari browser panel ----

function bindTts() {
  for (const [id, key] of [['ttsChat', 'ttsChat'], ['ttsAlert', 'ttsAlert'], ['ttsPrefix', 'ttsPrefix']]) {
    const input = $(id);
    input.checked = settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      saveSettings();
      renderLinks();
    });
  }

  const rate = $('ttsRate');
  rate.value = settings.ttsRate;
  $('ttsRateOut').textContent = `${settings.ttsRate}×`;
  rate.addEventListener('input', () => {
    settings.ttsRate = Number(rate.value);
    $('ttsRateOut').textContent = `${settings.ttsRate}×`;
    saveSettings();
    renderLinks();
  });

  // Daftar suara ada di browser ini, dan kadang baru terisi setelah event voiceschanged.
  const voice = $('ttsVoice');
  const fillVoices = () => {
    voice.replaceChildren(new Option('Otomatis (Bahasa Indonesia)', ''));
    const voices = speechSynthesis.getVoices().slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    for (const v of voices) voice.append(new Option(`${v.name} (${v.lang})`, v.name));
    voice.value = voices.some((v) => v.name === settings.ttsVoice) ? settings.ttsVoice : '';
  };
  fillVoices();
  speechSynthesis.addEventListener('voiceschanged', fillVoices);
  voice.addEventListener('change', () => {
    settings.ttsVoice = voice.value;
    saveSettings();
    renderLinks();
  });

  // Coba suara di browser ini. Bunyinya hanya terdengar di komputer ini, bukan di siaran.
  $('ttsTest').addEventListener('click', () => {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance('Halo, ini contoh suara pembaca komentar.');
    const picked = speechSynthesis.getVoices().find((v) => v.name === settings.ttsVoice);
    utterance.lang = picked?.lang || 'id-ID';
    if (picked) utterance.voice = picked;
    utterance.rate = settings.ttsRate;
    speechSynthesis.speak(utterance);
  });
}

// ---- Pilih lirik lagu: cari di LRCLIB dan simpan pilihan untuk lagu itu ----

// The last song each source reported. The hub sends these to the panel as nowplaying messages.
const latestTrack = { spotify: null, youtube: null, applemusic: null };

// The song the picker works on: the one playing now, in the order YT Music, Apple Music, Spotify.
function lyricsTrack() {
  const order = [latestTrack.youtube, latestTrack.applemusic, latestTrack.spotify];
  return order.find((t) => t?.playing) || order.find(Boolean) || null;
}

function renderLyricsNow() {
  const track = lyricsTrack();
  $('lyricsNow').textContent = track?.key ? `Sedang diputar: ${track.title} — ${track.artist}` : 'Belum ada lagu yang diputar';
  // The search box follows the song. A new song fills it again and clears the old results.
  const input = $('lyricsQuery');
  if (track?.key && input.dataset.key !== track.key) {
    input.dataset.key = track.key;
    input.value = `${track.title} ${track.artist}`.trim();
    $('lyricsResults').replaceChildren();
  }
}

function renderLyricsResults(results) {
  const list = $('lyricsResults');
  list.replaceChildren();
  if (results.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Tidak ada lirik tersinkron yang cocok.';
    list.append(empty);
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    const length = `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}`;
    info.textContent = `${r.title} — ${r.artist}${r.album ? ` · ${r.album}` : ''} · ${length}`;
    const pick = document.createElement('button');
    pick.className = 'btn small';
    pick.type = 'button';
    pick.textContent = 'Pakai';
    pick.addEventListener('click', () => chooseLyrics(r.id));
    li.append(info, pick);
    list.append(li);
  }
}

async function searchLyricsFor() {
  const query = $('lyricsQuery').value.trim();
  if (!query) return toast('Isi judul atau artis dulu');
  try {
    const { results } = await api(`/api/lyrics/search?q=${encodeURIComponent(query)}`);
    renderLyricsResults(results);
  } catch (err) {
    toast(err.message);
  }
}

// id null removes the pick, so the song goes back to automatic lyrics.
async function chooseLyrics(id) {
  const track = lyricsTrack();
  if (!track?.key) return toast('Putar lagu dulu, lalu pilih liriknya');
  try {
    await api('/api/lyrics/override', { key: track.key, id });
    toast(id === null ? 'Kembali ke lirik otomatis' : 'Lirik dipilih untuk lagu ini');
  } catch (err) {
    toast(err.message);
  }
}

function bindLyricsPicker() {
  $('lyricsSearch').addEventListener('click', searchLyricsFor);
  $('lyricsQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchLyricsFor();
  });
  $('lyricsAuto').addEventListener('click', () => chooseLyrics(null));
  renderLyricsNow();
}

// ---- Soundboard: 10 slot. Tiap slot berisi suara yang diunggah sendiri dan dimainkan di overlay OBS ----

const SOUND_MAX_MB = 5;
let soundSlots = [];

// Sends a request to the server and throws the server's message when it fails.
async function soundRequest(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadSoundboard() {
  const { slots } = await soundRequest('/api/soundboard');
  soundSlots = slots;
  $('soundGrid').replaceChildren(...slots.map((slot) => soundCard(slot)));
}

function soundCard(slot) {
  const n = slot.slot + 1;
  const card = document.createElement('div');
  card.className = 'rounded-[18px] border border-black/10 dark:border-white/10 p-3 space-y-2';

  const head = document.createElement('div');
  head.className = 'text-[10px] font-bold tracking-widest opacity-60';
  head.textContent = `SLOT ${n}`;

  const name = document.createElement('input');
  name.className = 'w-full rounded-[10px] border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-[13px] outline-none';
  name.value = slot.name;
  name.placeholder = `Suara ${n}`;
  name.maxLength = 40;
  name.setAttribute('aria-label', `Nama slot ${n}`);
  name.dataset.action = 'name';
  name.dataset.slot = slot.slot;

  const buttons = document.createElement('div');
  buttons.className = 'flex gap-2 flex-wrap';

  const play = document.createElement('button');
  play.className = 'h-8 px-3 rounded-full bg-black text-white text-[11px] font-bold disabled:opacity-40';
  play.type = 'button';
  play.textContent = 'Mainkan';
  play.disabled = !slot.hasFile;
  play.dataset.action = 'play';
  play.dataset.slot = slot.slot;

  // The label wraps a hidden file input, so the whole label opens the file picker.
  const upload = document.createElement('label');
  upload.className = 'h-8 px-3 rounded-full bg-white border border-black/10 text-[11px] font-bold leading-8 cursor-pointer';
  upload.textContent = slot.hasFile ? 'Ganti' : 'Unggah';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg';
  file.style.display = 'none';
  file.dataset.action = 'upload';
  file.dataset.slot = slot.slot;
  upload.append(file);

  const remove = document.createElement('button');
  remove.className = 'h-8 px-3 rounded-full bg-white border border-black/10 text-[11px] font-bold disabled:opacity-40';
  remove.type = 'button';
  remove.textContent = 'Hapus';
  remove.disabled = !slot.hasFile;
  remove.dataset.action = 'remove';
  remove.dataset.slot = slot.slot;

  buttons.append(play, upload, remove);
  const status = document.createElement('div');
  status.className = 'text-[11px] opacity-60';
  status.textContent = slot.hasFile ? 'Ada suara' : 'Kosong';
  card.append(head, name, buttons, status);
  return card;
}

function soundVolume() {
  return Number($('soundVolume').value) / 100;
}

function bindSoundboard() {
  const grid = $('soundGrid');
  grid.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const slot = Number(button.dataset.slot);
    try {
      if (button.dataset.action === 'play') {
        await soundRequest('/api/soundboard/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, volume: soundVolume() }),
        });
      } else if (button.dataset.action === 'remove') {
        await soundRequest(`/api/soundboard/${slot}/file`, { method: 'DELETE' });
        await loadSoundboard();
        toast('Suara dihapus');
      }
    } catch (err) {
      toast(err.message);
    }
  });

  grid.addEventListener('change', async (event) => {
    const input = event.target;
    const slot = Number(input.dataset.slot);
    try {
      if (input.dataset.action === 'upload') {
        const picked = input.files?.[0];
        input.value = '';
        if (!picked) return;
        if (picked.size > SOUND_MAX_MB * 1024 * 1024) return toast(`File terlalu besar, maksimal ${SOUND_MAX_MB} MB`);
        // The file goes up as the raw body. The server checks the contents before it keeps the file.
        await soundRequest(`/api/soundboard/${slot}/file`, {
          method: 'POST',
          headers: { 'Content-Type': picked.type || 'application/octet-stream' },
          body: picked,
        });
        await loadSoundboard();
        toast('Suara diunggah');
      } else if (input.dataset.action === 'name') {
        await soundRequest(`/api/soundboard/${slot}/name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: input.value.trim() }),
        });
        await loadSoundboard();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  $('soundVolume').addEventListener('input', () => {
    $('soundVolumeOut').textContent = `${$('soundVolume').value}%`;
  });
  $('soundStop').addEventListener('click', () => {
    api('/api/soundboard/stop', {}).catch((err) => toast(err.message));
  });
}

// ---- Template custom: background, warna, dan font sendiri untuk overlay lagu (Spotify dan YT Music) ----

function renderNpCustom() {
  $('npBgColor').value = settings.npBgColor;
  $('npTextColor').value = settings.npTextColor;
  $('npAccentColor').value = settings.npAccentColor;
  $('npFont').value = settings.npFont;
  const preview = $('npBgPreview');
  preview.style.backgroundColor = settings.npBgColor;
  preview.style.backgroundImage = settings.npBgVer ? `url("/api/nowplaying/bg?v=${settings.npBgVer}")` : 'none';
  $('npBgRemove').disabled = !settings.npBgVer;
}

function changedNpCustom() {
  saveSettings();
  renderNpCustom();
  renderLinks();
  refreshPreviewSoon();
}

function bindNpCustom() {
  const font = $('npFont');
  for (const f of RUNNING_TEXT_FONTS) font.append(new Option(f.label, f.id));
  for (const [id, key] of [['npBgColor', 'npBgColor'], ['npTextColor', 'npTextColor'], ['npAccentColor', 'npAccentColor']]) {
    $(id).addEventListener('input', () => {
      settings[key] = $(id).value;
      changedNpCustom();
    });
  }
  font.addEventListener('change', () => {
    settings.npFont = font.value;
    changedNpCustom();
  });

  $('npBgFile').addEventListener('change', async (event) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (picked.size > 3 * 1024 * 1024) return toast('Background terlalu besar, maksimal 3 MB');
    try {
      await soundRequest('/api/nowplaying/bg', {
        method: 'POST',
        headers: { 'Content-Type': picked.type || 'application/octet-stream' },
        body: picked,
      });
      // A new version makes the overlay load the new picture.
      settings.npBgVer = Date.now();
      changedNpCustom();
      toast('Background diunggah');
    } catch (err) {
      toast(err.message);
    }
  });
  $('npBgRemove').addEventListener('click', async () => {
    try {
      await soundRequest('/api/nowplaying/bg', { method: 'DELETE' });
      settings.npBgVer = 0;
      changedNpCustom();
      toast('Background dihapus');
    } catch (err) {
      toast(err.message);
    }
  });
  renderNpCustom();
}

// ---- Template Spotify ----

// Kartu template Spotify dibuat dari daftar yang sama dengan overlay, dengan kelas np-* yang sama.
// Semua ukuran .np memakai em, jadi font-size yang kecil membuat kartu contoh ini ikut mengecil.
// Spotify dan YT Music masing-masing punya grid dan pilihan template sendiri.
const NOWPLAYING_SOURCES = {
  nowplaying: { grid: 'spotifyGrid', templateKey: 'spotifyTemplate' },
  youtube: { grid: 'ytGrid', templateKey: 'youtubeTemplate' },
};

function renderNowPlayingTemplates(key) {
  const { grid: gridId, templateKey } = NOWPLAYING_SOURCES[key];
  const grid = $(gridId);
  grid.replaceChildren();
  for (const template of NOWPLAYING_TEMPLATES) {
    const on = settings[templateKey] === template.id;
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
    card.addEventListener('click', () => selectNowPlayingTemplate(key, template.id));
    grid.append(card);
  }
}

function selectNowPlayingTemplate(key, id) {
  const template = NOWPLAYING_TEMPLATES.find((t) => t.id === id);
  settings[NOWPLAYING_SOURCES[key].templateKey] = id;
  saveSettings();
  renderNowPlayingTemplates(key);
  renderLinks();
  refreshPreview();
  toast(`Template ${OVERLAYS[key].label} ${template.label} dipakai`);
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

// Posisi nama penonton: di samping komentar, atau di atas.
const CHAT_NAME_POSITIONS = [
  { id: 'side', label: 'Di samping' },
  { id: 'top', label: 'Di atas' },
];

function renderChatNames() {
  for (const wrap of document.querySelectorAll('.js-chatnames')) {
    wrap.replaceChildren();
    for (const option of CHAT_NAME_POSITIONS) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(settings.chatNames === option.id));
      chip.textContent = option.label;
      chip.addEventListener('click', () => {
        settings.chatNames = option.id;
        renderChatNames();
        saveSettings();
        renderLinks();
        renderSample();
        refreshPreviewSoon();
      });
      wrap.append(chip);
    }
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
      sample.className = `chat tpl-${settings.template}${settings.chatNames === 'top' ? ' names-top' : ''}`;
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

function normalizeAxes(value = {}) {
  return {
    rx: clampTo(Number(value?.rx) || 0, PERSPECTIVE_LIMITS.tilt),
    ry: clampTo(Number(value?.ry) || 0, PERSPECTIVE_LIMITS.tilt),
    depth: clampTo(Number(value?.depth) || DEFAULT_PERSPECTIVE.depth, PERSPECTIVE_LIMITS.depth),
  };
}

function normalizePersp(saved = {}) {
  const result = {};
  for (const key of PERSP_KEYS) result[key] = normalizeAxes(saved?.[key]);
  return result;
}

function perspOutput(axis, value) {
  return axis === 'depth' ? `${value} px` : `${value}°`;
}

function renderPerspective(key) {
  const persp = perspOf(key);
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
  for (const key of PERSP_TARGETS) renderPerspective(key);

  for (const input of document.querySelectorAll('.js-persp')) {
    input.addEventListener('input', () => {
      const key = input.dataset.persp;
      const axis = input.dataset.axis;
      perspOf(key)[axis] = Number(input.value);
      input.closest('.field').querySelector('.js-persp-out').textContent = perspOutput(axis, Number(input.value));
      refreshPerspective(key);
    });
  }

  for (const button of document.querySelectorAll('.js-persp-reset')) {
    button.addEventListener('click', () => {
      const key = button.dataset.persp;
      Object.assign(perspOf(key), DEFAULT_PERSPECTIVE);
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
    case 'nowplaying':
      latestTrack[msg.source] = msg.nowPlaying;
      return renderLyricsNow();
    case 'youtube':
      return renderYouTube(msg);
    case 'player':
      return dockPlayer?.command(msg);
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
renderChatNames();
bindSetting('duration', 'duration', 'durOut');
bindRunningText();
bindAnimDur();
bindPerspective();
bindLibrary();
bindNpOptions();
bindLyricsStyle();
bindNpCustom();
bindLyricsPicker();
bindTts();
bindSoundboard();

renderAnims();
renderGradients();
renderColorControls();

$('username').value = settings.username;
$('welcomeUsername').value = $('username').value;
renderCounts();
bindChatCards();
markChatCards();
renderNowPlayingTemplates('nowplaying');
renderNowPlayingTemplates('youtube');
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

// The chosen way of playing and the play order, as the server has them.
function loadMusicStatus() {
  api('/api/music/status')
    .then((status) => {
      $('autoQueue').checked = status.autoQueue === true;
      ytMode = status.ytMode === 'extension' ? 'extension' : 'player';
      playOrder = status.playOrder === 'shuffle' ? 'shuffle' : 'playlist';
      renderYtMode();
    })
    .catch(() => {});
}
loadMusicStatus();

api('/api/library').then(setLibrary).catch(() => {});

// Recent activity from earlier visits. The server returns newest first; the list shows the
// newest at the top, so the oldest one is added first.
api('/api/queue').then(renderQueue).catch(() => {});

api('/api/feed?limit=60')
  .then((events) => {
    for (const event of events.reverse()) addFeed(event);
  })
  .catch(() => {});
