'use strict';
importScripts('core.js');
const HOST = 'com.rdwrs.doc_rephrase';
const DOCS_URL = /^https:\/\/docs\.google\.com\/document\/d\//;

// --- Functions injected into the Google Docs page --------------------------------------------
// They run in the page's isolated world; Docs keeps its editable text target in a same-origin iframe.

// Reads the current selection the way Docs' own Copy does, without a visible clipboard change
// (the background worker restores the previous clipboard text right after).
function pageCapture() {
  const frame = document.querySelector('iframe.docs-texteventtarget-iframe');
  const target = frame && frame.contentDocument;
  if (!target) return {ok: false, error: 'Click into the document text, highlight a passage, then try again.'};
  let text = '', html = '';
  const onCopy = e => { text = e.clipboardData.getData('text/plain'); html = e.clipboardData.getData('text/html') || ''; };
  target.defaultView.addEventListener('copy', onCopy);
  try { target.execCommand('copy'); } finally { target.defaultView.removeEventListener('copy', onCopy); }
  const id = location.pathname.match(/\/document\/d\/([^/]+)/);
  return {ok: true, text, embedded: /<img\b|<svg\b|ftnt|footnote|kix-equation/i.test(html),
    docId: id && id[1], docTab: new URLSearchParams(location.search).get('tab') || '',
    title: document.title.replace(/ - Google Docs$/, '')};
}
// Same-origin "mobilebasic" view of the document: its current text, for context.
async function pageFetchDoc(docId, docTab) {
  const url = '/document/d/' + encodeURIComponent(docId) + '/mobilebasic' + (docTab ? '?tab=' + encodeURIComponent(docTab) : '');
  const response = await fetch(url, {credentials: 'include'});
  return response.ok ? response.text() : '';
}
// Replaces the selection by handing Docs a paste event, so it behaves like typing (Cmd+Z undoes it).
function pagePaste(text) {
  const frame = document.querySelector('iframe.docs-texteventtarget-iframe');
  const editable = frame && frame.contentDocument && frame.contentDocument.querySelector('[contenteditable="true"]');
  if (!editable) return {ok: false, error: 'Click into the document, then try again.'};
  const data = new DataTransfer();
  data.setData('text/plain', text);
  editable.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  return {ok: true};
}

// --- Clipboard: save and restore around pageCapture via an offscreen document ---------------------
async function clipboard(op, text) {
  try {
    await chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['CLIPBOARD'],
      justification: 'Keep the clipboard unchanged while reading the Google Docs selection.'});
  } catch (e) { if (!/single offscreen|already/i.test(String(e && e.message))) throw e; }
  return chrome.runtime.sendMessage({target: 'offscreen', op, text});
}
async function inTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({target: {tabId}, func, args});
  return result && result.result;
}
async function readSelection(tabId) {
  let saved = null;
  try { saved = await clipboard('read'); } catch (e) { /* Restoring is best effort. */ }
  try { return await inTab(tabId, pageCapture); }
  finally { if (typeof saved === 'string' && saved) await clipboard('write', saved).catch(() => {}); }
}

// --- Per-tab state (survives the service worker being suspended) ----------------------------------
const stateKey = tabId => 'tab:' + tabId;
async function getState(tabId) { return (await chrome.storage.session.get(stateKey(tabId)))[stateKey(tabId)] || null; }
async function setState(tabId, value) { await chrome.storage.session.set({[stateKey(tabId)]: value}); }

// Capture the highlighted passage and the document text. Throws a readable error.
async function capture(tabId) {
  let sel = await readSelection(tabId).catch(() => null);
  if (!sel || !sel.ok) {  // The document may still be loading; give it a moment and try once more.
    await new Promise(resolve => setTimeout(resolve, 600));
    sel = await readSelection(tabId).catch(e => ({ok: false, error: 'Reload the document and try again (' + e.message + ').'}));
  }
  if (!sel || !sel.ok) throw new Error((sel && sel.error) || 'Could not read the selection. Reload the document and try again.');
  if (!sel.text.trim()) throw new Error('Highlight some text in the document first.');
  if (sel.embedded) throw new Error('Your selection includes an image, drawing, equation, or footnote. Highlight only the words around it.');
  const docText = DR_CORE.htmlToText(await inTab(tabId, pageFetchDoc, [sel.docId, sel.docTab]).catch(() => ''));
  const state = {original: DR_CORE.norm(sel.text), docText, title: sel.title, at: Date.now()};
  await setState(tabId, state);
  return state;
}

