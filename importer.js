/* Score import: CSV file, pasted rows, or a quick typing grid.
   Pure parsing helpers live on window.YBImport so they can be unit-tested in Node. */
(function (root) {
'use strict';

/* ---- CSV / TSV parsing (handles quotes, commas inside quotes, CRLF, tabs, semicolons) */
function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ',';
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  // keep "June 10th, 2025" / "Jun 3, 2025" together when commas separate the columns
  text = text.replace(/\b([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?),\s*(\d{4})\b/g, '$1 $2');
  const d = detectDelimiter(text), rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
}

/* ---- dates: 2025-06-14, 6/14/2025, 6/14/25, 14/6/2025, Jun 14 2025, 14 June 2025, June 14th, 2025 */
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m, y, mo, d;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    let a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += y > 70 ? 1900 : 2000;
    if (a > 12 && b <= 12) { d = a; mo = b - 1; } else { mo = a - 1; d = b; }   // US month/day unless impossible
  }
  else if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})/))) { mo = MON[m[1].slice(0, 4).toLowerCase()] ?? MON[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})/))) { d = +m[1]; mo = MON[m[2].slice(0, 4).toLowerCase()] ?? MON[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; }
  else { const t = Date.parse(s); if (!isNaN(t)) { const x = new Date(t); y = x.getFullYear(); mo = x.getMonth(); d = x.getDate(); } }
  if (y == null || mo == null || isNaN(mo) || !d) return null;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo, d, 12));
  if (dt.getUTCMonth() !== mo || y < 1950 || dt.getTime() > Date.now() + 864e5) return null;
  return dt.toISOString();
}

/* ---- header detection */
const FIELDS = {
  date: /^(date|played|date played|round date|day)$|date/i,
  course: /^(course|course name|club|venue|golf course|facility)$|course/i,
  tee: /^(tee|tees|tee box|tee name|tee set)$|tee/i,
  holes: /^(holes|holes played|# holes|no\.? holes|round type)$/i,
  score: /^(score|gross|gross score|total|strokes|total score|tot|adjusted gross score|ags|adj\.? score|adjusted score)$|score/i,
  rating: /^(rating|course rating|cr|crating)$|rating(?!.*slope)/i,
  slope: /^(slope|slope rating|sr)$|slope/i,
  par: /^(par|course par)$/i,
  diff: /^(diff|differential|score differential|sd|hcp diff|handicap differential)$|differential/i
};
function guessMapping(header) {
  const map = {}, used = new Set();
  const order = ['diff', 'slope', 'rating', 'date', 'course', 'tee', 'holes', 'par', 'score'];
  for (const f of order) {
    let idx = header.findIndex((h, i) => !used.has(i) && FIELDS[f].test(h.trim()) && !(f === 'score' && /diff/i.test(h)) && !(f === 'course' && /rating/i.test(h)));
    if (idx >= 0) { map[f] = idx; used.add(idx); }
  }
  return map;
}
function looksLikeHeader(row) {
  // a header row has words but no dates and no plain numbers
  return row.some(c => /[a-z]{3,}/i.test(c)) && !row.some(c => parseDate(c)) && !row.some(c => /^[-+]?\d+(\.\d+)?$/.test(c));
}

/* infer mapping for header-less data (pasted "date, course, score" style) */
function inferMapping(rows) {
  const n = Math.max(...rows.slice(0, 20).map(r => r.length)), map = {};
  const colScore = i => rows.slice(0, 20).map(r => r[i] ?? '');
  for (let i = 0; i < n; i++) {
    const v = colScore(i);
    const dates = v.filter(x => parseDate(x)).length, nums = v.filter(x => /^-?\d+(\.\d+)?$/.test(x)), txt = v.filter(x => /[a-z]/i.test(x) && !parseDate(x)).length;
    if (map.date == null && dates >= v.length * .6) { map.date = i; continue; }
    if (nums.length >= v.length * .6) {
      const vals = nums.map(Number), dec = nums.some(x => x.includes('.')), mx = Math.max(...vals), mn = Math.min(...vals);
      if (dec && mn >= 55 && mx <= 80 && map.rating == null) map.rating = i;
      else if (!dec && mn >= 55 && mx <= 155 && map.score != null && map.slope == null) map.slope = i;
      else if (!dec && mn >= 25 && mx <= 160 && map.score == null) map.score = i;
      else if (dec && mx < 55 && map.diff == null) map.diff = i;
      else if (!dec && (mx === 9 || mx === 18) && map.holes == null) map.holes = i;
      continue;
    }
    if (txt >= v.length * .6) { if (map.course == null) map.course = i; else if (map.tee == null) map.tee = i; }
  }
  return map;
}

/* turn rows + mapping into normalized score objects */
function normalize(rows, map) {
  const out = [];
  rows.forEach((r, k) => {
    const g = f => map[f] != null ? (r[map[f]] ?? '').trim() : '';
    const num = s => { const x = parseFloat(String(s).replace(/[^\d.+-]/g, '').replace(/^\+/, '-')); return isNaN(x) ? null : x; };
    const item = { line: k + 1, date: parseDate(g('date')), course: g('course') || null, tee: g('tee') || null,
      score: num(g('score')), rating: num(g('rating')), slope: num(g('slope')), par: num(g('par')), diff: null, holes: null, errors: [] };
    // GHIN shows plus-handicap differentials with a leading '+': stored as negative
    const dRaw = g('diff'); if (dRaw !== '') { const x = parseFloat(dRaw.replace('+', '-')); item.diff = isNaN(x) ? null : x; }
    const hRaw = g('holes'); if (hRaw) item.holes = /9/.test(hRaw) && !/18/.test(hRaw) ? 9 : 18;
    if (item.holes == null) item.holes = item.score != null && item.score < 56 ? 9 : 18;
    if (item.score != null) item.score = Math.round(item.score);
    if (item.slope != null) item.slope = Math.round(item.slope);
    if (!item.date) item.errors.push('date not recognized');
    if (item.diff == null && item.score == null) item.errors.push('no score');
    if (item.score != null && (item.score < 25 || item.score > 200)) item.errors.push('score looks wrong');
    if (item.slope != null && (item.slope < 55 || item.slope > 155)) item.errors.push('slope out of range');
    out.push(item);
  });
  return out;
}
const courseKey = (c, t) => ((c || '').toLowerCase().replace(/\s+/g, ' ').trim()) + '|' + ((t || '').toLowerCase().trim());

const api = { parseCSV, parseDate, guessMapping, inferMapping, looksLikeHeader, normalize, courseKey, FIELDS };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.YBImport = api;
})(typeof window !== 'undefined' ? window : this);
