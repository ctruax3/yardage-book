/* World Handicap System (2024 Rules of Handicapping) — unofficial calculator.
   Pure functions, no DOM. Works in the browser (window.WHS) and in Node (module.exports).

   Implemented:
   - Course Handicap = Index × Slope/113 + (Course Rating − Par), rounded (Rule 6.1)
   - Stroke allocation by stroke index, including plus handicaps (Rule 6.2/Appendix E)
   - Adjusted Gross Score: each hole capped at net double bogey; par + 5 before an
     Index is established (Rule 3.1)
   - Score Differential = 113/Slope × (AGS − Course Rating − PCC), rounded to 0.1 (Rule 5.1)
   - 9-hole and 10–17-hole scores converted to 18-hole differentials with an expected
     score for the holes not played (2024 revision, Rule 5.1b / 3.2)
   - Handicap Index from the most recent 20 differentials, with the fewer-than-20 table
     (Rule 5.2), exceptional score reduction (Rule 5.9), soft and hard caps (Rule 5.8),
     maximum 54.0
   Not available outside an authorized association: Playing Conditions Calculation (PCC
   is taken as 0) and the exact, proprietary expected-score formula (approximated below).
*/
(function (root) {
'use strict';
const r1 = x => Math.round(x * 10) / 10;

/* Expected 9-hole Score Differential for a given Index. The real formula is proprietary;
   0.52 × Index + 1.2 reproduces the USGA/MGA published example (Index 14.0 → 8.5). */
function expected9(index) { return 0.52 * Math.max(index, -10) + 1.2; }

/* Rule 6.1 */
function courseHandicap(index, slope, rating, par) {
  if (index == null || slope == null || rating == null) return null;
  return Math.round(index * slope / 113 + (rating - par));
}

/* Strokes received on a hole given stroke index (1..18). Plus handicaps give strokes back,
   starting from stroke index 18. */
function strokesOnHole(ch, si, holes = 18) {
  if (ch == null) return 0;
  if (ch >= 0) return Math.floor(ch / holes) + (si <= ch % holes ? 1 : 0);
  const plus = -ch;
  return -(Math.floor(plus / holes) + (si > holes - (plus % holes) ? 1 : 0));
}

/* Rule 3.1: hole maximum for handicap purposes */
function holeMax(par, si, ch, established) {
  if (!established) return par + 5;
  return par + 2 + strokesOnHole(ch, si);
}

/* table for fewer than 20 differentials (Rule 5.2a) */
const FEW = { 3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0], 11: [3, 0],
  12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0] };

function rawIndex(diffs) {
  const n = Math.min(diffs.length, 20);
  if (n < 3) return null;
  const [k, adj] = FEW[n];
  const best = diffs.slice(-20).slice().sort((a, b) => a - b).slice(0, k);
  const avg = best.reduce((s, x) => s + x, 0) / k;
  return Math.min(54, r1(avg + adj));
}

