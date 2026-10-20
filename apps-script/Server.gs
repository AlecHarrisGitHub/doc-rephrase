/** @OnlyCurrentDoc */
// Doc Rephrase — Google Docs bound script.
// This script never sees an API key: it captures the selection, gathers document context and applies
// the edit. The Claude request is made by the local helper (via the Chrome extension), which reads the
// key from 1Password at request time.
var DR = {maxContext: 200000, maxSelection: 10000, ttl: 1800};
var DR_TONES = {
  natural: 'Make the writing clear, natural, and polished while preserving the author\'s voice.',
  concise: 'Make the writing more concise without losing important meaning or nuance.',
  professional: 'Use a polished, professional tone with direct, accessible language.',
  academic: 'Use precise academic prose. Preserve hedges, technical terminology, and citations.',
  friendly: 'Make the writing warm, approachable, and conversational.'
};

function onOpen() {
  DocumentApp.getUi().createMenu('Doc Rephrase')
    .addItem('Rephrase selection', 'rephraseSelection')
    .addItem('Open sidebar / settings', 'openRephraseSidebar').addToUi();
}

function rephraseSelection() { showRephrase_(true); }
function openRephraseSidebar() { showRephrase_(false); }

function showRephrase_(autoRun) {
  clearLegacySettings_();
  var boot = {settings: getRephraseSettings(), autoRun: autoRun};
  if (autoRun) {
    try { boot.selection = captureSelection(); }
    catch (e) { boot.error = e.message; boot.autoRun = false; }
  }
  var html = sidebarHtml_().replace('__BOOT_JSON__', safeJson_(boot));
  DocumentApp.getUi().showSidebar(HtmlService.createHtmlOutput(html).setTitle('Doc Rephrase'));
}

function safeJson_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

var DR_EFFORTS = ['low', 'medium', 'high', 'max'];

function getRephraseSettings() {
  var p = PropertiesService.getUserProperties();
  return {tone: p.getProperty('DR_TONE') || 'natural', effort: p.getProperty('DR_EFFORT') || 'low'};
}

// Earlier versions stored an OpenAI key in user properties. Remove it if present.
function clearLegacySettings_() {
  var p = PropertiesService.getUserProperties();
  ['DR_API_KEY', 'DR_MODEL'].forEach(function(k) { if (p.getProperty(k) != null) p.deleteProperty(k); });
}

function type_(el) { return String(el.getType()); }
function path_(el) {
  var result = [];
  while (type_(el) !== 'BODY_SECTION') {
    var parent = el.getParent();
    if (!parent || typeof parent.getChildIndex !== 'function') {
      throw new Error('Select text in the document body, including a list or table cell.');
    }
    result.unshift(parent.getChildIndex(el));
    el = parent;
  }
  return result;
}
function atPath_(body, path) {
  var el = body;
  for (var i = 0; i < path.length; i++) el = el.getChild(path[i]);
  return el;
}
function fingerprint_(body) {
  var structure = [];
  function visit(el) {
    structure.push(type_(el));
    if (type_(el) === 'TEXT') structure.push(el.asText().getText());
    if (typeof el.getNumChildren === 'function') {
      structure.push(el.getNumChildren());
      for (var i = 0; i < el.getNumChildren(); i++) visit(el.getChild(i));
    }
  }
  visit(body);
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify(structure), Utilities.Charset.UTF_8));
}

