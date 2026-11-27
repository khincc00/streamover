// Saves the overlay key and the server address. Accepts either the whole overlay link from the panel or the key alone.
const input = document.getElementById('link');
const status = document.getElementById('status');

function keyFrom(text) {
  const value = text.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.searchParams.get('key') || '';
  } catch {
    // Not a link, so the text is taken as the key itself.
    return value;
  }
}

// The address in a pasted link tells the extension which server to send to. A bare key keeps the saved address.
function serverFrom(text) {
  try {
    return new URL(text.trim()).origin;
  } catch {
    return '';
  }
}

function show(text, kind) {
  status.textContent = text;
  status.className = kind;
}

chrome.storage.local.get('overlayKey').then(({ overlayKey }) => {
  if (overlayKey) show('Kunci sudah tersimpan. Tempel link baru untuk menggantinya.', 'ok');
});

document.getElementById('save').addEventListener('click', async () => {
  const overlayKey = keyFrom(input.value);
  if (!overlayKey) {
    show('Tidak menemukan kunci. Pastikan link berisi bagian key=...', 'error');
    return;
  }
  const serverUrl = serverFrom(input.value);
  await chrome.storage.local.set({ overlayKey, ...(serverUrl && { serverUrl }) });
  input.value = '';
  show('Tersimpan. Muat ulang tab music.youtube.com, lalu putar lagu.', 'ok');
});