// --- Native helper: one long-lived connection, so the key stays cached for the Chrome session -----
let port = null, nextId = 0;
const pending = new Map();
function friendlyNativeError(message) {
  if (/not found|forbidden/i.test(message || '')) {
    return 'The Doc Rephrase helper is not installed. Run ./install.sh in the doc-rephrase folder, then quit and reopen Chrome.';
  }
  return 'The Doc Rephrase helper stopped unexpectedly. Run ./install.sh again, then retry.';
}
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
    for (const done of pending.values()) done({ok: false, error, disconnected: true});
    pending.clear();
  });
  return port;
}
// If the helper was restarted or crashed mid-request, reconnect and try once more.
async function askHelper(payload) {
  const reply = await askHelperOnce(payload);
  return reply && reply.disconnected ? askHelperOnce(payload) : reply;
}
function askHelperOnce(payload) {
  return new Promise(resolve => {
    const id = 'r' + (++nextId);
    pending.set(id, resolve);
    try { helperPort().postMessage(Object.assign({}, payload, {id})); }
    catch (e) { pending.delete(id); port = null; resolve({ok: false, error: friendlyNativeError(String(e && e.message)), disconnected: true}); }
  });
}

// Unpacked extensions read their files from disk. When manifest.json on disk is newer than the
// running version (after `git pull`), reload so the update takes effect without chrome://extensions.
let reloadScheduled = false;
async function reloadIfUpdated() {
  if (reloadScheduled) return;
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), {cache: 'no-store'})).json();
    if (!reloadScheduled && onDisk.version && onDisk.version !== chrome.runtime.getManifest().version) {
      reloadScheduled = true;
      setTimeout(() => chrome.runtime.reload(), 1500);
    }
  } catch (e) { /* Keep running the loaded version. */ }
}

// --- Shortcut / toolbar button: open the side panel and read the selection -----------------------
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(() => {});
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({windowId: tab.windowId}).catch(() => {}); // Must run inside the user gesture.
  const work = DOCS_URL.test(tab.url || '')
    ? capture(tab.id).then(state => setState(tab.id, Object.assign(state, {autoRun: true})))
    : Promise.reject(new Error('Open a Google Doc, highlight a passage, then press the shortcut.'));
  work.catch(e => setState(tab.id, {error: e.message, at: Date.now()}))
    .then(() => chrome.runtime.sendMessage({kind: 'panel-refresh', tabId: tab.id}).catch(() => {}));
});

// --- Requests from the side panel -----------------------------------------------------------------
async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  return tab;
}
const publicState = s => s && {original: s.original, title: s.title, error: s.error, autoRun: !!s.autoRun};

async function handlePanel(message) {
  const tab = await activeTab();
  const isDoc = !!tab && DOCS_URL.test(tab.url || '');
  switch (message.action) {
    case 'status': {
      reloadIfUpdated();
      const helper = await askHelper({type: 'ping'});
      const commands = await chrome.commands.getAll();
      const command = commands.find(c => c.name === '_execute_action');
      const state = isDoc ? await getState(tab.id) : null;
      if (state && state.autoRun) await setState(tab.id, Object.assign({}, state, {autoRun: false}));
      return {ok: true, isDoc, helper, shortcut: (command && command.shortcut) || '', state: publicState(state)};
    }
    case 'rewrite': {
      if (!isDoc) throw new Error('Open a Google Doc and highlight a passage first.');
      // Use what is highlighted now; if nothing is, reuse the passage already shown.
      let state = null;
      try { state = await capture(tab.id); }
      catch (e) { state = await getState(tab.id); if (!state || !state.original) throw e; }
      const built = DR_CORE.buildRequest({selection: state.original, docText: state.docText, title: state.title,
        tone: message.tone, effort: message.effort, guidance: message.guidance});
      const reply = await askHelper(built.request);
      if (!reply.ok) throw new Error(reply.error || 'The Doc Rephrase helper failed.');
      return {ok: true, original: state.original, paragraphs: reply.paragraphs, note: reply.note, model: reply.model,
        contextCharacters: built.contextCharacters};
    }
    case 'apply': {
      if (!isDoc) throw new Error('Switch back to the document tab first.');
      const state = await getState(tab.id);
      if (!state || !state.original) throw new Error('Highlight the passage and request a rewrite first.');
      const text = DR_CORE.assemble(state.original, message.paragraphs || []);
      const sel = await readSelection(tab.id);
      if (!sel || !sel.ok || !DR_CORE.sameText(sel.text, state.original)) {
        throw new Error('The highlighted text changed. Highlight the original passage again to replace it, or use Copy text.');
      }
      const done = await inTab(tab.id, pagePaste, [text]);
      if (!done || !done.ok) throw new Error((done && done.error) || 'Could not replace the text.');
      await setState(tab.id, {at: Date.now()});
      return {ok: true};
    }
    default:
      throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's side panel may ask for work; offscreen messages are handled there.
  if (!message || message.kind !== 'panel' || sender.id !== chrome.runtime.id || !/\/panel\.html$/.test(sender.url || '')) return false;
  handlePanel(message).then(sendResponse, e => sendResponse({ok: false, error: String(e && e.message || e)}));
  return true;
});