function captureSelection() {
  var doc = DocumentApp.getActiveDocument();
  var range = doc.getSelection();
  if (!range) throw new Error('Highlight a sentence or passage in the document, then try again.');
  var tab = doc.getActiveTab();
  var body = tab.asDocumentTab().getBody();
  var pieces = [];
  function add(el, start, end) {
    var kind = type_(el);
    if (kind === 'TEXT') {
      var text = el.asText().getText();
      if (!text.length) return;
      pieces.push({element: el, start: start == null ? 0 : start, end: end == null ? text.length - 1 : end});
    } else if (kind === 'PARAGRAPH' || kind === 'LIST_ITEM') {
      for (var j = 0; j < el.getNumChildren(); j++) add(el.getChild(j), null, null);
    } else if (kind === 'TABLE' || kind === 'TABLE_ROW' || kind === 'TABLE_CELL') {
      throw new Error('Select text inside one table cell, not the whole table.');
    } else {
      throw new Error('Your selection includes a footnote marker, image, equation, or smart chip. Highlight only the words next to it.');
    }
  }
  range.getRangeElements().forEach(function(re) {
    add(re.getElement(), re.isPartial() ? re.getStartOffset() : null,
      re.isPartial() ? re.getEndOffsetInclusive() : null);
  });
  // Group the selected text pieces by paragraph. Footnote markers, images and chips elsewhere in a
  // paragraph are fine: only the selected TEXT elements are read and, later, edited.
  var groups = {};
  pieces.forEach(function(piece) {
    var para = piece.element.getParent();
    if (type_(para) !== 'PARAGRAPH' && type_(para) !== 'LIST_ITEM') throw new Error('Select ordinary document text.');
    var path = path_(para), id = path.join('.');
    if (!groups[id]) groups[id] = {path: path, kind: type_(para), para: para, pieces: []};
    groups[id].pieces.push({child: para.getChildIndex(piece.element), start: piece.start, end: piece.end});
  });
  var blocks = Object.keys(groups).map(function(id) {
    var group = groups[id], para = group.para;
    var textOf = function(i) { return type_(para.getChild(i)) === 'TEXT' ? para.getChild(i).asText().getText() : ''; };
    var ps = group.pieces.sort(function(a, b) { return a.child - b.child || a.start - b.start; });
    for (var k = 1; k < ps.length; k++) {
      // Consecutive selected pieces must touch: the earlier one runs to the end of its text and the
      // later one starts at 0 in the very next child. Anything between them was not selected.
      if (ps[k].child !== ps[k - 1].child + 1 || ps[k].start !== 0 || ps[k - 1].end !== textOf(ps[k - 1].child).length - 1) {
        throw new Error('Highlight one continuous passage.');
      }
    }
    var first = ps[0], last = ps[ps.length - 1], before = '', after = '';
    for (var c = 0; c < first.child; c++) before += textOf(c);
    before += textOf(first.child).slice(0, first.start);
    after = textOf(last.child).slice(last.end + 1);
    for (c = last.child + 1; c < para.getNumChildren(); c++) after += textOf(c);
    var original = ps.map(function(pc) { return textOf(pc.child).slice(pc.start, pc.end + 1); }).join('');
    return {path: group.path, kind: group.kind, full: para.getText(), pieces: ps,
      original: original, before: before, after: after};
  }).sort(function(a, b) { return comparePaths_(a.path, b.path); });
  if (!blocks.length || !blocks.map(function(b) { return b.original; }).join('').trim()) {
    throw new Error('Highlight some words, not just whitespace.');
  }
  // Require consecutive sibling paragraphs. Never guess across cells or disjoint selections.
  for (var i = 1; i < blocks.length; i++) {
    var previous = blocks[i - 1], current = blocks[i];
    if (previous.path.slice(0, -1).join('.') !== current.path.slice(0, -1).join('.') ||
        current.path[current.path.length - 1] !== previous.path[previous.path.length - 1] + 1 ||
        previous.after !== '' || current.before !== '') {
      throw new Error('Select one continuous passage within the body or one table cell, without empty paragraphs.');
    }
  }
  var original = blocks.map(function(b) { return b.original; }).join('\n');
  if (original.length > DR.maxSelection) throw new Error('Select a shorter passage (up to 10,000 characters).');
  var snapshot = {docId: doc.getId(), tabId: tab.getId(), tabTitle: tab.getTitle(),
    fingerprint: fingerprint_(body), blocks: blocks, created: Date.now()};
  var token = Utilities.getUuid();
  putSnapshot_(token, snapshot);
  return {token: token, original: original, paragraphs: blocks.length, tabTitle: snapshot.tabTitle};
}

function comparePaths_(a, b) {
  for (var i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function cacheKey_(token) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(String(token))) throw new Error('Capture a new selection.');
  return 'DR_' + token;
}
function putSnapshot_(token, value) {
  var json = JSON.stringify(value);
  if (Utilities.newBlob(json).getBytes().length > 90000) throw new Error('That paragraph is too large. Select text in a shorter paragraph.');
  CacheService.getUserCache().put(cacheKey_(token), json, DR.ttl);
}
function getSnapshot_(token) {
  var raw = CacheService.getUserCache().get(cacheKey_(token));
  if (!raw) throw new Error('This selection expired. Highlight the passage and capture it again.');
  var snapshot = JSON.parse(raw);
  if (Date.now() - snapshot.created > DR.ttl * 1000) throw new Error('This selection expired. Capture it again.');
  if (snapshot.docId !== DocumentApp.getActiveDocument().getId()) throw new Error('This selection belongs to another document.');
  return snapshot;
}
function checkedBody_(snapshot) {
  var tab = DocumentApp.getActiveDocument().getTab(snapshot.tabId);
  if (!tab) throw new Error('The original tab no longer exists. Capture a new selection.');
  var body = tab.asDocumentTab().getBody();
  if (fingerprint_(body) !== snapshot.fingerprint) {
    throw new Error('The document tab changed after this selection was captured. Highlight the passage again and generate a fresh suggestion.');
  }
  return body;
}

