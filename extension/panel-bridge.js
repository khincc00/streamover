// Runs on the Streamover panel. Takes the overlay key of the logged-in account, so the extension
// works without copying a link. The panel's own session API already returns that key.
(async () => {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    const session = await res.json();
    const overlayKey = session.overlayKey || '';
    if (!overlayKey) return;
    const { overlayKey: saved } = await chrome.storage.local.get('overlayKey');
    if (saved !== overlayKey) await chrome.storage.local.set({ overlayKey });
  } catch {
    // The panel works without the extension, so a failed read is ignored.
  }
})();
