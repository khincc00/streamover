// Satu sumber untuk daftar template chat. Dipakai overlay OBS dan panel kontrol.
export const CHAT_TEMPLATES = [
  { id: 'classic', label: 'Klasik', hint: 'Baris gelap rapi' },
  { id: 'glass', label: 'Kaca', hint: 'Panel buram transparan' },
  { id: 'modern', label: 'Minimal Modern', hint: 'Nama kecil, garis aksen tipis' },
  { id: 'vision', label: 'Vision', hint: 'Kaca tebal dengan cahaya tepi' },
  { id: 'pill', label: 'Kapsul', hint: 'Bentuk pil dengan avatar gradien' },
  { id: 'light', label: 'Terang', hint: 'Kartu putih lembut' },
  { id: 'apple', label: 'Liquid Glass', hint: 'Kaca cair dengan blur tebal' },
  { id: 'cyberpunk', label: 'Cyberpunk', hint: 'Sudut tajam, neon, dan garis pemindai' },
  { id: 'y2k', label: 'Y2K', hint: 'Gelembung krom dengan warna pastel' },
  { id: 'kawaii', label: 'Kawaii', hint: 'Sudut membulat dengan telinga kucing' },
  { id: 'minimalis', label: 'Minimalis Putih', hint: 'Putih polos dengan garis tipis' },
  { id: 'vaporwave', label: 'Vaporwave', hint: 'Latar ungu dengan bingkai gradien' },
  { id: 'grunge', label: 'Grunge', hint: 'Kertas sobek dengan selotip kuning' },
  { id: 'esports', label: 'Esports', hint: 'HUD taktis dengan garis hijau' },
  { id: 'pixel', label: 'Pixel 8-bit', hint: 'Kotak tegas dengan bayangan piksel' },
  { id: 'cottage', label: 'Cottagecore', hint: 'Kertas krem dengan nuansa botani' },
  { id: 'comic', label: 'Komik', hint: 'Balon komik dengan titik halftone' },
];

export const DEFAULT_CHAT_TEMPLATE = 'apple';

export function isChatTemplate(id) {
  return CHAT_TEMPLATES.some((template) => template.id === id);
}
