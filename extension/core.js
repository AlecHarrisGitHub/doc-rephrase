'use strict';
// Pure helpers shared by the background worker and the tests (no Chrome APIs here).
const DR_CORE = (() => {
  const MAX_CONTEXT = 200000, MAX_SELECTION = 10000;

  // Docs' copied text and exported HTML differ in line endings and special spaces.
  function norm(text) {
    return String(text || '').replace(/\r\n?|\u000b|\u2028|\u2029/g, '\n').replace(/[\u00a0\u202f]/g, ' ');
  }
  function sameText(a, b) {
    const clean = s => norm(s).replace(/[ \t]+\n/g, '\n').trim();
    return clean(a) === clean(b);
  }

  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  }
  // Plain text from Docs' "mobilebasic" HTML. Only used as context for the model, so approximate is fine.
  function htmlToText(html) {
    let s = String(html || '');
    const start = s.search(/<div[^>]+class="[^"]*doc-content/);
    if (start >= 0) s = s.slice(start);
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h[1-6]|tr|div|table)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, '');
    return norm(decodeEntities(s)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // One passage per non-empty line of the selection; blank lines are kept as they are.
  function buildRequest({selection, docText, title, tone, effort, guidance}) {
    const original = norm(selection);
    if (!original.trim()) throw new Error('Highlight some text in the document first.');
    if (original.length > MAX_SELECTION) throw new Error('Select a shorter passage (up to 10,000 characters).');
    const doc = norm(docText);
    const at = doc.indexOf(original);
    let before = '', after = '';
    if (at >= 0) {
      before = doc.slice(doc.lastIndexOf('\n', at - 1) + 1, at);
      const end = doc.indexOf('\n', at + original.length);
      after = doc.slice(at + original.length, end < 0 ? doc.length : end);
    }
    let context = doc || original;
    if (context.length > MAX_CONTEXT) {
      // Keep the part of a very long document around the selection.
      const center = at >= 0 ? at : 0;
      const from = Math.max(0, Math.min(center - MAX_CONTEXT / 2, context.length - MAX_CONTEXT));
      context = context.slice(from, from + MAX_CONTEXT);
    }
    const lines = original.split('\n');
    const filled = lines.map((line, i) => ({line, i})).filter(x => x.line.trim());
    const passages = filled.map((x, k) => ({selected_text: x.line,
      before: k === 0 ? before : '', after: k === filled.length - 1 ? after : ''}));
    return {original, contextCharacters: context.length, request: {type: 'rewrite', context, selected_tab: title || '',
      tone, effort, guidance: String(guidance || '').trim(), passages}};
  }

  // Put rewritten paragraphs back in place of the non-empty lines, keeping each line's edge whitespace.
  function assemble(original, paragraphs) {
    let k = 0;
    const out = norm(original).split('\n').map(line => {
      if (!line.trim()) return line;
      const lead = line.match(/^\s*/)[0], tail = line.match(/\s*$/)[0];
      return lead + String(paragraphs[k++] || '').trim() + tail;
    });
    if (k !== paragraphs.length) throw new Error('The rewrite does not match the selected paragraphs. Try again.');
    return out.join('\n');
  }

  return {norm, sameText, htmlToText, buildRequest, assemble, MAX_CONTEXT, MAX_SELECTION};
})();
if (typeof module !== 'undefined') module.exports = DR_CORE;
