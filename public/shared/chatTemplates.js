// Satu sumber untuk daftar template chat. Dipakai overlay OBS dan panel kontrol.
export const CHAT_TEMPLATES = [
  { id: 'classic', label: 'Klasik', hint: 'Baris gelap rapi' },
  { id: 'glass', label: 'Kaca', hint: 'Panel buram transparan' },
  { id: 'modern', label: 'Minimal Modern', hint: 'Nama kecil, garis aksen tipis' },
  { id: 'vision', label: 'Vision', hint: 'Kaca tebal dengan cahaya tepi' },
  { id: 'pill', label: 'Kapsul', hint: 'Bentuk pil dengan avatar gradien' },
  { id: 'light', label: 'Terang', hint: 'Kartu putih lembut' },
];

export const DEFAULT_CHAT_TEMPLATE = 'classic';

export function isChatTemplate(id) {
  return CHAT_TEMPLATES.some((template) => template.id === id);
}
