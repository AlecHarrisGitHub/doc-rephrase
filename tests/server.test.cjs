const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../apps-script/Server.gs'), 'utf8');

class Element {
  constructor(kind, children = []) { this.kind = kind; this.children = children; children.forEach(child => {child.parent = this;}); }
  getType() { return this.kind; }
  getParent() { return this.parent; }
  getChildIndex(child) { return this.children.indexOf(child); }
  getChild(i) { if (!this.children[i]) throw Error('Child missing'); return this.children[i]; }
  getNumChildren() { return this.children.length; }
  getText() { return this.children.map(c => c.getText()).join(this.kind === 'BODY_SECTION' ? '\n' : ''); }
  editAsText() { if (this.children.length !== 1) throw Error('Mock supports one text per paragraph'); return this.children[0]; }
}
class Text extends Element {
  constructor(text) { super('TEXT'); this.text = text; this.attributes = {FONT_SIZE: 11, BOLD: false}; }
  asText() { return this; }
  getText() { return this.text; }
  getAttributes() { return this.attributes; }
  insertText(i, value) { this.text = this.text.slice(0, i) + value + this.text.slice(i); return this; }
  deleteText(start, end) { this.text = this.text.slice(0, start) + this.text.slice(end + 1); return this; }
  setAttributes(start, end, attrs) { this.appliedAttrs = {start, end, attrs}; return this; }
}
const paragraph = value => new Element('PARAGRAPH', [new Text(value)]);
const range = (element, start, end) => ({getElement: () => element, isPartial: () => start != null,
  getStartOffset: () => start, getEndOffsetInclusive: () => end});

function fixture(texts = ['Before awkward words after.']) {
  const body = new Element('BODY_SECTION', texts.map(paragraph));
  const props = new Map(), cache = new Map();
  const docTab = {getBody: () => body, getHeader: () => null, getFooter: () => null, getFootnotes: () => []};
  const tab = {getId: () => 'tab-1', getTitle: () => 'Draft', asDocumentTab: () => docTab, getChildTabs: () => []};
  const state = {selection: [range(body.getChild(0).getChild(0), 7, 19)], tabs: [tab]};
  const doc = {getId: () => 'document-1', getActiveTab: () => tab, getTab: id => id === 'tab-1' ? tab : null,
    getTabs: () => state.tabs, getSelection: () => state.selection && ({getRangeElements: () => state.selection})};
  const locks = () => ({tryLock: () => true, releaseLock() {}});
  const ctx = vm.createContext({Date, JSON, console,
    DocumentApp: {getActiveDocument: () => doc},
    PropertiesService: {getUserProperties: () => ({getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v), setProperties: o => Object.entries(o).forEach(([k, v]) => props.set(k, v)), deleteProperty: k => props.delete(k)})},
    CacheService: {getUserCache: () => ({put: (k, v) => cache.set(k, v), get: k => cache.get(k), remove: k => cache.delete(k)})},
    Utilities: {getUuid: () => crypto.randomUUID(), DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, value) => crypto.createHash('sha256').update(value).digest(),
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'), newBlob: value => ({getBytes: () => Buffer.from(value)})},
    LockService: {getUserLock: locks, getDocumentLock: locks}
  });
  vm.runInContext(source, ctx);
  return {ctx, body, doc, docTab, tab, state, props, cache};
}
function generated(f) {
  const selection = f.ctx.captureSelection();
  selection.prepared = f.ctx.prepareRephrase(selection.token, 'natural', '');
  return selection;
}

