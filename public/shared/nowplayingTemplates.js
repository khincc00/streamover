// Daftar template overlay Spotify (lagu yang sedang diputar). Dipakai overlay OBS dan panel kontrol.
export const NOWPLAYING_TEMPLATES = [
  { id: 'classic', label: 'Klasik', hint: 'Kartu gelap dengan sampul kotak' },
  { id: 'retro', label: 'Retro', hint: 'Kaset krem dengan bayangan tegas' },
  { id: 'modern', label: 'Modern', hint: 'Kaca terang gaya Apple Music' },
  { id: 'neon', label: 'Neon', hint: 'Cahaya neon di latar gelap' },
  { id: 'vinyl', label: 'Vinyl', hint: 'Sampul bulat yang berputar' },
];

export const DEFAULT_NOWPLAYING_TEMPLATE = 'classic';

export function isNowPlayingTemplate(id) {
  return NOWPLAYING_TEMPLATES.some((template) => template.id === id);
}
