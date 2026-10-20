const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const extension = path.join(__dirname, '../extension');
const trigger = fs.readFileSync(path.join(extension, 'trigger.js'), 'utf8');
const background = fs.readFileSync(path.join(extension, 'background.js'), 'utf8');
const relay = fs.readFileSync(path.join(extension, 'relay.js'), 'utf8');

function environment({menuPresent = true, alreadyOpen = false, opens = true, busy = false} = {}) {
  const state = {open: alreadyOpen, events: [], notices: []};
  const element = (text, kind) => ({textContent: text, style: {},
    querySelector: () => null, getClientRects: () => [1], getBoundingClientRect: () => ({x: 0, y: 0, width: 50, height: 20}),
    dispatchEvent(event) {state.events.push([kind, event.type]); if (kind === 'menu' && event.type === 'mousedown' && opens) state.open = true;},
    setAttribute() {}, remove() {}});
  const menu = element('Doc Rephrase', 'menu'), action = element('Rephrase selection', 'action');
  const document = {
    querySelectorAll: selector => selector.includes('menubar') ? (menuPresent ? [menu] : []) : (state.open ? [action] : []),
    getElementById: () => null, createElement: () => element('', 'notice'),
    body: {appendChild: div => state.notices.push(div.textContent)}
  };
  const ctx = vm.createContext({document, window: {__docRephraseTriggerBusy: busy},
    getComputedStyle: () => ({visibility: 'visible'}), MouseEvent: class {constructor(type) {this.type = type;}},
    setTimeout: (fn, ms) => {if (ms < 1000) fn();}, console});
  return {ctx, state};
}
test('shortcut opens the exact menu and activates Rephrase selection', async () => {
  const f = environment(); const result = await vm.runInContext(trigger, f.ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(f.state.events, [['menu', 'mousedown'], ['menu', 'mouseup'], ['menu', 'click'],
    ['action', 'mousedown'], ['action', 'mouseup'], ['action', 'click']]);
  assert.equal(f.ctx.window.__docRephraseTriggerBusy, false);
});
test('missing installation produces an actionable notice without clicks', async () => {
  const f = environment({menuPresent: false}); const result = await vm.runInContext(trigger, f.ctx);
  assert.equal(result.ok, false); assert.equal(f.state.events.length, 0);
  assert.match(f.state.notices[0], /Install the Doc Rephrase Apps Script/);
});
test('an already-open menu runs the action without closing the menu first', async () => {
  const f = environment({alreadyOpen: true}); await vm.runInContext(trigger, f.ctx);
  assert.equal(f.state.events[0][0], 'action');
  assert.equal(f.state.events.length, 3);
});
test('overlapping shortcut invocations do not double-trigger the action', async () => {
  const f = environment({busy: true}); await vm.runInContext(trigger, f.ctx);
  assert.equal(f.state.events.length, 0);
});
test('changed menu markup times out with a manual-menu fallback', async () => {
  const f = environment({opens: false}); const result = await vm.runInContext(trigger, f.ctx);
  assert.equal(result.ok, false);
  assert.match(f.state.notices[0], /Choose Doc Rephrase/);
  assert.equal(f.ctx.window.__docRephraseTriggerBusy, false);
});
test('background injects only in Google Docs and reports injection failures', async () => {
  let handler, fail = false; const calls = [], badges = [];
  const ctx = vm.createContext({chrome: {
    action: {onClicked: {addListener: fn => {handler = fn;}}, setBadgeText: async value => badges.push(value), setTitle: async () => {}},
    scripting: {executeScript: async options => {calls.push(options); if (fail) throw Error('blocked'); return [{result: {ok: true}}];}},
    runtime: {onMessage: {addListener() {}}, onMessageExternal: {addListener() {}}}
  }});
  vm.runInContext(background, ctx);
  await handler({id: 1, url: 'https://example.com/document/d/123'});
  assert.equal(calls.length, 0); assert.equal(badges.at(-1).text, 'DOC');
  await handler({id: 2, url: 'https://docs.google.com/document/d/example/edit'});
  assert.equal(calls.length, 1); assert.equal(badges.at(-1).text, '');
  fail = true; await handler({id: 2, url: 'https://docs.google.com/document/d/example/edit'});
  assert.equal(badges.at(-1).text, '!');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'nativeMessaging']);
  assert.ok(manifest.key, 'manifest key pins the extension ID the helper trusts');
  assert.equal(manifest.commands._execute_action.suggested_key.mac, 'Alt+Shift+R');
});

