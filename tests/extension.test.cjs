const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const extension = path.join(__dirname, '../extension');
const core = require(path.join(extension, 'core.js'));
const backgroundSource = fs.readFileSync(path.join(extension, 'background.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

// ---------- core.js ----------
test('htmlToText keeps paragraphs and decodes entities from Docs mobilebasic HTML', () => {
  const html = '<html><head><style>p{}</style></head><body><div class="x doc-content"><p><span>Tom &amp; Jerry&#39;s</span></p>' +
    '<p>Second&nbsp;line<br>wrapped</p><table><tr><td>a</td><td>b</td></tr></table></div></body></html>';
  assert.equal(core.htmlToText(html), "Tom & Jerry's\nSecond line\nwrapped\na\tb");
});
test('buildRequest finds the passage in the document and adds the surrounding sentence', () => {
  const built = core.buildRequest({selection: 'awkward words', docText: 'Intro.\nBefore awkward words after.\nEnd.',
    title: 'Draft', tone: 'concise', effort: 'high', guidance: '  keep it short '});
  assert.deepEqual(plain(built.request.passages), [{selected_text: 'awkward words', before: 'Before ', after: ' after.'}]);
  assert.equal(built.request.type, 'rewrite');
  assert.equal(built.request.effort, 'high');
  assert.equal(built.request.guidance, 'keep it short');
  assert.equal(built.request.context, 'Intro.\nBefore awkward words after.\nEnd.');
});
test('buildRequest splits paragraphs, skips blank lines, and limits size', () => {
  const built = core.buildRequest({selection: 'First para\r\n\r\nSecond para', docText: 'First para\n\nSecond para', tone: 'natural', effort: 'low'});
  assert.deepEqual(built.request.passages.map(p => p.selected_text), ['First para', 'Second para']);
  assert.throws(() => core.buildRequest({selection: '   ', docText: 'x'}), /Highlight some text/);
  assert.throws(() => core.buildRequest({selection: 'x'.repeat(10001), docText: ''}), /shorter passage/);
  const long = 'a'.repeat(150000) + 'TARGET' + 'b'.repeat(150000);
  const windowed = core.buildRequest({selection: 'TARGET', docText: long});
  assert.equal(windowed.request.context.length, core.MAX_CONTEXT);
  assert.ok(windowed.request.context.includes('TARGET'));
});
test('assemble puts rewrites back between blank lines and keeps edge whitespace', () => {
  assert.equal(core.assemble(' First para \n\nSecond para', ['Better first', ' Better second ']), ' Better first \n\nBetter second');
  assert.throws(() => core.assemble('One\nTwo', ['only one']), /does not match/);
});
test('sameText ignores Docs line-ending and trailing-space differences', () => {
  assert.ok(core.sameText('a\u000bb  \r\n', 'a\nb'));
  assert.ok(!core.sameText('a', 'b'));
});

// ---------- background.js ----------
function background({selection = 'awkward words', embedded = false, docHtml = '<div class="doc-content"><p>Before awkward words after.</p></div>',
  helperReply = {ok: true, paragraphs: ['clear words'], note: 'Clearer.', model: 'claude-opus-5-5'}, tabUrl = 'https://docs.google.com/document/d/abc/edit',
  diskVersion = '3.0.0'} = {}) {
  const listeners = {}, session = {}, sent = [], pasted = [], clipboardOps = [], reloads = [];
  let currentSelection = selection;
  const on = name => ({addListener: fn => { listeners[name] = fn; }});
  const chrome = {
    runtime: {id: 'ext', lastError: undefined, onMessage: on('message'),
      getURL: p => 'chrome-extension://ext/' + p, getManifest: () => ({version: '3.0.0'}), reload: () => reloads.push(1),
      sendMessage: async message => { if (message.target === 'offscreen') { clipboardOps.push(message.op); return message.op === 'read' ? 'user clipboard' : true; } },
      connectNative: () => {
        const msg = [];
        return {onMessage: {addListener: fn => msg.push(fn)}, onDisconnect: {addListener() {}},
          postMessage: payload => { sent.push(payload); const reply = payload.type === 'ping' ? {ok: true, configured: true, model: 'm'} : helperReply;
            msg.forEach(fn => fn(Object.assign({}, reply, {id: payload.id}))); }};
      }},
    offscreen: {createDocument: async () => {}},
    sidePanel: {setPanelBehavior: async () => {}, open: async () => {}},
    action: {onClicked: on('clicked')},
    commands: {getAll: async () => [{name: '_execute_action', shortcut: '⌥⇧R'}]},
    tabs: {query: async () => [{id: 7, windowId: 1, url: tabUrl}]},
    storage: {session: {get: async k => ({[k]: session[k]}), set: async o => Object.assign(session, o)}},
    scripting: {executeScript: async ({func, args}) => {
      if (func.name === 'pageCapture') return [{result: {ok: true, text: currentSelection, embedded, docId: 'abc', docTab: '', title: 'Draft'}}];
      if (func.name === 'pageFetchDoc') return [{result: docHtml}];
      if (func.name === 'pagePaste') { pasted.push(args[0]); return [{result: {ok: true}}]; }
    }},
  };
  const ctx = vm.createContext({chrome, DataTransfer: class {}, ClipboardEvent: class {}, URLSearchParams, console,
    fetch: async () => ({json: async () => ({version: diskVersion})}), setTimeout: fn => fn(),
    importScripts: () => vm.runInContext(fs.readFileSync(path.join(extension, 'core.js'), 'utf8').replace(/^if \(typeof module.*$/m, ''), ctx)});
  vm.runInContext(backgroundSource, ctx);
  const panel = {id: 'ext', url: 'chrome-extension://ext/panel.html'};
  const ask = (message, sender = panel) => new Promise(resolve => {
    const keep = listeners.message(Object.assign({kind: 'panel'}, message), sender, resolve);
    if (!keep) resolve(undefined);
  });
  return {ask, listeners, session, sent, pasted, clipboardOps, reloads, select: s => { currentSelection = s; }};
}

test('status reports the helper, the real shortcut, and checks for an updated extension', async () => {
  const b = background({diskVersion: '3.1.0'});
  const reply = await b.ask({action: 'status'});
  assert.equal(reply.ok, true);
  assert.equal(reply.isDoc, true);
  assert.equal(reply.shortcut, '⌥⇧R');
  assert.equal(reply.helper.configured, true);
  await new Promise(r => setImmediate(r));
  assert.equal(b.reloads.length, 1);
});
test('rewrite reads the selection, restores the clipboard, and sends context to the helper', async () => {
  const b = background();
  const reply = await b.ask({action: 'rewrite', tone: 'natural', effort: 'medium', guidance: ''});
  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.paragraphs), ['clear words']);
  assert.deepEqual(b.clipboardOps, ['read', 'write']);
  const request = b.sent.find(m => m.type === 'rewrite');
  assert.deepEqual(plain(request.passages), [{selected_text: 'awkward words', before: 'Before ', after: ' after.'}]);
  assert.equal(request.effort, 'medium');
});
test('rewrite refuses selections with images or footnotes, and empty selections', async () => {
  assert.match((await background({embedded: true}).ask({action: 'rewrite'})).error, /image, drawing/);
  assert.match((await background({selection: ''}).ask({action: 'rewrite'})).error, /Highlight some text/);
});
test('apply pastes only when the original passage is still highlighted', async () => {
  const b = background();
  await b.ask({action: 'rewrite', tone: 'natural', effort: 'low'});
  b.select('something else');
  assert.match((await b.ask({action: 'apply', paragraphs: ['clear words']})).error, /highlighted text changed/);
  assert.equal(b.pasted.length, 0);
  b.select('awkward words');
  assert.equal((await b.ask({action: 'apply', paragraphs: ['clear words']})).ok, true);
  assert.deepEqual(b.pasted, ['clear words']);
});
test('only the extension\'s own side panel can request work', async () => {
  const b = background();
  assert.equal(await b.ask({action: 'rewrite'}, {id: 'other', url: 'chrome-extension://other/panel.html'}), undefined);
  assert.equal(await b.ask({action: 'rewrite'}, {id: 'ext', url: 'https://docs.google.com/x'}), undefined);
  assert.equal(b.sent.length, 0);
});
test('outside Google Docs the panel explains what to do', async () => {
  const b = background({tabUrl: 'https://example.com/'});
  assert.match((await b.ask({action: 'rewrite'})).error, /Open a Google Doc/);
});
test('the shortcut opens the panel, captures the selection, and marks it to run automatically', async () => {
  const b = background();
  b.listeners.clicked({id: 7, windowId: 1, url: 'https://docs.google.com/document/d/abc/edit'});
  await new Promise(r => setTimeout(r, 10));
  assert.equal(b.session['tab:7'].original, 'awkward words');
  assert.equal(b.session['tab:7'].autoRun, true);
  const status = await b.ask({action: 'status'});
  assert.equal(status.state.autoRun, true);
  assert.equal(b.session['tab:7'].autoRun, false); // consumed once
});

// ---------- page functions (run against a fake Docs page) ----------
// The page functions are self-contained; take each one's source text, as chrome.scripting does.
function pageFunction(name) {
  const at = backgroundSource.search(new RegExp('(async )?function ' + name + '\\('));
  const source = backgroundSource.slice(at, backgroundSource.indexOf('\n}\n', at) + 2);
  return {toString: () => source};
}
test('pageCapture reads the selection through the copy event Docs fills in', () => {
  const listeners = [];
  const view = {addEventListener: (t, fn) => listeners.push(fn), removeEventListener: () => listeners.pop()};
  const frameDoc = {defaultView: view, execCommand: () => {
    const event = {clipboardData: {getData: type => type === 'text/plain' ? 'be useful.' : '<span>be useful.</span>'}};
    listeners.forEach(fn => fn(event)); return true; }};
  const capture = pageFunction('pageCapture');
  const ctx = vm.createContext({document: {querySelector: () => ({contentDocument: frameDoc}), title: 'Draft - Google Docs'},
    location: {pathname: '/document/d/abc123/edit', search: '?tab=t.0'}, URLSearchParams});
  const result = vm.runInContext('(' + capture.toString() + ')()', ctx);
  assert.deepEqual(plain(result), {ok: true, text: 'be useful.', embedded: false, docId: 'abc123', docTab: 't.0', title: 'Draft'});
  assert.equal(listeners.length, 0);
});
test('pagePaste hands Docs a paste event with the new text', () => {
  let dispatched = null;
  const editable = {dispatchEvent: e => { dispatched = e; return false; }};
  const paste = pageFunction('pagePaste');
  class DataTransfer { constructor() { this.data = {}; } setData(t, v) { this.data[t] = v; } }
  class ClipboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const ctx = vm.createContext({DataTransfer, ClipboardEvent,
    document: {querySelector: () => ({contentDocument: {querySelector: () => editable}})}});
  assert.deepEqual(plain(vm.runInContext('(' + paste.toString() + ')("prove helpful.")', ctx)), {ok: true});
  assert.equal(dispatched.type, 'paste');
  assert.equal(dispatched.clipboardData.data['text/plain'], 'prove helpful.');
});
test('manifest asks only for what the extension uses and keeps its fixed ID key', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.ok(manifest.key);
  assert.deepEqual(manifest.host_permissions, ['https://docs.google.com/*']);
  assert.equal(manifest.side_panel.default_path, 'panel.html');
  assert.equal(manifest.commands._execute_action.suggested_key.mac, 'Alt+Shift+R');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});
