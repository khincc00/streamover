// Template running text. Dipakai overlay (lewat kelas rt-*) dan kartu pilihan di panel.
export const RUNNING_TEXT_TEMPLATES = [
  { id: 'script', label: 'Script tangan', desc: 'Tulisan tangan, seperti sampel video' },
  { id: 'classic', label: 'Classic bold', desc: 'Huruf tebal kapital, bayangan tegas' },
  { id: 'neon', label: 'Neon glow', desc: 'Teks bercahaya dengan glow' },
  { id: 'outline', label: 'Outline', desc: 'Hanya garis tepi, isi transparan' },
  { id: 'pill', label: 'Pill', desc: 'Teks di dalam kapsul gelap' },
];

export const DEFAULT_RUNNING_TEXT_TEMPLATE = 'script';

export function isRunningTextTemplate(id) {
  return RUNNING_TEXT_TEMPLATES.some((t) => t.id === id);
}

// Pilihan jenis huruf. 'default' memakai huruf bawaan template. Font lain dimuat dari Google Fonts.
// RUNNING_TEXT_FONTS_URL harus sama dengan link di index.html dan overlay/running-text.html.
export const RUNNING_TEXT_FONTS = [
  { id: 'default', label: 'Sesuai template' },
  { id: 'dafoe', label: 'Mr Dafoe', family: 'Mr Dafoe', weight: 400, fallback: 'cursive' },
  { id: 'pacifico', label: 'Pacifico', family: 'Pacifico', weight: 400, fallback: 'cursive' },
  { id: 'lobster', label: 'Lobster', family: 'Lobster', weight: 400, fallback: 'cursive' },
  { id: 'dancing', label: 'Dancing Script', family: 'Dancing Script', weight: 700, fallback: 'cursive' },
  { id: 'bebas', label: 'Bebas Neue', family: 'Bebas Neue', weight: 400, fallback: 'sans-serif' },
  { id: 'anton', label: 'Anton', family: 'Anton', weight: 400, fallback: 'sans-serif' },
  { id: 'bangers', label: 'Bangers', family: 'Bangers', weight: 400, fallback: 'cursive' },
  { id: 'righteous', label: 'Righteous', family: 'Righteous', weight: 400, fallback: 'sans-serif' },
  { id: 'playfair', label: 'Playfair Display', family: 'Playfair Display', weight: 800, fallback: 'serif' },
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat', weight: 800, fallback: 'sans-serif' },
];

export const RUNNING_TEXT_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Mr+Dafoe:wght@400&family=Pacifico:wght@400&family=Lobster:wght@400&family=Dancing+Script:wght@700&family=Bebas+Neue:wght@400&family=Anton:wght@400&family=Bangers:wght@400&family=Righteous:wght@400&family=Playfair+Display:wght@800&family=Montserrat:wght@800&display=swap';

export const DEFAULT_RUNNING_TEXT_FONT = 'default';

export function isRunningTextFont(id) {
  return RUNNING_TEXT_FONTS.some((f) => f.id === id);
}

// Gaya huruf untuk font pilihan. Null berarti pakai huruf bawaan template.
export function runningTextFontStyle(id) {
  const font = RUNNING_TEXT_FONTS.find((f) => f.id === id && f.family);
  if (!font) return null;
  return { fontFamily: `"${font.family}", ${font.fallback}`, fontWeight: String(font.weight) };
}
