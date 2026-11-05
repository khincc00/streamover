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