test('captures the exact substring, keeping original paragraph context', () => {
  const f = fixture(); const s = f.ctx.captureSelection();
  assert.equal(s.original, 'awkward words');
  const snapshot = f.ctx.getSnapshot_(s.token);
  assert.equal(snapshot.blocks[0].full, 'Before awkward words after.');
});
test('rejects no selection and unsupported inline content without API requests', () => {
  const f = fixture(); f.state.selection = null;
  assert.throws(() => f.ctx.captureSelection(), /Highlight/);
  const img = new Element('INLINE_IMAGE'); img.parent = f.body.getChild(0);
  f.body.getChild(0).children.push(img);
  f.state.selection = [range(f.body.getChild(0), null, null)];
  assert.throws(() => f.ctx.captureSelection(), /footnote marker, image/);
});
test('captures complete paragraph selections as well as text ranges', () => {
  const f = fixture(['Full paragraph.']); f.state.selection = [range(f.body.getChild(0), null, null)];
  assert.equal(f.ctx.captureSelection().original, 'Full paragraph.');
});
test('supports consecutive paragraphs and preserves paragraph boundaries when replacing', () => {
  const f = fixture(['First awkward ending', 'Awkward second start.']);
  f.state.selection = [range(f.body.getChild(0).getChild(0), 6, 19), range(f.body.getChild(1).getChild(0), 0, 6)];
  const s = generated(f);
  assert.equal(s.original, 'awkward ending\nAwkward');
  f.ctx.applyRephrase(s.token, ['clear ending', 'Clear']);
  assert.equal(f.body.getText(), 'First clear ending\nClear second start.');
  assert.equal(f.body.getNumChildren(), 2);
});
test('rejects noncontiguous selections and cross-cell selections', () => {
  const f = fixture(['First', 'Middle', 'Last']);
  f.state.selection = [range(f.body.getChild(0), null, null), range(f.body.getChild(2), null, null)];
  assert.throws(() => f.ctx.captureSelection(), /continuous passage/);
  const first = paragraph('First cell'), second = paragraph('Second cell');
  const table = new Element('TABLE', [new Element('TABLE_ROW', [
    new Element('TABLE_CELL', [first]), new Element('TABLE_CELL', [second])])]);
  table.parent = f.body; f.body.children = [table];
  f.state.selection = [range(first, null, null), range(second, null, null)];
  assert.throws(() => f.ctx.captureSelection(), /continuous passage/);
});
test('supports text selected within a single table cell', () => {
  const f = fixture(); const p = paragraph('Cell awkward words.');
  const table = new Element('TABLE', [new Element('TABLE_ROW', [new Element('TABLE_CELL', [p])])]);
  table.parent = f.body; f.body.children = [table];
  f.state.selection = [range(p.getChild(0), 5, 17)];
  const s = generated(f); f.ctx.applyRephrase(s.token, ['clear words']);
  assert.equal(p.getText(), 'Cell clear words.');
});
test('merges adjacent text nodes correctly', () => {
  const f = fixture(); const p = new Element('PARAGRAPH', [new Text('Hello '), new Text('world!')]);
  p.parent = f.body; f.body.children = [p];
  f.state.selection = [range(p.getChild(0), 3, 5), range(p.getChild(1), 0, 2)];
  assert.equal(f.ctx.captureSelection().original, 'lo wor');
});
test('sends all tabs including nested tabs and auxiliary document text', () => {
  const f = fixture();
  const nested = {getId: () => 'tab-2', getTitle: () => 'Nested', getChildTabs: () => [], asDocumentTab: () => ({
    getBody: () => ({getText: () => 'Nested context'}), getHeader: () => ({getText: () => 'Heading context'}),
    getFooter: () => null, getFootnotes: () => [{getFootnoteContents: () => ({getText: () => 'Note context'})}]
  })};
  f.tab.getChildTabs = () => [nested];
  const {request} = generated(f).prepared;
  assert.match(request.context, /Nested context/);
  assert.match(request.context, /Heading context/);
  assert.match(request.context, /Note context/);
  assert.equal(request.type, 'rewrite');
  assert.deepEqual(JSON.parse(JSON.stringify(request.passages)), [{selected_text: 'awkward words', before: 'Before ', after: ' after.'}]);
});
test('refuses a selected tab over the context limit without sending it', () => {
  const f = fixture();
  const s = f.ctx.captureSelection();
  f.docTab.getHeader = () => ({getText: () => 'a'.repeat(200001)});
  assert.throws(() => f.ctx.prepareRephrase(s.token, 'natural', ''), /longer than/);
});
test('sends the selected tab first and skips whole other tabs that do not fit', () => {
  const f = fixture();
  const other = (id, title, text) => ({getId: () => id, getTitle: () => title, getChildTabs: () => [], asDocumentTab: () => ({
    getBody: () => ({getText: () => text}), getHeader: () => null, getFooter: () => null, getFootnotes: () => []})});
  f.state.tabs = [other('t0', 'Huge outline', 'x'.repeat(199990)), f.tab, other('t2', 'Small notes', 'Small context')];
  const {request} = generated(f).prepared;
  assert.ok(request.context.startsWith('TAB: Draft\nBefore awkward words after.'));
  assert.match(request.context, /Small context/);
  assert.doesNotMatch(request.context, /xxxx/);
  const result = f.ctx.prepareRephrase(f.ctx.captureSelection().token, 'natural', '');
  assert.equal(result.contextTabs, 2);
  assert.equal(result.skippedTabs, 1);
});
test('rejects a stale snapshot before calling OpenAI or replacing text', () => {
  const f = fixture(); const s = generated(f);
  f.body.getChild(0).getChild(0).insertText(0, 'New ');
  assert.throws(() => f.ctx.applyRephrase(s.token, ['clear words']), /changed/);
  assert.throws(() => f.ctx.prepareRephrase(s.token, 'natural', ''), /changed/);
  assert.equal(f.body.getText(), 'New Before awkward words after.');
});
test('replaces only the captured selection and refuses duplicate apply', () => {
  const f = fixture(); const s = generated(f);
  f.state.selection = null; // Moving the cursor must not change the target.
  f.ctx.applyRephrase(s.token, ['clear words']);
  assert.equal(f.body.getText(), 'Before clear words after.');
  assert.throws(() => f.ctx.applyRephrase(s.token, ['again']), /expired/);
});
test('preserves boundary whitespace and first-character formatting', () => {
  const f = fixture(['Before awkward words after.']);
  f.state.selection = [range(f.body.getChild(0).getChild(0), 6, 20)];
  const s = generated(f);
  f.ctx.applyRephrase(s.token, [' clear words ']);
  assert.equal(f.body.getText(), 'Before clear words after.');
  assert.equal(f.body.getChild(0).getChild(0).appliedAttrs.attrs.FONT_SIZE, 11);
});
test('full-paragraph replacement does not detach the text element', () => {
  const f = fixture(['Awkward words.']); f.state.selection = [range(f.body.getChild(0), null, null)];
  const s = generated(f); f.ctx.applyRephrase(s.token, ['Clear words.']);
  assert.equal(f.body.getText(), 'Clear words.');
});
test('does not apply ungenerated, expired, foreign-document, or malformed suggestions', () => {
  const f = fixture(); const s = f.ctx.captureSelection();
  assert.throws(() => f.ctx.applyRephrase(s.token, ['rewrite']), /Generate/);
  const snap = f.ctx.getSnapshot_(s.token); snap.docId = 'other'; f.ctx.putSnapshot_(s.token, snap);
  assert.throws(() => f.ctx.getSnapshot_(s.token), /another document/);
  snap.docId = 'document-1'; snap.created = Date.now() - 2000000; f.ctx.putSnapshot_(s.token, snap);
  assert.throws(() => f.ctx.getSnapshot_(s.token), /expired/);
  assert.throws(() => f.ctx.validateParagraphs_(['one\ntwo'], 1), /line breaks/);
  assert.throws(() => f.ctx.validateParagraphs_(['one', 'two'], 1), /one nonempty/);
});
test('escapes document text embedded in sidebar bootstrap', () => {
  const f = fixture(); const raw = {text: '</script><script>alert(1)</script>&\u2028'};
  const escaped = f.ctx.safeJson_(raw);
  assert.doesNotMatch(escaped, /<|>|&/);
  assert.deepEqual(JSON.parse(escaped), raw);
});
test('never handles an API key and clears one left by the OpenAI version', () => {
  const f = fixture();
  f.props.set('DR_API_KEY', 'sk-old-key'); f.props.set('DR_MODEL', 'gpt-5-mini');
  const ui = {showSidebar() {}};
  f.ctx.DocumentApp.getUi = () => ui;
  f.ctx.HtmlService = {createHtmlOutput: () => ({setTitle: () => ({})})};
  f.ctx.sidebarHtml_ = () => '__BOOT_JSON__';
  f.ctx.openRephraseSidebar();
  assert.equal(f.props.has('DR_API_KEY'), false);
  assert.equal(f.props.has('DR_MODEL'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.getRephraseSettings())), {tone: 'natural', effort: 'low'});
  assert.doesNotMatch(source, /UrlFetchApp|api\.openai\.com|api\.anthropic\.com/);
});
function footnoteParagraph(f) {
  // "...alignment training.[footnote] This discrepancy ... has much more data."
  const p = new Element('PARAGRAPH', [new Text('A small chunk is dedicated to alignment training.'),
    new Element('FOOTNOTE_REFERENCE'), new Text(' This gap matters because deployment has much more data.')]);
  p.parent = f.body; f.body.children = [p];
  return p;
}
test('rewrites text in a paragraph that has a footnote marker, leaving the marker in place', () => {
  const f = fixture(); const p = footnoteParagraph(f);
  const second = p.getChild(2), at = second.getText().indexOf('more data.');
  f.state.selection = [range(second, at, second.getText().length - 1)];
  const s = generated(f);
  assert.equal(s.original, 'more data.');
  const passage = JSON.parse(JSON.stringify(s.prepared.request.passages[0]));
  assert.equal(passage.before, 'A small chunk is dedicated to alignment training. This gap matters because deployment has much ');
  assert.equal(passage.after, '');
  f.ctx.applyRephrase(s.token, ['far more data.']);
  assert.equal(p.getChild(1).getType(), 'FOOTNOTE_REFERENCE');
  assert.equal(p.getChild(0).getText(), 'A small chunk is dedicated to alignment training.');
  assert.equal(second.getText(), ' This gap matters because deployment has much far more data.');
});
test('refuses a selection that includes the footnote marker itself', () => {
  const f = fixture(); const p = footnoteParagraph(f);
  f.state.selection = [range(p.getChild(0), 20, 49), range(p.getChild(1), null, null), range(p.getChild(2), 0, 5)];
  assert.throws(() => f.ctx.captureSelection(), /footnote marker/);
});
test('refuses two pieces on either side of a marker when the marker was not selected', () => {
  const f = fixture(); const p = footnoteParagraph(f);
  f.state.selection = [range(p.getChild(0), 20, 49), range(p.getChild(2), 0, 5)];
  assert.throws(() => f.ctx.captureSelection(), /continuous passage/);
});
test('effort is passed to the helper, remembered, and limited to known levels', () => {
  const f = fixture(); const s = f.ctx.captureSelection();
  assert.equal(f.ctx.prepareRephrase(s.token, 'concise', '', 'high').request.effort, 'high');
  assert.equal(f.ctx.getRephraseSettings().effort, 'high');
  assert.equal(f.ctx.prepareRephrase(s.token, 'concise', '', 'extreme').request.effort, 'low');
});
