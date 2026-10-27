'use strict';
// Saves and restores the user's clipboard text while the extension reads the Google Docs selection.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  const buffer = document.getElementById('buffer');
  if (message.op === 'read') {
    buffer.value = ''; buffer.focus(); document.execCommand('paste');
    sendResponse(buffer.value);
  } else if (message.op === 'write') {
    buffer.value = String(message.text || ''); buffer.select(); document.execCommand('copy');
    sendResponse(true);
  }
  return false;
});
