'use strict';
const HOST = 'com.rdwrs.doc_rephrase';

// Keyboard shortcut / toolbar button: open Doc Rephrase → Rephrase selection.
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;
  if (!/^https:\/\/docs\.google\.com\/document\/d\//.test(tab.url || '')) {
    await chrome.action.setBadgeText({tabId: tab.id, text: 'DOC'});
    await chrome.action.setTitle({tabId: tab.id, title: 'Open a Google Doc with Doc Rephrase installed first.'});
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['trigger.js']});
    const ok = results[0] && results[0].result && results[0].result.ok;
    await chrome.action.setBadgeText({tabId: tab.id, text: ok ? '' : '!'});
    await chrome.action.setTitle({tabId: tab.id, title: ok ? 'Rephrase selected text in Google Docs' : 'Use Doc Rephrase → Rephrase selection, or install the script in this document.'});
  } catch (error) {
    await chrome.action.setBadgeText({tabId: tab.id, text: '!'});
    await chrome.action.setTitle({tabId: tab.id, title: 'Reload this Google Doc, then try the shortcut again.'});
  }
});

// Only Apps Script frames inside a Google Docs editor tab may reach the helper.
function trustedSender(sender) {
  const top = (sender.tab && sender.tab.url) || '';
  const origin = sender.origin || '';
  return /^https:\/\/docs\.google\.com\/document\/d\//.test(top) &&
    (/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(origin) || origin === 'null' || /^about:/.test(sender.url || ''));
}

function friendlyNativeError(message) {
  if (/not found|forbidden/i.test(message || '')) {
    return 'The Doc Rephrase helper is not installed for this extension. Run install-helper.sh from the Doc-Rephrase folder, then reload this Google Doc.';
  }
  return 'The Doc Rephrase helper stopped unexpectedly. Run install-helper.sh again, then retry.';
}

// One long-lived connection to the helper. While it stays open the helper keeps the API key in
// memory, so 1Password (and macOS) are asked once per Chrome session instead of on every rewrite.
let port = null, nextId = 0;
const pending = new Map();
function helperPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(reply => {
    const done = reply && pending.get(reply.id);
    if (!done) return;
    pending.delete(reply.id);
    delete reply.id;
    done(reply);
  });
  port.onDisconnect.addListener(() => {
    const error = friendlyNativeError(chrome.runtime.lastError && chrome.runtime.lastError.message);
    port = null;
    for (const done of pending.values()) done({ok: false, error});
    pending.clear();
  });
  return port;
}
function askHelper(payload, sendResponse) {
  const id = 'r' + (++nextId);
  pending.set(id, sendResponse);
  try { helperPort().postMessage(Object.assign({}, payload, {id})); }
  catch (e) { pending.delete(id); port = null; sendResponse({ok: false, error: friendlyNativeError(String(e && e.message))}); }
}

function onSidebarMessage(message, sender, sendResponse) {
  if (!message || message.kind !== 'doc-rephrase') return false;
  const type = message.payload && message.payload.type;
  if (!trustedSender(sender) || (type !== 'ping' && type !== 'rewrite')) {
    sendResponse({ok: false, error: 'Doc Rephrase only runs from its Google Docs sidebar.'});
    return false;
  }
  if (type === 'ping') {
    // Tell the sidebar which keys actually run Doc Rephrase (the user may have changed them).
    askHelper(message.payload, reply => chrome.commands.getAll(commands => {
      const command = (commands || []).find(c => c.name === '_execute_action');
      sendResponse(Object.assign({}, reply, {shortcut: (command && command.shortcut) || ''}));
    }));
  } else askHelper(message.payload, sendResponse);
  return true; // Keep the channel open for the async native reply.
}

// Direct channel (externally_connectable) and the content-script relay share one handler.
chrome.runtime.onMessageExternal.addListener(onSidebarMessage);
chrome.runtime.onMessage.addListener(onSidebarMessage);
