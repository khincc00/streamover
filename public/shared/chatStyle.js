// Animasi dan warna chat. Dipakai overlay OBS, kartu template, dan link di panel.
export const CHAT_ANIMATIONS = [
  { id: 'up', label: 'Naik', name: 'chat-up' },
  { id: 'fade', label: 'Pudar', name: 'chat-fade' },
  { id: 'left', label: 'Geser', name: 'chat-left' },
  { id: 'zoom', label: 'Zoom', name: 'chat-zoom' },
  { id: 'bounce', label: 'Pantul', name: 'chat-bounce' },
  { id: 'none', label: 'Tanpa animasi', name: 'none' },
];

export const CHAT_DURATION = { min: 100, max: 1000, step: 50 };

export const DEFAULT_CHAT_STYLE = {
  anim: 'up',
  dur: 250,
  custom: false, // false: warna mengikuti template
  accent: '#6ee7ff', // warna nama
  text: '#ffffff',
  bg: '#000000',
};

const HEX = /^#[0-9a-f]{6}$/i;

// Dipakai untuk data dari localStorage maupun dari URL, jadi semua nilai diperiksa ulang.
export function normalizeStyle(raw = {}) {
  const style = { ...DEFAULT_CHAT_STYLE };
  for (const key of Object.keys(DEFAULT_CHAT_STYLE)) {
    if (raw[key] !== undefined) style[key] = raw[key];
  }

  if (!CHAT_ANIMATIONS.some((a) => a.id === style.anim)) style.anim = DEFAULT_CHAT_STYLE.anim;
  const dur = Math.round(Number(style.dur) / CHAT_DURATION.step) * CHAT_DURATION.step;
  style.dur = Number.isFinite(dur) ? Math.min(CHAT_DURATION.max, Math.max(CHAT_DURATION.min, dur)) : DEFAULT_CHAT_STYLE.dur;
  for (const key of ['accent', 'text', 'bg']) {
    if (!HEX.test(style[key])) style[key] = DEFAULT_CHAT_STYLE[key];
  }
  style.custom = Boolean(style.custom);
  return style;
}

// Membaca gaya dari URL overlay. Warna di URL tanpa tanda #, misalnya accent=6ee7ff.
export function styleFromParams(params) {
  const hex = (value) => (/^[0-9a-f]{6}$/i.test(value || '') ? `#${value}` : undefined);
  return normalizeStyle({
    anim: params.get('anim') || undefined,
    dur: params.get('dur') || undefined,
    custom: params.get('custom') === '1',
    accent: hex(params.get('accent')),
    text: hex(params.get('text')),
    bg: hex(params.get('bg')),
  });
}

// Variabel CSS untuk satu elemen chat. Warna hanya dikirim kalau "custom" aktif.
export function styleVars(style) {
  const animation = CHAT_ANIMATIONS.find((a) => a.id === style.anim).name;
  const vars = {
    '--chat-anim': animation,
    '--chat-dur': `${style.dur}ms`,
  };
  if (style.custom) {
    vars['--chat-accent'] = style.accent;
    vars['--chat-text'] = style.text;
    vars['--chat-bg'] = style.bg;
  }
  return vars;
}

export function applyStyle(element, style) {
  for (const [name, value] of Object.entries(styleVars(style))) {
    element.style.setProperty(name, value);
  }
}