/*
  scores: array of {id, date (ISO), kind: '18'|'9'|'partial'|'diff', ...}
    For kind 'diff': {differential} (already an 18-hole Score Differential, e.g. copied from GHIN)
    For others, either
      {holes:[{par, si, score} ... played holes only], rating, slope, par, ratingPerHole?}
    or a total-only posting:
      {ags (adjusted gross), rating, slope, nHoles (9 or 18)}
  Returns {records:[...per score, chronological], index, low, established, history:[{date,index}]}
*/
function compute(scores, opts = {}) {
  const list = scores.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const recs = [];         // effective 18-hole differentials, chronological
  const history = [];
  let holesPosted = 0;
  let pending9 = null;     // 9-hole score waiting for a partner before an Index exists
  let index = opts.startIndex ?? null;   // official index entered by the player (used until we can compute our own)
  const lows = [];         // {date, index} after each revision

  for (const s of list) {
    // the Index in effect before this score: our own once we have one, else the player's official one
    const curIndex = history.length ? history[history.length - 1].index : index;
    const established = curIndex != null;
    let rec = { id: s.id, date: s.date, source: s, notes: [] };

    if (s.kind === 'diff') {
      rec.diff = r1(s.differential); rec.holes = 18;
    } else {
      // adjusted gross score and per-hole details
      let ags, nPlayed, rating = s.rating, slope = s.slope;
      const ch = courseHandicap(curIndex, slope, rating, s.par ?? 72);
      if (s.holes && s.holes.length) {
        nPlayed = s.holes.length;
        ags = 0;
        for (const h of s.holes) {
          const cap = holeMax(h.par, h.si, ch, established);
          const adj = Math.min(h.score, cap);
          if (adj < h.score) rec.notes.push(`hole ${h.n}: ${h.score} counted as ${adj}`);
          ags += adj;
        }
        rec.gross = s.holes.reduce((t, h) => t + h.score, 0);
      } else { nPlayed = s.nHoles || 18; ags = s.ags; rec.gross = s.gross ?? s.ags; }
      rec.ags = ags; rec.courseHandicap = ch; rec.nPlayed = nPlayed;

      if (nPlayed < 9) { rec.status = 'not acceptable (fewer than 9 holes)'; recs.push(Object.assign(rec, { diff: null, counted: false })); continue; }
      const pcc = s.pcc || 0;
      if (nPlayed >= 18) {
        rec.diff = r1(113 / slope * (ags - rating - pcc));
        rec.holes = 18;
      } else {
        // rating for the holes played: use the 9-hole rating if given, otherwise prorate the 18-hole rating
        const ratingPlayed = s.ratingPlayed ?? rating * nPlayed / 18;
        const slopePlayed = s.slopePlayed ?? slope;
        const playedDiff = 113 / slopePlayed * (ags - ratingPlayed - pcc * nPlayed / 18);
        if (curIndex == null) {
          // before an Index exists, 9-hole scores are paired (expected score needs an Index)
          if (nPlayed === 9) {
            if (pending9) {
              rec.diff = r1(pending9.d + playedDiff); rec.holes = 18; rec.notes.push('combined with an earlier 9-hole score');
              pending9.rec.counted = false; pending9.rec.status = 'combined into a later score'; pending9 = null;
            } else { pending9 = { d: playedDiff, rec }; rec.diff = null; rec.status = 'waiting for another 9-hole score'; recs.push(rec); holesPosted += 9; continue; }
          } else { rec.diff = null; rec.status = 'needs an established Index'; recs.push(rec); continue; }
        } else {
          const exp = expected9(curIndex) * (18 - nPlayed) / 9;
          rec.diff = r1(playedDiff + exp); rec.holes = 18;
          rec.notes.push(`${18 - nPlayed} holes not played: expected score ${r1(exp)} added`);
        }
      }
      if (rec.diff != null && rec.diff < 0) rec.diff = Math.round(rec.diff * 10) / 10;   // Rule 5.1c: round minus differentials toward zero handled by r1
    }
    holesPosted += rec.holes || 0;
    rec.counted = true; rec.adj = 0;
    recs.push(rec);

    // ---- revise the Index
    const live = recs.filter(x => x.counted && x.diff != null);
    // exceptional score reduction (Rule 5.9): compares with the Index before this score
    if (curIndex != null && live.length >= 3 && recs.filter(x => x.counted).length > 1) {
      const gap = curIndex - rec.diff;
      const red = gap >= 10 ? -2 : gap >= 7 ? -1 : 0;
      if (red) {
        live.slice(-20).forEach(x => { x.adj = (x.adj || 0) + red; });
        rec.notes.push(`exceptional score: ${red.toFixed(1)} applied to the last 20 differentials`);
        rec.esr = red;
      }
    }
    const eff = live.slice(-20).map(x => x.diff + (x.adj || 0));
    let idx = rawIndex(eff);
    if (idx != null && live.length >= 20) {
      // caps (Rule 5.8): Low Index = lowest Index in the 365 days before this score
      const since = new Date(new Date(s.date).getTime() - 365 * 864e5).toISOString();
      const prior = history.filter(h => h.date >= since && h.date <= s.date);
      if (prior.length) {
        const low = Math.min(...prior.map(h => h.index));
        if (idx - low > 3) {
          let capped = low + 3 + (idx - low - 3) / 2;
          capped = Math.min(capped, low + 5);
          if (r1(capped) < idx) rec.notes.push(`cap applied (Low Index ${low.toFixed(1)})`);
          idx = r1(capped);
        }
      }
    }
    // mark which differentials count right now
    if (idx != null) {
      const window = live.slice(-20);
      const k = FEW[Math.min(window.length, 20)][0];
      const sorted = window.slice().sort((a, b) => (a.diff + (a.adj || 0)) - (b.diff + (b.adj || 0)));
      window.forEach(x => { x.inBest = false; });
      sorted.slice(0, k).forEach(x => { x.inBest = true; });
      recs.forEach(x => { if (!window.includes(x)) x.inBest = false; });
      history.push({ date: s.date, index: idx });
    }
  }
  const last = history.length ? history[history.length - 1] : null;
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
  const recent = history.filter(h => h.date >= yearAgo);
  return {
    records: recs,
    index: last ? last.index : null,
    established: recs.filter(x => x.counted && x.diff != null).length >= 3,
    counting: recs.filter(x => x.counted && x.diff != null).length,
    low: recent.length ? Math.min(...recent.map(h => h.index)) : null,
    history
  };
}

const api = { compute, courseHandicap, strokesOnHole, holeMax, rawIndex, expected9, r1 };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WHS = api;
})(typeof window !== 'undefined' ? window : this);