// The selected tab is always sent in full; other tabs follow in document order while they fit.
// A tab that would overflow the budget is skipped whole, never cut mid-text.
function context_(doc, activeTabId) {
  var entries = [];
  function tabText(tab, name) {
    var dt = tab.asDocumentTab(), chunks = [];
    function push(label, text) { if (text) chunks.push(label + ': ' + name + '\n' + text); }
    push('TAB', dt.getBody().getText());
    var header = dt.getHeader(), footer = dt.getFooter();
    if (header) push('HEADER', header.getText());
    if (footer) push('FOOTER', footer.getText());
    dt.getFootnotes().forEach(function(note) {
      var contents = note.getFootnoteContents();
      if (contents) push('FOOTNOTE', contents.getText());
    });
    return chunks.join('\n\n');
  }
  function visit(tabs, prefix) {
    tabs.forEach(function(tab) {
      var name = prefix + tab.getTitle();
      entries.push({active: tab.getId() === activeTabId, text: tabText(tab, name)});
      visit(tab.getChildTabs(), name + ' / ');
    });
  }
  visit(doc.getTabs(), '');
  var active = entries.filter(function(e) { return e.active; })[0];
  if (!active) throw new Error('Could not find the selected tab. Reload the document and try again.');
  if (active.text.length > DR.maxContext) {
    throw new Error('This tab is longer than the ' + DR.maxContext.toLocaleString() + '-character context limit. Nothing has been sent.');
  }
  var chunks = [active.text], total = active.text.length, skipped = 0;
  entries.forEach(function(e) {
    if (e.active || !e.text) return;
    if (total + e.text.length + 2 > DR.maxContext) { skipped++; return; }
    chunks.push(e.text); total += e.text.length + 2;
  });
  return {text: chunks.join('\n\n'), tabs: chunks.length, skipped: skipped, characters: total};
}

// Returns everything the helper needs to write a rewrite. Nothing leaves Google from here.
function prepareRephrase(token, tone, guidance, effort) {
  var snapshot = getSnapshot_(token);
  checkedBody_(snapshot);
  var context = context_(DocumentApp.getActiveDocument(), snapshot.tabId);
  guidance = String(guidance || '').trim();
  if (guidance.length > 2000) throw new Error('Keep your extra instructions below 2,000 characters.');
  tone = DR_TONES[tone] ? tone : 'natural';
  effort = DR_EFFORTS.indexOf(effort) >= 0 ? effort : 'low';
  PropertiesService.getUserProperties().setProperties({DR_TONE: tone, DR_EFFORT: effort});
  snapshot.generated = true;
  putSnapshot_(token, snapshot);
  return {
    request: {type: 'rewrite', context: context.text, selected_tab: snapshot.tabTitle, tone: tone, effort: effort, guidance: guidance,
      passages: snapshot.blocks.map(function(b) {
        return {selected_text: b.original, before: b.before, after: b.after};
      })},
    contextTabs: context.tabs, skippedTabs: context.skipped, contextCharacters: context.characters
  };
}

function validateParagraphs_(paragraphs, count) {
  if (!Array.isArray(paragraphs) || paragraphs.length !== count || paragraphs.some(function(p) {
    return typeof p !== 'string' || !p.trim() || /[\r\n]/.test(p);
  }) || paragraphs.join('').length > 20000) {
    throw new Error('The rewrite must contain one nonempty entry per original paragraph, without added line breaks.');
  }
}

function applyRephrase(token, paragraphs) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(3000)) throw new Error('Another edit is running. Try again shortly.');
  try {
    var snapshot = getSnapshot_(token);
    if (!snapshot.generated) throw new Error('Generate a suggestion before applying it.');
    validateParagraphs_(paragraphs, snapshot.blocks.length);
    var body = checkedBody_(snapshot);
    var replacements = snapshot.blocks.map(function(block, i) {
      var para = atPath_(body, block.path);
      if (type_(para) !== block.kind || para.getText() !== block.full) throw new Error('The selected passage changed. Capture it again.');
      var lead = (block.original.match(/^\s*/) || [''])[0];
      var tail = (block.original.match(/\s*$/) || [''])[0];
      var texts = block.pieces.map(function(pc) {
        var el = para.getChild(pc.child);
        if (type_(el) !== 'TEXT') throw new Error('The selected passage changed. Capture it again.');
        return el.asText();
      });
      return {block: block, texts: texts, replacement: lead + paragraphs[i].trim() + tail,
        attrs: texts[0].getAttributes(block.pieces[0].start)};
    });
    // Consume the token before mutations: a retry after a partial service failure cannot apply twice.
    CacheService.getUserCache().remove(cacheKey_(token));
    for (var i = replacements.length - 1; i >= 0; i--) {
      var r = replacements[i], ps = r.block.pieces;
      // Later pieces of this paragraph lose their selected text; the first piece receives the rewrite.
      for (var k = ps.length - 1; k >= 1; k--) r.texts[k].deleteText(ps[k].start, ps[k].end);
      var text = r.texts[0], start = ps[0].start, end = ps[0].end;
      // Insert before deleting so a fully selected text element never becomes detached.
      text.insertText(start, r.replacement);
      text.deleteText(start + r.replacement.length, end + r.replacement.length);
      text.setAttributes(start, start + r.replacement.length - 1, r.attrs);
    }
    return {applied: true};
  } finally { lock.releaseLock(); }
}
