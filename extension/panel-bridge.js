// Runs on the Streamover panel. Takes the overlay key and the server address of the logged-in account,
// so the extension works without copying a link. The panel's own session API already returns the key.
(async () => {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    const session = await res.json();
    const overlayKey = session.overlayKey || '';
    if (!overlayKey) return;
    const { overlayKey: savedKey, serverUrl: savedServer } = await chrome.storage.local.get(['overlayKey', 'serverUrl']);
    const update = {};
    if (savedKey !== overlayKey) update.overlayKey = overlayKey;
    if (savedServer !== location.origin) update.serverUrl = location.origin;
    if (Object.keys(update).length) await chrome.storage.local.set(update);
  } catch {
    // The panel works without the extension, so a failed read is ignored.
  }
})();
