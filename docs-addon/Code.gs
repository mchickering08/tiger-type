/**
 * Tiger Type for Google Docs.
 *
 * Docs draws text on a canvas, so the Chrome extension can't underline inside it.
 * This add-on opens a sidebar instead: it reads the document, sends the text to the
 * Tiger Type server, lists the issues, and lets you jump to or fix each one.
 *
 * Setup: Project Settings > Script properties > add TIGERTYPE_SERVER = https://your-server
 * (Google's servers make the request, so it has to be a public https address.)
 */

function onOpen() {
  DocumentApp.getUi()
    .createAddonMenu()
    .addItem('Check my writing', 'showSidebar')
    .addToUi();
}

function onInstall() {
  onOpen();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Tiger Type');
  DocumentApp.getUi().showSidebar(html);
}

function serverUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('TIGERTYPE_SERVER');
  if (!url) throw new Error('TIGERTYPE_SERVER script property is not set.');
  return url.replace(/\/+$/, '');
}

/** Called from the sidebar. Returns { enabled, matches: [...] }. */
function checkDocument() {
  const text = DocumentApp.getActiveDocument().getBody().getText();
  if (text.length > 20000) {
    return { enabled: true, tooLong: true, matches: [] };
  }
  const res = UrlFetchApp.fetch(serverUrl_() + '/check', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Tiger Type server error (' + res.getResponseCode() + ')');
  }
  const data = JSON.parse(res.getContentText());
  // Docs can't jump to a character offset, so remember which occurrence of the
  // flagged text this is (1st "teh", 2nd "teh", ...) and find it by search later.
  data.matches.forEach(function (m) {
    m.occurrence = countOccurrences_(text.slice(0, m.offset), m.text);
    m.context = contextAround_(text, m.offset, m.length);
  });
  return data;
}

function countOccurrences_(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function contextAround_(text, offset, length) {
  const start = Math.max(0, offset - 30);
  const end = Math.min(text.length, offset + length + 30);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, offset).replace(/\n/g, ' '),
    hit: text.slice(offset, offset + length),
    after: text.slice(offset + length, end).replace(/\n/g, ' ') + (end < text.length ? '…' : ''),
  };
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNth_(needle, occurrence) {
  const body = DocumentApp.getActiveDocument().getBody();
  let found = null;
  for (let i = 0; i <= occurrence; i++) {
    found = body.findText(escapeRegex_(needle), found);
    if (!found) return null;
  }
  return found;
}

/** Highlight an issue in the document so the student can see it. */
function selectMatch(needle, occurrence) {
  const found = findNth_(needle, occurrence);
  if (!found) return false;
  const doc = DocumentApp.getActiveDocument();
  const range = doc.newRange()
    .addElement(found.getElement().asText(), found.getStartOffset(), found.getEndOffsetInclusive())
    .build();
  doc.setSelection(range);
  return true;
}

/** Replace one flagged spot with the chosen suggestion. */
function applyFix(needle, occurrence, replacement) {
  const found = findNth_(needle, occurrence);
  if (!found) return false;
  const el = found.getElement().asText();
  const start = found.getStartOffset();
  el.deleteText(start, found.getEndOffsetInclusive());
  if (replacement) el.insertText(start, replacement);
  return true;
}
