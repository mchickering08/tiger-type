/**
 * Tiger Type for Google Docs.
 *
 * Extensions can't draw on Docs (it's a canvas), but add-ons are allowed to edit the doc.
 * So while the sidebar is open, this:
 *   - re-reads the doc every few seconds and rechecks it after you pause typing
 *   - highlights mistakes in the doc with Tiger Type's own colors
 *   - replaces a mistake when you click a suggestion
 *
 * The actual checking goes through the Tiger Type Chrome extension (which talks to your
 * Tiger Type server). If the script property TIGERTYPE_SERVER is set to a public https
 * address, it can also check without the extension.
 *
 * Highlights are real formatting, so Tiger Type only ever removes its own exact colors and
 * never highlights text that already has a highlight you added.
 */

// Tiger Type's highlight colors. Unusual on purpose so we never mistake a user's highlight for ours.
const TT_COLORS = { spelling: '#ffd9c2', grammar: '#d6e4ff', style: '#e6e4e0' };
const TT_OURS = { '#ffd9c2': true, '#d6e4ff': true, '#e6e4e0': true };

function onOpen() {
  DocumentApp.getUi()
    .createAddonMenu()
    .addItem('Open Tiger Type', 'showSidebar')
    .addItem('Remove Tiger Type highlights', 'clearHighlights')
    .addToUi();
}

function onInstall() {
  onOpen();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Tiger Type');
  DocumentApp.getUi().showSidebar(html);
}

function bodyText_() {
  return DocumentApp.getActiveDocument().getBody().editAsText();
}

/** Same hash as the sidebar, to tell whether the doc changed between reading and highlighting. */
function hash_(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h + ':' + s.length;
}

// ---------- called from the sidebar ----------

function getInit() {
  const props = PropertiesService.getUserProperties();
  return {
    text: bodyText_().getText(),
    highlightOn: props.getProperty('highlightOn') !== 'false',
    hasServer: Boolean(PropertiesService.getScriptProperties().getProperty('TIGERTYPE_SERVER')),
  };
}

function getText() {
  return bodyText_().getText();
}

function setHighlightPref(on) {
  PropertiesService.getUserProperties().setProperty('highlightOn', on ? 'true' : 'false');
  if (!on) clearHighlights();
}

/** Remove only Tiger Type's highlight colors. */
function clearOurs_(t) {
  const len = t.getText().length;
  if (!len) return;
  const idx = t.getTextAttributeIndices();
  for (let i = 0; i < idx.length; i++) {
    const start = idx[i];
    const end = (i + 1 < idx.length ? idx[i + 1] : len) - 1;
    if (end < start) continue;
    const bg = t.getBackgroundColor(start);
    if (bg && TT_OURS[bg.toLowerCase()]) t.setBackgroundColor(start, end, null);
  }
}

function clearHighlights() {
  clearOurs_(bodyText_());
}

/** Highlight the given issues. Skips if the doc changed since it was checked. */
function syncHighlights(issues, textHash, on) {
  const t = bodyText_();
  const text = t.getText();
  if (hash_(text) !== textHash) return { ok: false, changed: true };
  clearOurs_(t);
  if (!on) return { ok: true };
  for (const m of issues) {
    const end = m.offset + m.length - 1;
    if (m.length < 1 || end >= text.length) continue;
    if (text.substr(m.offset, m.length) !== m.text) continue;
    // Don't paint over a highlight the student added themselves.
    const existing = t.getBackgroundColor(m.offset);
    if (existing && !TT_OURS[existing.toLowerCase()]) continue;
    t.setBackgroundColor(m.offset, end, TT_COLORS[m.kind] || TT_COLORS.grammar);
  }
  return { ok: true };
}

/** Find where `expected` is now: at `offset` if the doc didn't change, else the nearest copy. */
function locate_(text, offset, expected) {
  if (text.substr(offset, expected.length) === expected) return offset;
  let best = -1;
  let i = text.indexOf(expected, Math.max(0, offset - 300));
  while (i !== -1 && i <= offset + 300) {
    if (best === -1 || Math.abs(i - offset) < Math.abs(best - offset)) best = i;
    i = text.indexOf(expected, i + 1);
  }
  return best;
}

/** Replace one mistake with the chosen suggestion. */
function replaceAt(offset, expected, replacement) {
  const t = bodyText_();
  const at = locate_(t.getText(), offset, expected);
  if (at === -1) return { ok: false, reason: 'moved' };
  t.deleteText(at, at + expected.length - 1);
  if (replacement) {
    t.insertText(at, replacement);
    // New text can inherit our highlight from the word it replaced. Clear just that.
    const bg = t.getBackgroundColor(at);
    if (bg && TT_OURS[bg.toLowerCase()]) t.setBackgroundColor(at, at + replacement.length - 1, null);
  }
  return { ok: true };
}

/** Select a mistake in the doc so the student can see where it is. */
function selectAt(offset, expected) {
  const doc = DocumentApp.getActiveDocument();
  const text = bodyText_().getText();
  const at = locate_(text, offset, expected);
  if (at === -1) return false;
  // Docs selections need a real Text element, so find the nth copy of the word with findText.
  let n = 0;
  let i = text.indexOf(expected);
  while (i !== -1 && i < at) {
    n++;
    i = text.indexOf(expected, i + 1);
  }
  const pattern = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let found = null;
  for (let k = 0; k <= n; k++) {
    found = doc.getBody().findText(pattern, found);
    if (!found) return false;
  }
  const range = doc.newRange()
    .addElement(found.getElement().asText(), found.getStartOffset(), found.getEndOffsetInclusive())
    .build();
  doc.setSelection(range);
  return true;
}

/** Fallback when the extension isn't there: check via a public Tiger Type server. */
function checkViaServer(text) {
  const url = PropertiesService.getScriptProperties().getProperty('TIGERTYPE_SERVER');
  if (!url) throw new Error('no-server');
  const res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/check', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Server error ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}
