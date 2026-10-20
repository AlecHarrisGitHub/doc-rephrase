'use strict';
// Runs inside Google-hosted script frames (the Doc Rephrase sidebar is one of them).
// Bridges window.postMessage from the sidebar to the extension's background worker,
// which forwards to the local helper. No document text is read or stored here.
(() => {
  const PAGE = 'doc-rephrase-page', EXTENSION = 'doc-rephrase-extension';
  const reply = (id, response) => window.postMessage({source: EXTENSION, id, response}, '*');
  function onMessage(event) {
    const data = event.data;
    // Only the frame's own scripts, not parent or child frames, may use the bridge.
    if (event.source !== window || !data || data.source !== PAGE || typeof data.id !== 'string') return;
    const type = data.payload && data.payload.type;
    if (type !== 'ping' && type !== 'rewrite') return reply(data.id, {ok: false, error: 'Unknown request.'});
    try {
      chrome.runtime.sendMessage({kind: 'doc-rephrase', payload: data.payload}, response => {
        if (chrome.runtime.lastError) {
          reply(data.id, {ok: false, error: 'Reload this Google Doc: the Doc Rephrase extension was updated or restarted.'});
        } else reply(data.id, response);
      });
    } catch (e) {
      reply(data.id, {ok: false, error: 'Reload this Google Doc: the Doc Rephrase extension was updated or restarted.'});
    }
  }
  // Apps Script writes the sidebar with document.open(), which erases event listeners.
  // Re-adding the same function is a no-op while it is still attached.
  window.addEventListener('message', onMessage);
  setInterval(() => window.addEventListener('message', onMessage), 500);
  window.postMessage({source: EXTENSION, ready: true}, '*');
})();