function backgroundWithNative(nativeReply, lastError) {
  let onMessage, onExternal; const sent = [], connects = [];
  const runtime = {onMessage: {addListener: fn => {onMessage = fn;}}, onMessageExternal: {addListener: fn => {onExternal = fn;}}, lastError: undefined,
    connectNative: host => {
      connects.push(host);
      const msgListeners = [], discListeners = [];
      const port = {onMessage: {addListener: fn => msgListeners.push(fn)}, onDisconnect: {addListener: fn => discListeners.push(fn)},
        postMessage: payload => {
          const {id, ...rest} = payload; sent.push({host, payload: rest});
          if (lastError) { runtime.lastError = lastError; discListeners.forEach(fn => fn()); runtime.lastError = undefined; }
          else msgListeners.forEach(fn => fn(Object.assign({}, nativeReply, {id})));
        }};
      return port;
    }};
  const commands = {getAll: cb => cb([{name: '_execute_action', shortcut: '⌥⇧R'}])};
  const ctx = vm.createContext({chrome: {action: {onClicked: {addListener() {}}}, runtime, commands}});
  vm.runInContext(background, ctx);
  const ask = (message, sender) => new Promise(resolve => onMessage(message, sender, resolve));
  const askExternal = (message, sender) => new Promise(resolve => onExternal(message, sender, resolve));
  return {ask, askExternal, sent, connects};
}
const docsSender = {tab: {url: 'https://docs.google.com/document/d/abc/edit'}, origin: 'https://n-abc123-0lu-script.googleusercontent.com', url: 'https://n-abc123-0lu-script.googleusercontent.com/userCodeAppPanel'};
test('background forwards sidebar requests to the native helper', async () => {
  const f = backgroundWithNative({ok: true, version: '2.0.0'});
  const reply = await f.ask({kind: 'doc-rephrase', payload: {type: 'ping'}}, docsSender);
  assert.equal(reply.ok, true);
  assert.equal(reply.shortcut, '⌥⇧R');
  assert.equal(f.sent[0].host, 'com.rdwrs.doc_rephrase');
});
test('background refuses requests that do not come from a Google Docs script frame', async () => {
  const f = backgroundWithNative({ok: true});
  for (const sender of [
    {tab: {url: 'https://evil.example/document/d/abc'}, origin: docsSender.origin},
    {tab: {url: docsSender.tab.url}, origin: 'https://evil.example'},
    {tab: {url: 'https://docs.google.com/spreadsheets/d/x'}, origin: docsSender.origin}]) {
    const reply = await f.ask({kind: 'doc-rephrase', payload: {type: 'rewrite'}}, sender);
    assert.equal(reply.ok, false);
  }
  const reply = await f.ask({kind: 'doc-rephrase', payload: {type: 'anything-else'}}, docsSender);
  assert.equal(reply.ok, false);
  assert.equal(f.sent.length, 0);
});
test('background explains a missing helper installation', async () => {
  const f = backgroundWithNative(undefined, {message: 'Specified native messaging host not found.'});
  const reply = await f.ask({kind: 'doc-rephrase', payload: {type: 'ping'}}, docsSender);
  assert.match(reply.error, /install-helper\.sh/);
});
test('relay only bridges messages from its own frame', async () => {
  const listeners = [], posted = [], forwarded = [];
  const win = {addEventListener: (t, fn) => listeners.push(fn), postMessage: msg => posted.push(msg)};
  const ctx = vm.createContext({window: win, setInterval() {}, chrome: {runtime: {lastError: undefined,
    sendMessage: (msg, cb) => { forwarded.push(msg); cb({ok: true, echoed: msg.payload.type}); }}}});
  vm.runInContext(relay, ctx);
  assert.equal(posted[0].ready, true);
  listeners[0]({source: {}, data: {source: 'doc-rephrase-page', id: 'x', payload: {type: 'ping'}}});
  assert.equal(forwarded.length, 0);
  listeners[0]({source: win, data: {source: 'doc-rephrase-page', id: 'y', payload: {type: 'ping'}}});
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(forwarded[0]), {kind: 'doc-rephrase', payload: {type: 'ping'}});
  assert.deepEqual(plain(posted.at(-1)), {source: 'doc-rephrase-extension', id: 'y', response: {ok: true, echoed: 'ping'}});
  listeners[0]({source: win, data: {source: 'doc-rephrase-page', id: 'z', payload: {type: 'delete-everything'}}});
  assert.equal(forwarded.length, 1);
  assert.equal(posted.at(-1).response.ok, false);
});
test('direct externally_connectable messages get the same checks and forwarding', async () => {
  const f = backgroundWithNative({ok: true, version: '2.0.0'});
  assert.equal((await f.askExternal({kind: 'doc-rephrase', payload: {type: 'ping'}}, docsSender)).ok, true);
  assert.equal((await f.askExternal({kind: 'doc-rephrase', payload: {type: 'ping'}}, {tab: {url: 'https://evil.example/'}, origin: 'https://evil.example'})).ok, false);
  assert.equal(f.sent.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.externally_connectable.matches, ['https://*.googleusercontent.com/*']);
});
test('relay re-attaches its listener after the frame is rewritten', () => {
  const listeners = new Set(), timers = [];
  const win = {addEventListener: (t, fn) => listeners.add(fn), postMessage() {}};
  const ctx = vm.createContext({window: win, setInterval: fn => timers.push(fn), chrome: {runtime: {}}});
  vm.runInContext(relay, ctx);
  assert.equal(listeners.size, 1);
  listeners.clear(); // document.open() erases listeners
  timers[0]();
  assert.equal(listeners.size, 1);
});
test('background reuses one helper connection so the key stays cached', async () => {
  const f = backgroundWithNative({ok: true});
  await f.ask({kind: 'doc-rephrase', payload: {type: 'ping'}}, docsSender);
  await f.ask({kind: 'doc-rephrase', payload: {type: 'rewrite'}}, docsSender);
  assert.equal(f.connects.length, 1);
  assert.equal(f.sent.length, 2);
});
