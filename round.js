/* Yardage Book: rounds, GPS distances, one-tap shot tracking, scorecard, accounts.
   Local-first: everything saves on the device immediately; when signed in, changes
   are queued and synced to Supabase (and pulled back on other devices). */
(function () {
'use strict';
const YD = 1.0936133;
const COURSE_ID = 'crown';
const DEFAULT_BAG = ['Driver', '3W', '5W', 'Hybrid', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW'];
const LS_DATA = 'yb-data-v1', LS_OUTBOX = 'yb-outbox-v1', LS_BAG = 'yb-bag-v1', LS_MERGED = 'yb-merged-user';
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const nowIso = () => new Date().toISOString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ data */
let data = store.get(LS_DATA, { rounds: [], scores: [], shots: [] });
let outbox = store.get(LS_OUTBOX, []);
let bag = store.get(LS_BAG, DEFAULT_BAG.slice());
const save = () => store.set(LS_DATA, data);

function queue(table, op, row) {
  outbox.push({ table, op, row });
  store.set(LS_OUTBOX, outbox);
  sync.flushSoon();
}
const activeRound = () => data.rounds.find(r => r.status === 'active' && r.course === COURSE_ID) || null;
const roundShots = (rid, hole) => data.shots.filter(s => s.round_id === rid && (hole == null || s.hole === hole)).sort((a, b) => a.seq - b.seq);
const holeScore = (rid, hole) => data.scores.find(s => s.round_id === rid && s.hole === hole) || null;

function upsertRound(r) { r.updated_at = nowIso(); const i = data.rounds.findIndex(x => x.id === r.id); if (i < 0) data.rounds.push(r); else data.rounds[i] = r; save(); queue('rounds', 'upsert', r); }
function upsertScore(s) {
  s.updated_at = nowIso();
  const i = data.scores.findIndex(x => x.round_id === s.round_id && x.hole === s.hole);
  if (i < 0) data.scores.push(s); else data.scores[i] = s;
  save(); queue('hole_scores', 'upsert', s);
}
function addShot(s) { s.updated_at = nowIso(); data.shots.push(s); save(); queue('shots', 'upsert', s); }
function updateShot(s) { s.updated_at = nowIso(); save(); queue('shots', 'upsert', s); }
function removeShot(s) { data.shots = data.shots.filter(x => x.id !== s.id); save(); queue('shots', 'delete', { id: s.id }); }
function deleteRound(r) {
  data.rounds = data.rounds.filter(x => x.id !== r.id);
  data.scores = data.scores.filter(x => x.round_id !== r.id);
  data.shots = data.shots.filter(x => x.round_id !== r.id);
  save(); queue('rounds', 'delete', { id: r.id });
}

/* ------------------------------------------------------------------ geo */
function geoFns() {
  const [LAT0, LON0] = YB.course.origin || [44.7255, -85.6875];
  const R = 6378137, KX = R * Math.cos(LAT0 * Math.PI / 180) * Math.PI / 180, KY = R * Math.PI / 180;
  return {
    toEN: (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY],
    toLL: (e, n) => [LAT0 + n / KY, LON0 + e / KX]
  };
}
let G = null;
const distYd = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * YD);
function greenFCB(h, from) {
  // front/back = nearest/farthest green edge along the line from the player to the green centre
  const c = h.green.c, d = [c[0] - from[0], c[1] - from[1]], L = Math.hypot(d[0], d[1]) || 1, u = [d[0] / L, d[1] / L];
  let lo = Infinity, hi = -Infinity;
  for (const p of h.green.poly) {
    const s = (p[0] - from[0]) * u[0] + (p[1] - from[1]) * u[1];
    const off = Math.abs(-(p[0] - from[0]) * u[1] + (p[1] - from[1]) * u[0]);
    if (off < 6) { lo = Math.min(lo, s); hi = Math.max(hi, s); }
  }
  if (!isFinite(lo)) { lo = L - h.green.depth / 2 / YD; hi = L + h.green.depth / 2 / YD; }
  return { f: Math.round(lo * YD), c: Math.round(L * YD), b: Math.round(hi * YD) };
}

/* ------------------------------------------------------------------ GPS */
const gps = { fix: null, watch: null, err: null };
function startGPS() {
  if (gps.watch != null || !navigator.geolocation) return;
  gps.watch = navigator.geolocation.watchPosition(p => {
    gps.err = null;
    gps.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
    renderBar();
  }, e => { gps.err = e.code === 1 ? 'denied' : 'unavailable'; renderBar(); },
  { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
}
function stopGPS() { if (gps.watch != null) navigator.geolocation.clearWatch(gps.watch); gps.watch = null; }
function fixEN() {
  if (!gps.fix || Date.now() - gps.fix.t > 60000) return null;
  const en = G.toEN(gps.fix.lat, gps.fix.lon);
  // only trust it on/near the property
  if (Math.abs(en[0]) > 1200 || Math.abs(en[1]) > 1200) return null;
  return en;
}
const awayFromCourse = () => gps.fix && !fixEN();

/* ------------------------------------------------------------------ weather (Open-Meteo, free, no key) */
async function fetchWeather() {
  try {
    const [lat, lon] = G.toLL(0, 0);
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&temperature_unit=fahrenheit&wind_speed_unit=mph`);
    const j = await r.json();
    const c = j.current;
    return { temp_f: c.temperature_2m, wind_mph: c.wind_speed_10m, wind_dir: c.wind_direction_10m, gust_mph: c.wind_gusts_10m, precip_in: c.precipitation, at: c.time };
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ round flow */
async function startRound() {
  const r = { id: uuid(), course: COURSE_ID, tee: YB.tee(), started_at: nowIso(), ended_at: null, status: 'active', weather: null };
  upsertRound(r);
  startGPS();
  location.hash = 'hole-1';
  render();
  const ch = courseHcp(r.tee); if (ch != null) toast(`Course handicap ${ch < 0 ? '+' + (-ch) : ch} from the ${r.tee} tees`);
  const w = await fetchWeather();
  if (w) { r.weather = w; upsertRound(r); renderBar(); }
}
function endRound() {
  const r = activeRound(); if (!r) return;
  r.status = 'done'; r.ended_at = nowIso(); upsertRound(r);
  stopGPS(); location.hash = 'card'; render();
}
function lastPlayedHole(r) {
  const holes = new Set(roundShots(r.id).map(s => s.hole).concat(data.scores.filter(s => s.round_id === r.id && s.score != null).map(s => s.hole)));
  return holes.size ? Math.max(...holes) : 0;
}

let pending = null;   // {club} waiting for a tap on the map
function recordShot(club, en, src) {
  const r = activeRound(); if (!r) return;
  const hole = YB.cur();
  const shots = roundShots(r.id, hole);
  const [lat, lon] = G.toLL(en[0], en[1]);
  addShot({ id: uuid(), round_id: r.id, hole, seq: (shots.length ? shots[shots.length - 1].seq : 0) + 1, kind: 'shot', club,
    lat, lon, accuracy: src === 'gps' && gps.fix ? Math.round(gps.fix.acc) : null, source: src, taken_at: nowIso(), weather: null });
  if (club && bag.includes(club)) { lastClub[hole] = club; }
  toast(`${club} marked · shot ${shots.length + 1}`);
  YB.refresh();
  render();
}
const lastClub = {};
function hit(club) {
  closeSheet();
  const en = fixEN();
  if (en) recordShot(club, en, 'gps');
  else { pending = { club, kind: 'shot' }; renderBar(); toast('Tap where the ball is on the map'); }
}
function penalty() {
  const r = activeRound(); if (!r) return;
  const hole = YB.cur(), shots = roundShots(r.id, hole);
  addShot({ id: uuid(), round_id: r.id, hole, seq: (shots.length ? shots[shots.length - 1].seq : 0) + 1, kind: 'penalty', club: null,
    lat: null, lon: null, accuracy: null, source: null, taken_at: nowIso(), weather: null });
  toast('Penalty stroke added'); YB.refresh(); render();
}
function undo() {
  const r = activeRound(); if (!r) return;
  const shots = roundShots(r.id, YB.cur()); if (!shots.length) return;
  removeShot(shots[shots.length - 1]); toast('Removed last entry'); YB.refresh(); render();
}
function onGreen() {
  // records where the ball finished on the green (end of the last full shot), then asks for putts
  const r = activeRound(); if (!r) return;
  const hole = YB.cur(), h = YB.H[hole - 1];
  const en = fixEN();
  const place = (pt, src) => {
    const shots = roundShots(r.id, hole);
    const prev = shots.filter(s => s.kind === 'ongreen'); prev.forEach(removeShot);
    const [lat, lon] = G.toLL(pt[0], pt[1]);
    addShot({ id: uuid(), round_id: r.id, hole, seq: (shots.length ? shots[shots.length - 1].seq : 0) + 1, kind: 'ongreen', club: null,
      lat, lon, accuracy: src === 'gps' && gps.fix ? Math.round(gps.fix.acc) : null, source: src, taken_at: nowIso(), weather: null });
    YB.refresh(); openPutts();
  };
  if (en) place(en, 'gps');
  else { pending = { kind: 'ongreen', place }; renderBar(); toast('Tap where the ball is on the green, or skip'); openSheet(`<h3>On the green</h3><p class="rm">No GPS fix here, so tap the ball's spot on the green.</p><div class="rbtns"><button class="rb" id="ogCenter">Use green center</button><button class="rb ghost" id="ogSkip">Skip, just enter putts</button></div>`);
    $('ogCenter').onclick = () => { pending = null; place(h.green.c, 'map'); };
    $('ogSkip').onclick = () => { pending = null; openPutts(); };
  }
}
function openPutts() {
  const r = activeRound(), hole = YB.cur();
  openSheet(`<h3>Hole ${hole} · putts</h3><div class="rgrid">${[0, 1, 2, 3, 4].map(n => `<button class="rb big" data-p="${n}">${n}</button>`).join('')}</div>`);
  document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    const putts = +b.dataset.p;
    const shots = roundShots(r.id, hole);
    const strokes = shots.filter(s => s.kind === 'shot').length, pens = shots.filter(s => s.kind === 'penalty').length;
    const sc = holeScore(r.id, hole) || { round_id: r.id, hole, score: null, putts: null, fairway: null, penalties: 0 };
    sc.putts = putts; sc.penalties = pens;
    if (strokes) sc.score = strokes + pens + putts;
    upsertScore(sc);
    openScoreSheet(hole, true);
  });
}

/* ------------------------------------------------------------------ scorecard entry */
function stepper(id, label, val, min, max) {
  return `<div class="stp"><span>${label}</span><button class="rb sq" data-s="${id}" data-d="-1" aria-label="${label} minus">−</button><b id="sv-${id}">${val == null ? '–' : val}</b><button class="rb sq" data-s="${id}" data-d="1" aria-label="${label} plus">+</button></div>`;
}
function openScoreSheet(hole, fromFlow) {
  const r = activeRound() || viewRound();
  if (!r) return;
  const h = YB.H[hole - 1];
  const sc = holeScore(r.id, hole) || { round_id: r.id, hole, score: null, putts: null, fairway: null, penalties: 0 };
  const shots = roundShots(r.id, hole);
  const st = { score: sc.score ?? (shots.filter(s => s.kind !== 'ongreen').length ? shots.filter(s => s.kind !== 'ongreen').length + (sc.putts || 0) : h.par), putts: sc.putts ?? 2, penalties: sc.penalties || 0, fairway: sc.fairway };
  const fw = h.par >= 4 ? `<div class="stp"><span>Fairway</span><div class="seg3">${['left', 'hit', 'right'].map(f => `<button class="rb fw" data-fw="${f}" aria-pressed="${st.fairway === f}">${f === 'hit' ? 'Hit' : f === 'left' ? '← Left' : 'Right →'}</button>`).join('')}</div></div>` : '';
  openSheet(`<h3>Hole ${hole} · par ${h.par}</h3>
    ${stepper('score', 'Score', st.score, 1, 15)}${stepper('putts', 'Putts', st.putts, 0, 6)}${stepper('penalties', 'Penalties', st.penalties, 0, 6)}${fw}
    <p class="rm" id="relpar"></p>
    <div class="rbtns"><button class="rb" id="scSave">${fromFlow && hole < 18 ? `Save · go to ${hole + 1}` : 'Save'}</button></div>`);
  const upd = () => { const d = st.score - h.par; $('relpar').textContent = d === 0 ? 'Par' : d === -1 ? 'Birdie' : d === -2 ? 'Eagle' : d === 1 ? 'Bogey' : d === 2 ? 'Double bogey' : (d > 0 ? '+' + d : d); };
  upd();
  document.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
    const k = b.dataset.s, lim = { score: [1, 15], putts: [0, 6], penalties: [0, 6] }[k];
    st[k] = Math.max(lim[0], Math.min(lim[1], (st[k] ?? 0) + +b.dataset.d)); $('sv-' + k).textContent = st[k]; upd();
  });
  document.querySelectorAll('[data-fw]').forEach(b => b.onclick = () => {
    st.fairway = st.fairway === b.dataset.fw ? null : b.dataset.fw;
    document.querySelectorAll('[data-fw]').forEach(x => x.setAttribute('aria-pressed', x.dataset.fw === st.fairway));
  });
  $('scSave').onclick = () => {
    upsertScore(Object.assign(sc, { score: st.score, putts: st.putts, penalties: st.penalties, fairway: h.par >= 4 ? st.fairway : null }));
    closeSheet();
    if (fromFlow && hole < 18 && activeRound()) location.hash = 'hole-' + (hole + 1);
    render();
  };
}

/* ------------------------------------------------------------------ UI: sheet, toast, bar */
function ensureChrome() {
  if ($('rSheet')) return;
  const css = document.createElement('style');
  css.textContent = `
  .rbar{position:absolute;left:8px;right:8px;bottom:8px;z-index:3;background:rgba(249,250,246,.97);color:var(--ink);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.22);padding:10px;display:grid;gap:8px}
  .rbar .dist{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
  .rbar .fcb{display:flex;gap:10px;align-items:baseline;flex-wrap:nowrap}
  .rbar .fcb span{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-right:3px}
  .rbar .fcb b{font:700 22px/1 var(--display)} .rbar .fcb b.c{font-size:34px;color:var(--flag)}
  .rbar .meta{font-size:12px;color:var(--muted);text-align:right;line-height:1.3;white-space:nowrap}
  .rbar .acts{display:grid;grid-template-columns:1.4fr 1.3fr 1.2fr 1fr 1.2fr;gap:5px}.rbar .acts .rb{padding:8px 4px;font-size:14px}.rbar .acts .rb.main{font-size:17px}
  .rb{border:1px solid var(--rule);background:var(--card);border-radius:10px;padding:10px 8px;font:600 15px/1 var(--display);letter-spacing:.04em;text-transform:uppercase;cursor:pointer;color:var(--ink);min-height:44px}
  .rb.main{background:var(--pine);border-color:var(--pine);color:#fff;font-size:17px}
  .rb.ghost{background:transparent}
  .rb.big{font-size:24px;min-height:60px}
  .rb.sq{width:44px;padding:0;font-size:22px}
  .rb[aria-pressed="true"]{background:var(--ink);color:var(--card);border-color:var(--ink)}
  .rb:disabled{opacity:.45}
  .rpend{background:#fff4d6;border:1px solid #e3c46a;border-radius:10px;padding:8px 10px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
  .rsheet-bg{position:fixed;inset:0;background:rgba(10,20,15,.35);z-index:40}
  .rsheet{position:fixed;left:0;right:0;bottom:0;z-index:41;background:var(--card);border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));max-height:80svh;overflow:auto;box-shadow:0 -8px 30px rgba(0,0,0,.25);max-width:560px;margin:0 auto}
  .rsheet h3{font:700 22px/1.1 var(--display);margin:0 0 12px;letter-spacing:.02em}
  .rsheet .close{position:absolute;right:10px;top:10px;border:0;background:transparent;font-size:26px;line-height:1;cursor:pointer;color:var(--muted);width:44px;height:44px}
  .rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}
  .rgrid .rb{min-height:56px;font-size:18px}
  .rgrid .rb.last{outline:2px solid var(--flag);outline-offset:1px}
  .rbtns{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.rbtns .rb{flex:1}
  .rm{color:var(--muted);font-size:14px;margin:6px 0}
  .stp{display:grid;grid-template-columns:1fr auto 52px auto;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--rule)}
  .stp>span{font-weight:600}.stp>b{font:700 28px/1 var(--display);text-align:center;font-variant-numeric:tabular-nums}
  .stp .seg3{grid-column:2/5;display:flex;gap:6px}.stp .seg3 .rb{flex:1;padding:8px 4px;font-size:14px}
  .rtoast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 14px;border-radius:10px;z-index:60;font-size:14px;box-shadow:0 6px 18px rgba(0,0,0,.3);transition:opacity .3s}
  .acct{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .acct .rb{min-height:36px;padding:8px 10px;font-size:14px}
  .acct .who{font-size:13px;color:var(--muted);max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media (max-width:560px){.acct .who{display:none}}
  .myc table{min-width:640px}.myc td.sv{font-weight:700;font-size:16px}
  .myc td.sv.b{color:#1f6fb2}.myc td.sv.e{color:#1f6fb2;text-decoration:underline}.myc td.sv.o{color:var(--flag)}
  .myc td.tap{cursor:pointer}.myc td.tap:hover{background:#eaf0e6}
  .rlist{display:grid;gap:6px;margin-top:8px}
  .rlist button{display:flex;justify-content:space-between;align-items:center;text-transform:none;letter-spacing:0;font:500 15px/1.2 var(--body)}
  .rlist button b{font:700 20px/1 var(--display)}
  .pgrid{display:grid;gap:12px}.pgrid>*{min-width:0}.pgrid .box{overflow-x:auto}#profileView{max-width:100%;overflow-x:hidden}@media (min-width:900px){.pgrid{grid-template-columns:1fr 1fr}}
  .hix{display:flex;gap:24px;align-items:flex-end;margin-bottom:6px}
  .hix .k,.sgrid .k{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .hix .v{font:700 56px/1 var(--display);color:var(--pine);font-variant-numeric:tabular-nums}.hix .v.sm{font-size:30px;color:var(--ink)}
  .sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.sgrid>div{border-top:2px solid var(--rule);padding-top:6px}
  .sgrid .v{font:700 24px/1.1 var(--display);font-variant-numeric:tabular-nums}
  table.pt{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  table.pt th,table.pt td{padding:7px 6px;border-bottom:1px solid var(--rule);text-align:left;font-size:14px}
  table.pt th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}
  table.pt td.big{font:700 20px/1 var(--display)} table.pt small{color:var(--muted)}
  table.hist{min-width:420px} table.hist tr.go,table.hist tr.ext{cursor:pointer} table.hist tr.go:hover td,table.hist tr.ext:hover td{background:#eaf0e6}
  table.hist td.df{font:700 17px/1 var(--display)} table.hist td.df.best{background:#dcefd2;color:var(--pine)}
  table.hist tr.note td{font-size:12px;color:var(--muted);padding-top:0;border-bottom:1px solid var(--rule)}
  table.hist tr:has(+ tr.note) td{border-bottom:0}
  .aform{display:grid;gap:10px}.aform label{display:grid;gap:4px;font-size:13px;font-weight:600;color:var(--muted)}
  .aform input,.aform select{font:500 17px var(--body);padding:10px;border:1px solid var(--rule);border-radius:8px;background:#fff;color:var(--ink);min-height:44px}
  .aform .mscore{display:grid;grid-template-columns:1fr 1fr;gap:10px}.aform .mscore p{grid-column:1/-1;margin:0}
  .impsrc{display:grid;gap:8px;margin:10px 0}.impsrc .rb{display:flex;align-items:center;justify-content:center;text-align:center}
  .impfile{cursor:pointer}
  table.grid{min-width:520px}table.grid td{padding:3px}table.grid input,table.grid select{width:100%;font:15px var(--body);padding:8px;border:1px solid var(--rule);border-radius:6px;min-height:40px;background:#fff}
  table.grid td:nth-child(1){width:150px}table.grid td:nth-child(4){width:70px}table.grid td:nth-child(5){width:64px}
  table.imprev tr.bad td{color:var(--flag)} table.imprev tr.dup td{color:var(--muted);text-decoration:line-through}
  .crow{display:grid;grid-template-columns:1.6fr 1fr 1fr .8fr;gap:8px;align-items:end;padding:8px 0;border-bottom:1px solid var(--rule)}
  @media (max-width:520px){.crow{grid-template-columns:1fr 1fr .8fr}.crow .cname{grid-column:1/-1}}
  .rsheet{max-width:640px}
  .pastwrap{position:absolute;left:10px;bottom:58px;z-index:3;display:flex;gap:6px;flex-wrap:wrap}.pastwrap[hidden]{display:none}
  .pastwrap .chip[aria-pressed="false"]{opacity:.6;text-decoration:line-through}
  .howto{background:#f3f7f2;border:1px solid var(--rule);border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.45}.howto summary{cursor:pointer;font-weight:700;color:var(--ink)}.howto ol{margin:0;padding-left:18px;display:grid;gap:4px}
  .trwrap{display:flex;justify-content:center;margin:8px 0;background:#0f1a15;border-radius:10px;overflow:hidden}
  .trwrap canvas{touch-action:none;cursor:crosshair;display:block}
  .trov{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--muted);margin:2px 0 6px}
  .trlist{display:grid;gap:6px;margin:8px 0}.trrow{display:grid;grid-template-columns:1fr auto 1.3fr;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--rule)}
  .trrow select{font:15px var(--body);padding:8px;border:1px solid var(--rule);border-radius:8px;min-height:40px;background:#fff}
  .trrow b{font:700 18px var(--display)}
  .cp{position:relative}.cp-in{width:100%;box-sizing:border-box}
  .cp-list{display:grid;border:1px solid var(--rule);border-radius:8px;margin-top:4px;overflow:hidden;background:#fff}
  .cp-list button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;padding:10px 12px;border:0;border-bottom:1px solid var(--rule);background:#fff;font:15px var(--body);color:var(--ink);cursor:pointer;min-height:44px}
  .cp-list button small{color:var(--muted);font-size:12px}.cp-list .cp-new{color:var(--green,#1f4d3a);font-weight:600;border-bottom:0}
  .cp-st{padding:10px 12px;color:var(--muted);font-size:14px}
  .aform .mscore.one{grid-template-columns:1fr}
  .aform .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.aform .three{display:grid;grid-template-columns:1.3fr 1fr 1fr .8fr;gap:8px}
  @media (max-width:520px){.aform .three{grid-template-columns:1fr 1fr .8fr}.aform .three label:first-child{grid-column:1/-1}}
  .aform .two label,.aform .three label{min-width:0}.aform .two select,.aform .three input{width:100%;box-sizing:border-box;min-width:0}
  .crow.auto input{background:#f3f7f2}
  .box.warn{border-color:#d9a441;background:#fff8e8;margin-bottom:14px;font-size:14px;line-height:1.45}
  .crow label{min-width:0;display:block}.crow input{width:100%;min-width:0;box-sizing:border-box}.crow input::placeholder{color:#b9bfb7}
  .myc tr.strokes td{font-size:12px;color:var(--pine);letter-spacing:-1px}
  @media (min-width:900px){.rsheet{bottom:auto;top:50%;transform:translateY(-50%);border-radius:18px}}
  `;
  document.head.appendChild(css);
  const bg = document.createElement('div'); bg.className = 'rsheet-bg'; bg.id = 'rSheetBg'; bg.hidden = true; bg.onclick = closeSheet;
  const sh = document.createElement('div'); sh.className = 'rsheet'; sh.id = 'rSheet'; sh.hidden = true; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
  document.body.append(bg, sh);
  const bar = document.createElement('div'); bar.className = 'rbar'; bar.id = 'rBar'; bar.hidden = true;
  $('stage').appendChild(bar);
  const acct = document.createElement('div'); acct.className = 'acct'; acct.id = 'rAcct';
  document.querySelector('header.top').appendChild(acct);
  const pv = document.createElement('section'); pv.id = 'profileView'; pv.hidden = true;
  $('cardView').after(pv);
  const my = document.createElement('div'); my.className = 'myc'; my.id = 'myCard';
  $('cardView').insertBefore(my, $('cardView').firstChild.nextSibling);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
}
function openSheet(html) {
  $('rSheet').innerHTML = `<button class="close" aria-label="Close" id="rClose">×</button>` + html;
  $('rSheet').hidden = false; $('rSheetBg').hidden = false; $('rClose').onclick = closeSheet;
}
function closeSheet() { if ($('rSheet')) { $('rSheet').hidden = true; $('rSheetBg').hidden = true; } }
let toastT = null;
function toast(msg) {
  let t = $('rToast'); if (!t) { t = document.createElement('div'); t.id = 'rToast'; t.className = 'rtoast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => t.style.opacity = 0, 2200);
}
function openClubs() {
  const hole = YB.cur(), last = lastClub[hole];
  openSheet(`<h3>Hole ${hole} · club for this shot</h3>
    <p class="rm">${fixEN() ? 'Marks the shot where you are standing.' : 'No GPS fix on the course, so after picking a club, tap the ball\'s spot on the map.'}</p>
    <div class="rgrid">${bag.map(c => `<button class="rb${c === last ? ' last' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="rbtns"><button class="rb ghost" id="editBag">Edit bag</button></div>`);
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => hit(b.dataset.c));
  $('editBag').onclick = openBag;
}
function openBag() {
  const all = Array.from(new Set(DEFAULT_BAG.concat(['2i', '3i', '7W', '9W', '50°', '52°', '54°', '56°', '58°', '60°']).concat(bag)));
  const sel = new Set(bag);
  openSheet(`<h3>Your bag</h3><p class="rm">Tap to add or remove clubs.</p><div class="rgrid">${all.map(c => `<button class="rb" data-bg="${esc(c)}" aria-pressed="${sel.has(c)}">${esc(c)}</button>`).join('')}</div><div class="rbtns"><button class="rb main" id="bagDone">Done</button></div>`);
  document.querySelectorAll('[data-bg]').forEach(b => b.onclick = () => { const c = b.dataset.bg; sel.has(c) ? sel.delete(c) : sel.add(c); b.setAttribute('aria-pressed', sel.has(c)); });
  $('bagDone').onclick = () => {
    bag = all.filter(c => sel.has(c)); if (!bag.length) bag = DEFAULT_BAG.slice();
    store.set(LS_BAG, bag); sync.saveProfile(); openClubs();
  };
}

function renderBar() {
  const bar = $('rBar'); if (!bar) return;
  const r = activeRound();
  const onHole = !/^#(card|profile)$/.test(location.hash);
  bar.hidden = !(r && onHole);
  const ti = $('tapinfo'); if (ti) ti.style.display = (r && onHole) ? 'none' : '';
  if (!r || !onHole) return;
  const hole = YB.cur(), h = YB.H[hole - 1];
  const shots = roundShots(r.id, hole), strokes = shots.filter(s => s.kind !== 'ongreen').length;
  const en = fixEN();
  let dist;
  if (en) {
    const d = greenFCB(h, en);
    dist = d.f <= 0 ? `<div class="fcb"><span>On the green</span><b class="c" aria-label="Center ${d.c} yards">${d.c}</b><span>to center</span></div>`
      : `<div class="fcb"><span>Front</span><b>${d.f}</b><b class="c" aria-label="Center ${d.c} yards">${d.c}</b><span>Back</span><b>${d.b}</b></div>`;
  } else {
    const why = !navigator.geolocation ? 'GPS not available in this browser' : gps.err === 'denied' ? 'Location is off for this site; allow it in your browser settings' :
      awayFromCourse() ? 'GPS works; distances appear when you\'re at The Crown' : 'Finding GPS…';
    dist = `<div class="rm" style="margin:0">${why}</div>`;
  }
  const acc = gps.fix && en ? `±${Math.round(gps.fix.acc * YD)} yd` : '';
  const w = r.weather ? `${Math.round(r.weather.wind_mph)} mph wind · ${Math.round(r.weather.temp_f)}°` : '';
  const pend = pending ? `<div class="rpend"><span>${pending.kind === 'ongreen' ? 'Tap the ball\'s spot on the green' : `Tap the ball's spot for your <b>${esc(pending.club)}</b>`}</span><button class="rb ghost" id="rCancel" style="min-height:34px;padding:6px 10px">Cancel</button></div>` : '';
  bar.innerHTML = `${pend}<div class="dist">${dist}<div class="meta">Shot ${strokes + 1}${acc ? '<br>' + acc : ''}${w ? '<br>' + w : ''}</div></div>
    <div class="acts"><button class="rb main" id="rHit">Hit</button><button class="rb" id="rGreen">On green</button><button class="rb" id="rPen">Penalty</button><button class="rb" id="rUndo" ${shots.length ? '' : 'disabled'}>Undo</button><button class="rb" id="rScore">Score${holeScore(r.id, hole) && holeScore(r.id, hole).score != null ? ' · ' + holeScore(r.id, hole).score : ''}</button></div>`;
  $('rScore').onclick = () => openScoreSheet(hole, true);
  $('rHit').onclick = openClubs; $('rGreen').onclick = onGreen; $('rPen').onclick = penalty; $('rUndo').onclick = undo;
  if (pending) $('rCancel').onclick = () => { pending = null; renderBar(); };
}

function renderAcct() {
  const el = $('rAcct'); if (!el) return;
  const r = activeRound();
  const parts = [];
  if (r) {
    const thru = lastPlayedHole(r);
    parts.push(`<button class="rb" id="rCardBtn">Scorecard</button><button class="rb ghost" id="rEnd">End round${thru ? ' · thru ' + thru : ''}</button>`);
  } else parts.push(`<button class="rb main" id="rStart" style="min-height:36px;font-size:15px">Start round</button>`);
  const hcx = handicap(), ixu = indexInUse();
  parts.push(`<button class="rb" id="rProf">Profile${ixu ? ' · ' + fmtIx(ixu.v) : ''}</button>`);
  if (sync.enabled) {
    parts.push(sync.user ? `<span class="who">${esc(sync.user.email || 'Signed in')}${outbox.length ? ' · syncing' : ''}</span><button class="rb ghost" id="rOut">Sign out</button>`
      : `<button class="rb" id="rIn">Sign in with Google</button>`);
  }
  el.innerHTML = parts.join('');
  if ($('rStart')) $('rStart').onclick = startRound;
  if ($('rEnd')) $('rEnd').onclick = () => {
    openSheet(`<h3>End this round?</h3><p class="rm">You can still edit scores afterward from the scorecard.</p><div class="rbtns"><button class="rb main" id="rEndYes">End round</button><button class="rb ghost" id="rEndNo">Keep playing</button></div>`);
    $('rEndYes').onclick = () => { closeSheet(); endRound(); }; $('rEndNo').onclick = closeSheet;
  };
  if ($('rCardBtn')) $('rCardBtn').onclick = () => location.hash = 'card';
  $('rProf').onclick = () => location.hash = 'profile';
  if ($('rIn')) $('rIn').onclick = () => sync.signIn();
  if ($('rOut')) $('rOut').onclick = () => sync.signOut();
}

/* ------------------------------------------------------------------ my scorecard view */
let viewRoundId = null;
const viewRound = () => data.rounds.find(r => r.id === viewRoundId && r.status !== 'imported') || activeRound() || data.rounds.filter(r => r.course === COURSE_ID && r.status !== 'imported').sort((a, b) => b.started_at.localeCompare(a.started_at))[0] || null;
function totals(r) {
  let s = 0, p = 0, par = 0, n = 0, putts = 0, fwH = 0, fwN = 0;
  for (let i = 1; i <= 18; i++) {
    const sc = holeScore(r.id, i), h = YB.H[i - 1];
    if (sc && sc.score != null) { s += sc.score; par += h.par; n++; if (sc.putts != null) putts += sc.putts; }
    if (sc && h.par >= 4 && sc.fairway) { fwN++; if (sc.fairway === 'hit') fwH++; }
  }
  return { s, rel: s - par, n, putts, fw: fwN ? `${fwH}/${fwN}` : '–' };
}
function renderMyCard() {
  const el = $('myCard'); if (!el) return;
  const rounds = data.rounds.filter(r => r.course === COURSE_ID && r.status !== 'imported').sort((a, b) => b.started_at.localeCompare(a.started_at));
  const r = viewRound();
  if (!r) {
    el.innerHTML = `<h2>Your scorecard</h2><p class="rm">Tap <b>Start round</b> at the top to keep score, track shots and get GPS distances.</p>`;
    return;
  }
  const H = YB.H, t = totals(r);
  const cell = (i) => {
    const sc = holeScore(r.id, i), h = H[i - 1];
    if (!sc || sc.score == null) return `<td class="sv tap" data-h="${i}">·</td>`;
    const d = sc.score - h.par, cls = d <= -2 ? 'e' : d === -1 ? 'b' : d >= 1 ? 'o' : '';
    return `<td class="sv tap ${cls}" data-h="${i}">${sc.score}</td>`;
  };
  const sub = (a, b, k) => { let v = 0, any = false; for (let i = a; i <= b; i++) { const sc = holeScore(r.id, i); if (sc && sc[k] != null) { v += sc[k]; any = true; } } return any ? v : ''; };
  const row = (lbl, f, cls = '') => `<tr class="${cls}"><td>${lbl}</td>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(f).join('')}<td><b>${'{OUT}'}</b></td>${[10, 11, 12, 13, 14, 15, 16, 17, 18].map(f).join('')}<td><b>{IN}</b></td><td><b>{TOT}</b></td></tr>`;
  const fill = (s, k) => s.replace('{OUT}', sub(1, 9, k)).replace('{IN}', sub(10, 18, k)).replace('{TOT}', (sub(1, 9, k) === '' && sub(10, 18, k) === '') ? '' : (+sub(1, 9, k) || 0) + (+sub(10, 18, k) || 0));
  const parRow = `<tr class="sub"><td>Par</td>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<td>${H[i - 1].par}</td>`).join('')}<td>36</td>${[10, 11, 12, 13, 14, 15, 16, 17, 18].map(i => `<td>${H[i - 1].par}</td>`).join('')}<td>36</td><td>72</td></tr>`;
  const head = `<tr><th>Hole</th>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<th>${i}</th>`).join('')}<th>Out</th>${[10, 11, 12, 13, 14, 15, 16, 17, 18].map(i => `<th>${i}</th>`).join('')}<th>In</th><th>Tot</th></tr>`;
  const fwCell = i => { const sc = holeScore(r.id, i), h = H[i - 1]; return `<td>${h.par < 4 ? '' : sc && sc.fairway ? (sc.fairway === 'hit' ? '✓' : sc.fairway === 'left' ? '←' : '→') : ''}</td>`; };
  const date = new Date(r.started_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const ch = courseHcp(r.tee);
  const dots = i => { if (ch == null) return '<td></td>'; const k = WHS.strokesOnHole(ch, H[i - 1].hcp); return `<td>${k > 0 ? '•'.repeat(k) : k < 0 ? '+' : ''}</td>`; };
  let netTxt = '';
  if (ch != null && t.n) { let rec = 0; for (let i = 1; i <= 18; i++) { const sc = holeScore(r.id, i); if (sc && sc.score != null) rec += WHS.strokesOnHole(ch, H[i - 1].hcp); } const net = t.s - rec; netTxt = ` · net ${net}`; }
  const others = rounds.filter(x => x.id !== r.id).slice(0, 12);
  el.innerHTML = `<h2>${r.status === 'active' ? 'Current round' : 'Round'} · ${date} · ${esc(r.tee || '')}</h2>
    <p class="rm">${t.n ? `<b style="font:700 22px var(--display);color:var(--ink)">${t.s}</b> through ${t.n} · ${t.rel === 0 ? 'even' : (t.rel > 0 ? '+' : '') + t.rel}${netTxt} · ${t.putts} putts · fairways ${t.fw}` : 'Tap any hole to enter a score.'}${ch != null ? `<br>Course handicap ${ch < 0 ? '+' + (-ch) : ch} from the ${esc(r.tee || '')} tees · dots show where you get strokes` : ''}</p>
    <div class="cardview"><table class="sc">${head}${parRow}${ch != null ? row('Strokes', dots).replace('{OUT}', '').replace('{IN}', '').replace('{TOT}', ch).replace('<tr class="">', '<tr class="strokes">') : ''}${fill(row('Score', cell), 'score')}${fill(row('Putts', i => { const sc = holeScore(r.id, i); return `<td>${sc && sc.putts != null ? sc.putts : ''}</td>`; }), 'putts')}${row('Fairway', fwCell).replace('{OUT}', '').replace('{IN}', '').replace('{TOT}', '')}</table></div>
    ${r.status === 'done' ? `<div class="rbtns"><button class="rb ghost" id="rDel">Delete this round</button></div>` : ''}
    ${others.length ? `<h2 style="margin-top:16px">Past rounds</h2><div class="rlist">${others.map(o => { const tt = totals(o); return `<button class="rb" data-r="${o.id}"><span>${new Date(o.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${esc(o.tee || '')}${o.status === 'active' ? ' · in progress' : ''}</span><b>${tt.n ? tt.s : '–'}</b></button>`; }).join('')}</div>` : ''}
    <hr style="border:0;border-top:1px solid var(--rule);margin:16px 0">`;
  el.querySelectorAll('td[data-h]').forEach(td => td.onclick = () => openScoreSheet(+td.dataset.h, false));
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { viewRoundId = b.dataset.r; renderMyCard(); window.scrollTo({ top: 0 }); });
  if ($('rDel')) $('rDel').onclick = () => {
    openSheet(`<h3>Delete this round?</h3><p class="rm">This removes its scores and shots${sync.user ? ' from your account too' : ''}. It can't be undone.</p><div class="rbtns"><button class="rb" id="rDelYes" style="background:var(--flag);color:#fff;border-color:var(--flag)">Delete round</button><button class="rb ghost" id="rDelNo">Cancel</button></div>`);
    $('rDelYes').onclick = () => { deleteRound(r); viewRoundId = null; closeSheet(); render(); }; $('rDelNo').onclick = closeSheet;
  };
}

/* ------------------------------------------------------------------ map overlays for this round's shots */
function shotRoundId() { const a = activeRound(); if (a) return a.id; const v = viewRoundId && data.rounds.find(x => x.id === viewRoundId && !isImported(x)); return v ? v.id : null; }
function shotPathsForHole(hole) {
  const rid = shotRoundId(); const r = rid && data.rounds.find(x => x.id === rid); if (!r) return [];
  const pts = roundShots(r.id, hole).filter(s => s.lat != null).map(s => ({ en: G.toEN(s.lat, s.lon), s }));
  return pts;
}
function draw2dOverlay(ctx, toScr, dpr) {
  const pts = shotPathsForHole(YB.cur()); if (!pts.length) return;
  const h = YB.H[YB.cur() - 1];
  ctx.save(); ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#ffd23f'; ctx.setLineDash([]);
  ctx.beginPath();
  pts.forEach((p, i) => { const xy = toScr(p.en); i ? ctx.lineTo(xy[0], xy[1]) : ctx.moveTo(xy[0], xy[1]); });
  ctx.stroke();
  pts.forEach((p, i) => {
    const xy = toScr(p.en);
    ctx.fillStyle = p.s.kind === 'ongreen' ? '#ffffff' : '#ffd23f'; ctx.strokeStyle = '#14241d';
    ctx.beginPath(); ctx.arc(xy[0], xy[1], 6 * dpr, 0, 7); ctx.fill(); ctx.stroke();
    if (p.s.club) { ctx.font = `700 ${11 * dpr}px "Barlow Condensed",sans-serif`; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(p.s.club, xy[0] + 9 * dpr, xy[1] + 4 * dpr); }
  });
  // distance of each completed shot
  ctx.font = `600 ${11 * dpr}px "Barlow",sans-serif`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  for (let i = 1; i < pts.length; i++) {
    const a = toScr(pts[i - 1].en), b = toScr(pts[i].en);
    ctx.fillText(distYd(pts[i - 1].en, pts[i].en) + ' yd', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 6 * dpr);
  }
  const en = fixEN();
  if (en && activeRound()) { const xy = toScr(en); ctx.fillStyle = '#2f80ed'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.arc(xy[0], xy[1], 7 * dpr, 0, 7); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}
function build3dOverlay(group, THREE, toV) {
  const pts = shotPathsForHole(YB.cur()); if (!pts.length) return;
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd23f', depthTest: false });
  const wmat = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false });
  const geo = new THREE.SphereGeometry(1.8, 14, 10);
  const line = [];
  pts.forEach(p => {
    const v = toV(p.en[0], p.en[1], 1.5); line.push(v);
    const m = new THREE.Mesh(geo, p.s.kind === 'ongreen' ? wmat : mat); m.position.copy(v); m.renderOrder = 11; group.add(m);
  });
  if (line.length > 1) {
    const pts3 = [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], mid = a.clone().lerp(b, .5); mid.y += a.distanceTo(b) * 0.22;
      pts3.push(...new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(24));
    }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: '#ffd23f', depthTest: false }));
    l.renderOrder = 10; group.add(l);
  }
}


/* ------------------------------------------------------------------ past shots on each hole */
const LS_PASTOFF = 'yb-past-off';
let pastOff = new Set(store.get(LS_PASTOFF, []));
const isImported = r => r.status === 'imported';
// every earlier trail on this hole: rounds played with this app + shots traced from screenshots
function pastPaths(hole) {
  const bright = shotRoundId();
  return data.rounds.filter(r => r.course === COURSE_ID && r.id !== bright).map(r => {
    const pts = roundShots(r.id, hole).filter(s => s.lat != null && s.kind !== 'penalty').map(s => ({ en: G.toEN(s.lat, s.lon), s }));
    return { r, pts };
  }).filter(p => p.pts.length > 1);
}
function pastOn(hole) { return !pastOff.has(hole); }
function setPast(hole, on) { if (on) pastOff.delete(hole); else pastOff.add(hole); store.set(LS_PASTOFF, [...pastOff]); renderPastBtn(); YB.refresh(); }
function renderPastBtn() {
  let wrap = $('pastWrap');
  if (!wrap) {
    const stage = $('stage'); if (!stage) return;
    wrap = document.createElement('div'); wrap.id = 'pastWrap'; wrap.className = 'pastwrap'; stage.appendChild(wrap);
  }
  if (!/^#?(hole-\d+)?$/.test(location.hash) || !G) { wrap.hidden = true; return; }
  const hole = YB.cur(), n = pastPaths(hole).length, on = pastOn(hole);
  wrap.hidden = false;
  wrap.innerHTML = (n ? `<button class="chip" id="pastBtn" aria-pressed="${on}" title="Show or hide earlier shots on this hole">Past shots · ${n}</button>` : '')
    + `<button class="chip" id="traceBtn" title="Add shots from an 18Birdies screenshot">+ Shots</button>`;
  if ($('pastBtn')) $('pastBtn').onclick = () => setPast(hole, !pastOn(hole));
  $('traceBtn').onclick = () => openTrace(hole);
}
// one round's shots drawn faintly; the last point is where the ball finished
function drawPast2d(ctx, toScr, dpr) {
  const hole = YB.cur(); if (!pastOn(hole)) return;
  ctx.save();
  pastPaths(hole).forEach(({ pts }) => {
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1.8 * dpr; ctx.setLineDash([]);
    ctx.beginPath(); pts.forEach((p, i) => { const xy = toScr(p.en); i ? ctx.lineTo(xy[0], xy[1]) : ctx.moveTo(xy[0], xy[1]); }); ctx.stroke();
    pts.slice(1).forEach((p, i) => { const xy = toScr(p.en), last = i === pts.length - 2;
      ctx.fillStyle = last ? 'rgba(255,255,255,.8)' : 'rgba(255,224,130,.75)'; ctx.strokeStyle = 'rgba(20,36,29,.55)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], 4 * dpr, 0, 7); ctx.fill(); ctx.stroke(); });
  });
  ctx.restore();
}
function buildPast3d(group, THREE, toV) {
  const hole = YB.cur(); if (!pastOn(hole)) return;
  const paths = pastPaths(hole); if (!paths.length) return;
  const lmat = new THREE.LineBasicMaterial({ color: '#fbf8ee', transparent: true, opacity: 0.5, depthTest: false });
  // landing spots: same size on screen at any zoom, so they read from the tee view and up close
  if (!buildPast3d.tex) {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    x.fillStyle = 'rgba(20,36,29,.6)'; x.beginPath(); x.arc(32, 32, 30, 0, 7); x.fill();
    x.fillStyle = '#fff'; x.beginPath(); x.arc(32, 32, 23, 0, 7); x.fill();
    buildPast3d.tex = new THREE.CanvasTexture(c);
  }
  const dot = (color, size, op) => new THREE.PointsMaterial({ color, size, map: buildPast3d.tex, alphaTest: 0.1, sizeAttenuation: false, transparent: true, opacity: op, depthTest: false });
  const mid = [], end = [];
  paths.forEach(({ pts }) => {
    const vs = pts.map(p => toV(p.en[0], p.en[1], 1.2)), arc = [];
    for (let i = 1; i < vs.length; i++) {
      const a = vs[i - 1], b = vs[i], m = a.clone().lerp(b, .5), d = a.distanceTo(b);
      m.y += d > 25 ? d * 0.12 : d * 0.04;   // full swings arc, chips and putts stay low
      arc.push(...new THREE.QuadraticBezierCurve3(a, m, b).getPoints(20));
      (i === vs.length - 1 ? end : mid).push(b);
    }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), lmat); l.renderOrder = 7; group.add(l);
  });
  const px = Math.min(2, devicePixelRatio || 1);
  if (mid.length) { const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints(mid), dot('#ffe082', 9 * px, 0.85)); p.renderOrder = 8; group.add(p); }
  if (end.length) { const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints(end), dot('#ffffff', 9 * px, 0.9)); p.renderOrder = 8; group.add(p); }
}

/* ------------------------------------------------------------------ trace shots from a screenshot */
function inPoly(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
// similarity transform (scale + rotation + shift) from two matched points, as complex numbers
function sim(a1, a2, b1, b2) {
  const da = [a2[0] - a1[0], a2[1] - a1[1]], db = [b2[0] - b1[0], b2[1] - b1[1]], den = da[0] * da[0] + da[1] * da[1];
  if (!den) return null;
  const m = [(db[0] * da[0] + db[1] * da[1]) / den, (db[1] * da[0] - db[0] * da[1]) / den];
  return z => [m[0] * (z[0] - a1[0]) - m[1] * (z[1] - a1[1]) + b1[0], m[0] * (z[1] - a1[1]) + m[1] * (z[0] - a1[0]) + b1[1]];
}
const flipY = p => [p[0], -p[1]];   // image y points down, map north points up
// image -> course (east/north metres)
function fit2(i1, i2, w1, w2) { const f = sim(flipY(i1), flipY(i2), w1, w2); return f && (p => f(flipY(p))); }
// course -> image
function fit2inv(i1, i2, w1, w2) { const f = sim(w1, w2, flipY(i1), flipY(i2)); return f && (w => flipY(f(w))); }
let tr = null;
const HOWTO_SVG = `<svg viewBox="0 0 120 200" width="96" height="160" aria-hidden="true" style="flex:0 0 auto;border-radius:10px;background:#3d6b45">
  <ellipse cx="60" cy="34" rx="18" ry="12" fill="#6fae63"/><circle cx="60" cy="34" r="3" fill="#fff"/>
  <path d="M60 178 L74 112 L56 46" fill="none" stroke="#ffd23f" stroke-width="2.5"/>
  <g fill="#2a8cf0"><path d="M60 162a9 9 0 1 1 0.1 0L60 178z"/><path d="M74 96a9 9 0 1 1 0.1 0L74 112z"/><path d="M56 30a9 9 0 1 1 0.1 0L56 46z" opacity=".001"/></g>
  <g fill="#fff"><circle cx="60" cy="153" r="3.5"/><circle cx="74" cy="87" r="3.5"/></g>
  <circle cx="60" cy="190" r="4" fill="#fff" stroke="#14241d"/>
  <text x="68" y="194" font-size="9" fill="#fff" font-family="sans-serif">tee</text>
  <text x="80" y="38" font-size="9" fill="#fff" font-family="sans-serif">green</text>
  <text x="86" y="92" font-size="9" fill="#fff" font-family="sans-serif">shots</text></svg>`;
function traceHowto(open) {
  return `<details class="howto" ${open ? 'open' : ''}><summary>How to get the screenshot from 18Birdies</summary>
    <div style="display:flex;gap:12px;align-items:flex-start;margin-top:8px">${HOWTO_SVG}
    <ol>
      <li>In 18Birdies, open a round where you tracked shots (from your round history) and go to the hole.</li>
      <li>Your shots show as <b>blue pins</b> joined by a yellow line, with labels like “251 Yds Dr”.</li>
      <li>Pinch to fit the hole so the <b>tee marker</b>, <b>every pin</b> and the <b>green</b> are on screen. Keep north-up or tee-at-bottom, either works.</li>
      <li>Take a screenshot (side button + volume up). One screenshot per hole.</li>
      <li>Here, pick the date, the tees you played and the hole, then choose the screenshot.</li>
    </ol></div>
    <p class="rm" style="margin:6px 0 0">The app finds the blue pins for you. You tap the tee icon and the middle of the green so it can line the picture up with the course.</p></details>`;
}
function openTrace(hole) {
  const today = new Date().toISOString().slice(0, 10);
  const tees = ['Black', 'Blue', 'Blue/White', 'White'];
  const last = store.get('yb-trace-last', {});
  openSheet(`<h3>Add shots from a screenshot</h3>
    ${traceHowto(!last.date)}
    <form id="trf" class="aform" style="margin-top:10px">
      <div class="two"><label>Date played<input type="date" id="trDate" value="${last.date || today}" max="${today}"></label>
      <label>Tees you played<select id="trTee">${tees.map(t => `<option ${t === (last.tee || YB.tee()) ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
      <label>Hole<select id="trHole">${YB.H.map(h => `<option value="${h.n}" ${h.n === hole ? 'selected' : ''}>${h.n} · par ${h.par}</option>`).join('')}</select></label>
      <label class="rb main impfile" style="text-align:center">Choose screenshot<input type="file" id="trFile" accept="image/*" hidden></label>
    </form>`);
  $('trFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      tr = { img, hole: +$('trHole').value, date: $('trDate').value, tee: $('trTee').value, anchors: [], pts: [], clubs: [], found: findPins(img) };
      store.set('yb-trace-last', { date: tr.date, tee: tr.tee });
      traceScreen();
    };
    img.src = URL.createObjectURL(f);
  };
}
// find 18Birdies shot pins: solid blue teardrops with a white centre; the shot spot is the pin's point
function findPins(img) {
  try {
    const W = Math.min(660, img.width), k = W / img.width, H = Math.round(img.height * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; m[i] = b > 195 && r < 100 && g > 95 && g < 195 && b - r > 130 ? 1 : 0; }
    const pins = [], stack = [];
    for (let i = 0; i < W * H; i++) {
      if (m[i] !== 1) continue;
      let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, tipX = 0, tipN = 0; stack.push(i); m[i] = 2;
      while (stack.length) {
        const j = stack.pop(), px = j % W, py = (j - px) / W; n++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py;
        if (py > y1) { y1 = py; tipX = px; tipN = 1; } else if (py === y1) { tipX += px; tipN++; }
        if (px > 0 && m[j - 1] === 1) { m[j - 1] = 2; stack.push(j - 1); }
        if (px < W - 1 && m[j + 1] === 1) { m[j + 1] = 2; stack.push(j + 1); }
        if (py > 0 && m[j - W] === 1) { m[j - W] = 2; stack.push(j - W); }
        if (py < H - 1 && m[j + W] === 1) { m[j + W] = 2; stack.push(j + W); }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1, fill = n / (w * h);
      if (w > W * 0.045 && w < W * 0.11 && h / w > 1.1 && h / w < 1.6 && fill > 0.35 && fill < 0.75) pins.push([tipX / tipN / k, (y1 + 1) / k]);
    }
    return pins;
  } catch (e) { return []; }
}
// put points in playing order: along the line from the tee to the green
function orderPts(pts) {
  const [a, b] = tr.anchors, v = [b[0] - a[0], b[1] - a[1]];
  return pts.slice().sort((p, q) => ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) - ((q[0] - a[0]) * v[0] + (q[1] - a[1]) * v[1]));
}
function traceScreen() {
  openSheet(`<h3>Hole ${tr.hole}</h3>
    <p class="rm" id="trHint"></p>
    <div class="trwrap"><canvas id="trCan"></canvas></div>
    <label class="trov"><input type="checkbox" id="trOv" checked> Show course outlines</label>
    <div class="rbtns"><button class="rb ghost" id="trUndo">Undo</button><button class="rb main" id="trDone" disabled>Next</button></div>`);
  const can = $('trCan'), img = tr.img;
  const maxW = Math.min(can.parentElement.clientWidth || 360, 600), maxH = Math.max(320, innerHeight * 0.6);
  const k = Math.min(maxW / img.width, maxH / img.height), dpr = devicePixelRatio || 1;
  can.style.width = img.width * k + 'px'; can.style.height = img.height * k + 'px';
  can.width = Math.round(img.width * k * dpr); can.height = Math.round(img.height * k * dpr);
  const ctx = can.getContext('2d'), hist = [];
  const h = YB.H[tr.hole - 1], g = YB.geom(h, 'Black'), F = YB.course.features || {};
  // course features near this hole, for the alignment check
  const near = (poly) => poly.some(p => Math.min(Math.hypot(p[0] - g.tee[0], p[1] - g.tee[1]), Math.hypot(p[0] - g.gc[0], p[1] - g.gc[1]), Math.hypot(p[0] - (g.tee[0] + g.gc[0]) / 2, p[1] - (g.tee[1] + g.gc[1]) / 2)) < 420);
  const feats = ['fairways', 'bunkers', 'greens', 'water'].flatMap(kind => (F[kind] || []).filter(near).map(poly => ({ kind, poly })));
  const mark = (p, lab, fill, fg, rad = 9) => { ctx.fillStyle = fill; ctx.strokeStyle = '#14241d'; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.arc(p[0], p[1], rad * dpr, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = fg; ctx.font = `700 ${11 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(lab, p[0], p[1] + .5); };
  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(img, 0, 0, can.width, can.height);
    const sc = can.width / img.width, P = t => [t[0] * sc, t[1] * sc];
    if (tr.anchors.length === 2 && $('trOv').checked) {
      const inv = fit2inv(tr.anchors[0], tr.anchors[1], g.tee, g.gc);
      if (inv) {
        ctx.save(); ctx.lineJoin = 'round';
        feats.forEach(({ kind, poly }) => {
          ctx.beginPath(); poly.forEach((w, i) => { const p = P(inv(w)); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.closePath();
          ctx.lineWidth = (kind === 'fairways' ? 1.5 : 2) * dpr;
          ctx.strokeStyle = kind === 'greens' ? '#ff5bd1' : kind === 'bunkers' ? '#ffffff' : kind === 'water' ? '#5bc8ff' : 'rgba(255,255,255,.55)';
          ctx.setLineDash(kind === 'fairways' ? [5 * dpr, 4 * dpr] : []); ctx.stroke();
        });
        ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.strokeStyle = 'rgba(255,91,209,.9)'; ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); h.line.forEach((w, i) => { const p = P(inv(w)); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke();
        ctx.restore();
      }
    }
    if (tr.pts.length > 1) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2.5 * dpr; ctx.setLineDash([]); ctx.beginPath(); tr.pts.forEach((t, i) => { const p = P(t); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke(); }
    tr.pts.forEach((t, i) => mark(P(t), String(i + 1), '#ffd23f', '#14241d'));
    if (tr.anchors[0]) mark(P(tr.anchors[0]), 'T', '#fff', '#14241d', 11);
    if (tr.anchors[1]) mark(P(tr.anchors[1]), 'G', '#ff5bd1', '#fff', 11);
    const a = tr.anchors.length, n = tr.pts.length;
    $('trHint').innerHTML = a === 0 ? '<b>1.</b> Tap the small white <b>tee icon</b> (it marks the back tee, behind your first pin).'
      : a === 1 ? '<b>2.</b> Tap the <b>middle of the green</b> (18Birdies shows a small grey dot there).'
      : `<b>3.</b> The <b style="color:#c2189b">pink and white outlines</b> are this app's greens and bunkers. If they don't sit on the ones in your screenshot, <b>drag T and G</b> until they do. `
        + (tr.auto ? `Found <b>${tr.auto} shot${tr.auto === 1 ? '' : 's'}</b>. ` : 'Tap the point of each blue pin. ') + 'Drag a number to move it, tap it to remove it, tap the picture to add one.';
    $('trDone').disabled = a < 2 || n < 2; $('trUndo').disabled = !hist.length;
  };
  const toImg = ev => { const r = can.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * img.width, (ev.clientY - r.top) / r.height * img.height]; };
  const grabR = () => 22 / (can.getBoundingClientRect().width / img.width);   // finger-sized, in image pixels
  let drag = null;
  const snap = () => hist.push({ anchors: tr.anchors.map(q => q.slice()), pts: tr.pts.map(q => q.slice()), auto: tr.auto });
  can.onpointerdown = ev => {
    const p = toImg(ev), R = grabR(); can.setPointerCapture(ev.pointerId);
    let target = null;
    if (tr.anchors.length === 2) {
      const ai = tr.anchors.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < R);
      if (ai >= 0) target = { kind: 'a', i: ai };
      else { const pi = tr.pts.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < R); if (pi >= 0) target = { kind: 'p', i: pi }; }
    }
    drag = { start: p, x: ev.clientX, y: ev.clientY, target, moved: false };
  };
  can.onpointermove = ev => {
    if (!drag || !drag.target) return;
    if (!drag.moved) { if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return; snap(); drag.moved = true; }
    ev.preventDefault();
    const p = toImg(ev);
    if (drag.target.kind === 'a') tr.anchors[drag.target.i] = p; else tr.pts[drag.target.i] = p;
    draw();
  };
  can.onpointerup = () => {
    const d = drag; drag = null; if (!d) return;
    if (d.moved) { if (d.target.kind === 'p') tr.pts = orderPts(tr.pts); draw(); return; }
    const p = d.start; snap();
    if (tr.anchors.length < 2) {
      tr.anchors.push(p);
      if (tr.anchors.length === 2 && !tr.pts.length && tr.found.length) { tr.pts = orderPts(tr.found); tr.auto = tr.pts.length; }
    } else if (d.target && d.target.kind === 'p') tr.pts.splice(d.target.i, 1);
    else if (!d.target) tr.pts = orderPts(tr.pts.concat([p]));
    else hist.pop();   // tapped T or G without moving: nothing changes
    draw();
  };
  can.onpointercancel = () => { drag = null; };
  $('trOv').onchange = draw;
  $('trUndo').onclick = () => { const s = hist.pop(); if (!s) return; tr.anchors = s.anchors; tr.pts = s.pts; tr.auto = s.auto; draw(); };
  $('trDone').onclick = traceReview;
  draw();
}
function traceShots() {
  // 18Birdies' tee icon is always the back (Black) tee, whatever tees are shown at the top
  const h = YB.H[tr.hole - 1], g = YB.geom(h, 'Black');
  const f = fit2(tr.anchors[0], tr.anchors[1], g.tee, g.gc); if (!f) return null;
  return { g, pts: tr.pts.map(f) };   // shot i is hit from pts[i]
}
function traceReview() {
  const res = traceShots(); if (!res) { toast('Tap the tee and green in different spots'); return; }
  const { g, pts } = res, n = pts.length - 1;
  const onGreen = g.poly && inPoly(pts[n], g.poly);
  const clubs = bag && bag.length ? bag : ['Driver', '3W', '5W', 'Hybrid', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW', 'Putter'];
  openSheet(`<h3>Hole ${tr.hole} · ${n} shot${n === 1 ? '' : 's'}</h3>
    <p class="rm">Check the yardages match 18Birdies' labels and pick the clubs it shows (optional).</p>
    <div class="trlist">${pts.slice(0, n).map((p, i) => `<div class="trrow"><span>Shot ${i + 1}</span><b>${distYd(p, pts[i + 1])} yd</b><select data-c="${i}"><option value="">Club</option>${clubs.map(c => `<option ${tr.clubs[i] === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('')}</div>
    <p class="rm">${onGreen ? 'The last spot is on the green.' : `The last spot is ${distYd(pts[n], g.gc)} yd from the middle of the green.`} If the yardages are well off, go back and redo the tee icon and green taps.</p>
    <div class="rbtns"><button class="rb ghost" id="trBack">Back</button><button class="rb main" id="trSave">Save shots</button></div>`);
  document.querySelectorAll('[data-c]').forEach(s => s.onchange = () => { tr.clubs[+s.dataset.c] = s.value || null; });
  $('trBack').onclick = traceScreen;
  $('trSave').onclick = () => saveTrace(pts, onGreen);
}
function saveTrace(pts, onGreen) {
  const day = tr.date || new Date().toISOString().slice(0, 10), when = new Date(day + 'T12:00:00').toISOString();
  // one traced round per date and tee; re-tracing a hole replaces it
  let r = data.rounds.find(x => isImported(x) && x.course === COURSE_ID && x.started_at.slice(0, 10) === when.slice(0, 10) && x.tee === tr.tee);
  if (!r) { r = { id: uuid(), course: COURSE_ID, tee: tr.tee, started_at: when, ended_at: when, status: 'imported', weather: null }; upsertRound(r); }
  roundShots(r.id, tr.hole).forEach(removeShot);
  pts.forEach((en, i) => {
    const ll = G.toLL(en[0], en[1]), last = i === pts.length - 1;
    addShot({ id: uuid(), round_id: r.id, hole: tr.hole, seq: i + 1, kind: last ? (onGreen ? 'ongreen' : 'end') : 'shot', club: last ? null : (tr.clubs[i] || null),
      lat: +ll[0].toFixed(7), lon: +ll[1].toFixed(7), accuracy: null, source: '18birdies', taken_at: when, weather: null });
  });
  const hole = tr.hole; tr = null; closeSheet();
  pastOff.delete(hole); store.set(LS_PASTOFF, [...pastOff]);
  if (YB.cur() !== hole) location.hash = 'hole-' + hole; else YB.refresh();
  renderPastBtn(); render();
  toast(`Saved ${pts.length - 1} shots on hole ${hole}`);
}

/* ------------------------------------------------------------------ sync (Supabase) */
const sync = {
  enabled: false, client: null, user: null, busy: false, timer: null,
  async init() {
    const cfg = window.YB_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
    try {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      this.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true } });
      this.enabled = true;
      const { data: { session } } = await this.client.auth.getSession();
      this.user = session ? session.user : null;
      this.client.auth.onAuthStateChange((ev, s) => { const was = this.user && this.user.id; this.user = s ? s.user : null; if (this.user && this.user.id !== was) this.afterSignIn(); renderAcct(); });
      // clean ?code= from the address bar after the sign-in redirect
      if (/[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
      if (this.user) await this.afterSignIn();
    } catch (e) { console.warn('sync unavailable', e); this.enabled = false; }
    renderAcct();
  },
  signIn() { this.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }); },
  async signOut() { await this.client.auth.signOut(); this.user = null; renderAcct(); toast('Signed out. Rounds stay on this phone.'); },
  async afterSignIn() {
    // first sign-in on this device: send everything recorded while signed out
    if (store.get(LS_MERGED, null) !== this.user.id) {
      data.rounds.forEach(r => outbox.push({ table: 'rounds', op: 'upsert', row: r }));
      data.scores.forEach(s => outbox.push({ table: 'hole_scores', op: 'upsert', row: s }));
      data.shots.forEach(s => outbox.push({ table: 'shots', op: 'upsert', row: s }));
      data.posted.forEach(s => outbox.push({ table: 'posted_scores', op: 'upsert', row: s }));
      store.set(LS_OUTBOX, outbox); store.set(LS_MERGED, this.user.id);
      this.saveProfile();
    }
    await this.flush();
    await this.pull();
  },
  async pull() {
    if (!this.user) return;
    try {
      const c = this.client;
      const [r1, r2, r3, r4, r5] = await Promise.all([
        c.from('rounds').select('*').eq('course', COURSE_ID),
        c.from('hole_scores').select('*'),
        c.from('shots').select('*'),
        c.from('profiles').select('*').maybeSingle(),
        c.from('posted_scores').select('*')
      ]);
      if (r1.error || r2.error || r3.error) throw (r1.error || r2.error || r3.error);
      const pendingIds = new Set(outbox.map(o => o.row.id || (o.row.round_id + ':' + o.row.hole)));
      const merge = (local, remote, key) => {
        const m = new Map(local.map(x => [key(x), x]));
        remote.forEach(x => { const k = key(x); const l = m.get(k); if (pendingIds.has(k)) return; if (!l || (x.updated_at || '') >= (l.updated_at || '')) m.set(k, strip(x)); });
        return [...m.values()];
      };
      data.rounds = merge(data.rounds, r1.data, x => x.id);
      data.scores = merge(data.scores, r2.data, x => x.round_id + ':' + x.hole);
      data.shots = merge(data.shots, r3.data, x => x.id);
      if (!r5.error) {
        data.posted = merge(data.posted, r5.data, x => x.id);
        // one time: send scores that were saved while the account tables didn't exist yet
        const flag = 'yb-posted-sent-' + this.user.id;
        if (!store.get(flag, false)) {
          const have = new Set(r5.data.map(x => x.id)), queued = new Set(outbox.filter(o => o.table === 'posted_scores').map(o => o.row.id));
          data.posted.filter(p => !have.has(p.id) && !queued.has(p.id)).forEach(p => outbox.push({ table: 'posted_scores', op: 'upsert', row: p }));
          courseCache.filter(c => c.source === 'user' && !c.created_by).forEach(c => outbox.push({ table: 'courses', op: 'upsert', row: courseRow(c) }));
          store.set(LS_OUTBOX, outbox); store.set(flag, true); this.flushSoon();
        }
      } else if (isSetupError(r5.error)) { this.setupNeeded = true; }
      if (r4.data && Array.isArray(r4.data.bag) && r4.data.bag.length) { bag = r4.data.bag; store.set(LS_BAG, bag); }
      if (r4.data && !outbox.some(o => o.table === 'profiles')) {
        ['official_index', 'gender', 'tee_ratings', 'display_name'].forEach(k => { if (r4.data[k] !== undefined && r4.data[k] !== null) profile[k] = r4.data[k]; });
        store.set(LS_PROFILE, profile);
      }
      save(); render(); YB.refresh();
    } catch (e) { console.warn('pull failed', e); }
  },
  saveProfile() { if (this.user) { outbox.push({ table: 'profiles', op: 'upsert', row: { bag, default_tee: YB.tee(), official_index: profile.official_index, gender: profile.gender, tee_ratings: profile.tee_ratings, display_name: profile.display_name } }); store.set(LS_OUTBOX, outbox); this.flushSoon(); } },
  flushSoon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 600); },
  async flush() {
    if (!this.user || this.busy || !outbox.length || !navigator.onLine) { renderAcct(); return; }
    this.busy = true;
    try {
      while (outbox.length) {
        const o = outbox[0];
        let res, n = 1;
        if (o.op === 'delete') res = await this.client.from(o.table).delete().eq('id', o.row.id);
        else {
          // send runs of upserts to the same table in one request (imports can be hundreds of rows)
          const batch = [strip(o.row)];
          while (n < outbox.length && n < 200 && outbox[n].op === 'upsert' && outbox[n].table === o.table && o.table !== 'profiles') { batch.push(strip(outbox[n].row)); n++; }
          const conflict = o.table === 'hole_scores' ? 'round_id,hole' : o.table === 'profiles' ? 'user_id' : 'id';
          // de-duplicate within a batch (same row edited twice): keep the last version
          const keyOf = x => o.table === 'hole_scores' ? x.round_id + ':' + x.hole : x.id;
          const uniq = [...new Map(batch.map(x => [keyOf(x), x])).values()];
          res = await this.client.from(o.table).upsert(o.table === 'profiles' ? uniq[0] : uniq, { onConflict: conflict });
        }
        if (res.error) {
          console.warn('sync error', o, res.error);
          // database not set up yet (table or column missing): keep everything queued until it is
          if (isSetupError(res.error)) { this.setupNeeded = true; renderProfile(); break; }
          if (/JWT|auth|fetch|network/i.test(res.error.message || '')) break;
        } else if (this.setupNeeded && o.table !== 'courses') { this.setupNeeded = false; renderProfile(); }
        outbox.splice(0, n); store.set(LS_OUTBOX, outbox);
      }
    } catch (e) { console.warn('flush stopped', e); }
    this.busy = false; renderAcct();
  }
};
function isSetupError(e) { return /^(42P01|42703|PGRST20[45])$/.test(e.code || '') || /does not exist|schema cache/i.test(e.message || ''); }
function strip(row) { const r = Object.assign({}, row); delete r.user_id; return r; }
window.addEventListener('online', () => sync.flush());


/* ------------------------------------------------------------------ handicap + profile */
const LS_PROFILE = 'yb-profile-v1';
// Course Rating / Slope by tee. Men's values from GolfPass; White and women's values from
// other listings: confirm against your GHIN app and edit on the profile page.
const DEFAULT_RATINGS = {
  M: { 'Black': [72.1, 137], 'Blue': [70.0, 128], 'Blue/White': [68.3, 126], 'White': [66.1, 116] },
  F: { 'Black': null, 'Blue': [76.2, 134], 'Blue/White': null, 'White': [71.4, 126] }
};
let profile = Object.assign({ official_index: null, gender: 'M', tee_ratings: null, display_name: null }, store.get(LS_PROFILE, {}));
data.posted = data.posted || [];
function saveProfileLocal() { store.set(LS_PROFILE, profile); sync.saveProfile(); }
function ratingFor(tee, gender) {
  const g = gender || profile.gender || 'M';
  const own = profile.tee_ratings && profile.tee_ratings[g] && profile.tee_ratings[g][tee];
  return own || (DEFAULT_RATINGS[g] && DEFAULT_RATINGS[g][tee]) || null;
}
function crownScores() {
  const out = [];
  for (const r of data.rounds.filter(x => x.course === COURSE_ID && x.status === 'done')) {
    const rs = ratingFor(r.tee); if (!rs) continue;
    const holes = [];
    for (let i = 1; i <= 18; i++) { const sc = holeScore(r.id, i); if (sc && sc.score != null) holes.push({ n: i, par: YB.H[i - 1].par, si: YB.H[i - 1].hcp, score: sc.score }); }
    if (holes.length < 9) continue;
    const front = holes.every(h => h.n <= 9), back = holes.every(h => h.n >= 10);
    let kind = holes.length === 18 ? '18' : holes.length === 9 && (front || back) ? '9' : holes.length >= 10 ? 'partial' : null;
    if (!kind) continue;
    out.push({ id: r.id, date: r.started_at, kind, holes, rating: rs[0], slope: rs[1], par: 72, roundId: r.id, course: 'The Crown', tee: r.tee });
  }
  return out;
}
function allScores() {
  return crownScores().concat(data.posted.map(p => p.differential != null && p.ags == null
    ? { id: p.id, date: p.played_on, kind: 'diff', differential: +p.differential, course: p.course, tee: p.tee, posted: p }
    : (+p.holes === 9
      // 9-hole postings carry the 9-hole rating/slope from the card
      ? { id: p.id, date: p.played_on, kind: '9', ags: +p.ags, gross: p.gross != null ? +p.gross : null, rating: +p.course_rating * 2, slope: +p.slope, par: (+p.par || 36) * 2, ratingPlayed: +p.course_rating, slopePlayed: +p.slope, nHoles: 9, course: p.course, tee: p.tee, posted: p, shownRating: +p.course_rating }
      : { id: p.id, date: p.played_on, kind: '18', ags: +p.ags, gross: p.gross != null ? +p.gross : null, rating: +p.course_rating, slope: +p.slope, par: +p.par || 72, nHoles: 18, course: p.course, tee: p.tee, posted: p })));
}
let hcCache = null, profileShowAll = false;
function handicap() {
  if (!window.WHS) return null;
  hcCache = WHS.compute(allScores(), { startIndex: profile.official_index != null ? +profile.official_index : null });
  return hcCache;
}
// The index used for course handicaps: an official GHIN index if entered, otherwise the app's own
function indexInUse() {
  if (profile.official_index != null && profile.official_index !== '') return { v: +profile.official_index, src: 'official' };
  const h = hcCache || handicap();
  return h && h.index != null ? { v: h.index, src: 'app' } : null;
}
function courseHcp(tee) {
  const ix = indexInUse(), rs = ratingFor(tee); if (!ix || !rs) return null;
  return WHS.courseHandicap(ix.v, rs[1], rs[0], 72);
}
const fmtIx = v => v == null ? '–' : v < 0 ? '+' + Math.abs(v).toFixed(1) : v.toFixed(1);

function upsertPosted(p) { p.updated_at = nowIso(); const i = data.posted.findIndex(x => x.id === p.id); if (i < 0) data.posted.push(p); else data.posted[i] = p; save(); queue('posted_scores', 'upsert', p); }
function deletePosted(p) { data.posted = data.posted.filter(x => x.id !== p.id); save(); queue('posted_scores', 'delete', { id: p.id }); }

function stats() {
  const rounds = data.rounds.filter(r => r.course === COURSE_ID && r.status === 'done');
  let full = [], putts = [], fwH = 0, fwN = 0, gir = 0, girN = 0; const byPar = { 3: [], 4: [], 5: [] };
  rounds.forEach(r => {
    let tot = 0, n = 0, pt = 0, ptn = 0;
    for (let i = 1; i <= 18; i++) {
      const sc = holeScore(r.id, i), h = YB.H[i - 1]; if (!sc || sc.score == null) continue;
      tot += sc.score; n++; byPar[h.par].push(sc.score - h.par);
      if (sc.putts != null) { pt += sc.putts; ptn++; girN++; if (sc.score - sc.putts <= h.par - 2) gir++; }
      if (h.par >= 4 && sc.fairway) { fwN++; if (sc.fairway === 'hit') fwH++; }
    }
    if (n === 18) { full.push(tot); if (ptn === 18) putts.push(pt); }
  });
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  return { rounds: rounds.length, avg: avg(full), best: full.length ? Math.min(...full) : null, putts: avg(putts),
    fw: fwN ? Math.round(100 * fwH / fwN) : null, gir: girN ? Math.round(100 * gir / girN) : null,
    p3: avg(byPar[3]), p4: avg(byPar[4]), p5: avg(byPar[5]) };
}
function trendSvg(hist) {
  if (hist.length < 2) return '';
  const W = 340, H = 120, l = 30, r = 8, t = 10, b = 20;
  const xs = hist.map((_, i) => i), ys = hist.map(h => h.index);
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const X = i => l + i / (hist.length - 1) * (W - l - r), Y = v => t + (1 - (v - lo) / (hi - lo)) * (H - t - b);
  const path = hist.map((h, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(h.index).toFixed(1)).join(' ');
  let grid = ''; const step = (hi - lo) > 10 ? 5 : 2;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) grid += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d3dacf"/><text x="${l - 5}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#5b6b62">${v}</text>`;
  const d0 = new Date(hist[0].date).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), d1 = new Date(hist[hist.length - 1].date).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  const last = hist[hist.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Handicap Index over time">${grid}
    <path d="${path} L${X(hist.length - 1)} ${H - b} L${X(0)} ${H - b}Z" fill="#1f4a37" opacity=".1"/><path d="${path}" fill="none" stroke="#1f4a37" stroke-width="2"/>
    <circle cx="${X(hist.length - 1)}" cy="${Y(last.index)}" r="4" fill="#d23b2a"/>
    <text x="${l}" y="${H - 5}" font-size="10" fill="#5b6b62">${d0}</text><text x="${W - r}" y="${H - 5}" font-size="10" text-anchor="end" fill="#5b6b62">${d1}</text></svg>`;
}

function renderProfile() {
  const el = $('profileView'); if (!el) return;
  const show = location.hash === '#profile';
  el.hidden = !show; if (!show) return;
  const hc = handicap(), st = stats(), ix = indexInUse();
  const name = (sync.user && (sync.user.user_metadata && (sync.user.user_metadata.full_name || sync.user.user_metadata.name))) || profile.display_name || 'Your profile';
  const tees = ['Black', 'Blue', 'Blue/White', 'White'];
  const chRows = tees.map(t => { const rs = ratingFor(t); const ch = courseHcp(t); return `<tr><td>${t}</td><td>${rs ? rs[0].toFixed(1) + ' / ' + rs[1] : '<span class="rm">not set</span>'}</td><td class="big">${ch == null ? '–' : ch < 0 ? '+' + (-ch) : ch}</td></tr>`; }).join('');
  const allRecs = hc ? hc.records.slice().reverse() : [];
  const recs = profileShowAll ? allRecs : allRecs.slice(0, 40);
  const row = r => {
    const s = r.source, crown = !!s.roundId;
    const d = new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    const diff = r.diff == null ? '–' : (r.diff + (r.adj || 0)).toFixed(1);
    const score = s.kind === 'diff' ? '–' : (r.gross ?? '–') + (r.ags != null && r.ags !== r.gross ? `<small> (${r.ags})</small>` : '');
    const holes = s.kind === '9' ? ' · 9' : s.kind === 'partial' ? ` · ${r.nPlayed}` : '';
    return `<tr class="${crown ? 'go' : 'ext'}" data-id="${esc(r.id)}"><td>${d}</td><td>${esc(s.course || '')}<small>${esc(s.tee ? ' · ' + s.tee : '')}${holes}</small></td><td>${score}</td><td>${s.rating != null ? (+(s.shownRating ?? s.rating)).toFixed(1) + '/' + s.slope : '–'}</td><td class="df ${r.inBest ? 'best' : ''}">${diff}${r.esr ? '*' : ''}</td></tr>${r.notes.length || r.status ? `<tr class="note"><td></td><td colspan="4">${esc([r.status].concat(r.notes).filter(Boolean).join(' · '))}</td></tr>` : ''}`;
  };
  const setupNote = sync.user && sync.setupNeeded ? `<div class="box warn"><b>Scores aren't saving to your account yet.</b> They're safe on this device and will upload automatically once the database update (supabase/003_courses.sql) has been run.</div>` : '';
  el.innerHTML = `${setupNote}
  <div class="pgrid">
    <div class="box">
      <h2>${esc(name)}</h2>
      ${sync.enabled ? `<p class="rm acctline">${sync.user ? `Signed in as ${esc(sync.user.email || '')} · <a href="#" id="pfOut">Sign out</a>` : `<button class="rb" id="pfIn">Sign in with Google</button> to keep your scores on every device`}</p>` : ''}
      <div class="hix"><div><div class="k">Handicap Index</div><div class="v">${fmtIx(hc && hc.index)}</div>
        <div class="rm">${hc && hc.index != null ? `From ${hc.counting} score${hc.counting === 1 ? '' : 's'}${hc.counting < 20 ? ' (uses the fewer-than-20 table)' : ', best 8 of the last 20'}` : `Post ${Math.max(0, 3 - (hc ? hc.counting : 0))} more 18-hole score${3 - (hc ? hc.counting : 0) === 1 ? '' : 's'} (or 9-hole pairs) to get an Index`}</div></div>
        <div><div class="k">Low (12 mo)</div><div class="v sm">${fmtIx(hc && hc.low)}</div></div></div>
      ${hc && hc.history.length > 1 ? trendSvg(hc.history.slice(-40)) : ''}
      <div class="stp" style="grid-template-columns:1fr auto auto"><span>Official GHIN Index<br><small class="rm">Optional. Used for course handicaps when set.</small></span>
        <input id="pfOff" inputmode="decimal" placeholder="e.g. 12.4" value="${profile.official_index ?? ''}" aria-label="Official Handicap Index" style="width:90px;font:600 18px var(--display);padding:8px;border:1px solid var(--rule);border-radius:8px;text-align:center">
        <button class="rb" id="pfOffSave">Save</button></div>
      <p class="rm">${ix ? `Course handicaps below use ${ix.src === 'official' ? 'your official Index' : 'the app\'s Index'} (${fmtIx(ix.v)}).` : 'Course handicaps appear once there is an Index.'}</p>
      <table class="pt"><thead><tr><th>Tee</th><th>Rating / Slope</th><th>Course hcp</th></tr></thead><tbody>${chRows}</tbody></table>
      <div class="rbtns"><button class="rb ghost" id="pfRatings">Edit ratings</button><button class="rb ghost" id="pfGender">${profile.gender === 'F' ? "Women's" : "Men's"} ratings</button></div>
    </div>
    <div class="box">
      <h2>Stats · The Crown</h2>
      <div class="sgrid">
        <div><div class="k">Rounds</div><div class="v">${st.rounds}</div></div>
        <div><div class="k">Avg score</div><div class="v">${st.avg == null ? '–' : st.avg.toFixed(1)}</div></div>
        <div><div class="k">Best</div><div class="v">${st.best ?? '–'}</div></div>
        <div><div class="k">Putts / round</div><div class="v">${st.putts == null ? '–' : st.putts.toFixed(1)}</div></div>
        <div><div class="k">Fairways</div><div class="v">${st.fw == null ? '–' : st.fw + '%'}</div></div>
        <div><div class="k">Greens (GIR)</div><div class="v">${st.gir == null ? '–' : st.gir + '%'}</div></div>
        <div><div class="k">Par 3 avg</div><div class="v">${st.p3 == null ? '–' : (st.p3 >= 0 ? '+' : '') + st.p3.toFixed(2)}</div></div>
        <div><div class="k">Par 4 avg</div><div class="v">${st.p4 == null ? '–' : (st.p4 >= 0 ? '+' : '') + st.p4.toFixed(2)}</div></div>
        <div><div class="k">Par 5 avg</div><div class="v">${st.p5 == null ? '–' : (st.p5 >= 0 ? '+' : '') + st.p5.toFixed(2)}</div></div>
      </div>
      ${!sync.user && sync.enabled ? `<p class="rm" style="margin-top:12px">Scores are saved on this phone. <a href="#" id="pfIn">Sign in with Google</a> to keep them across devices.</p>` : ''}
    </div>
  </div>
  <div class="box" style="margin-top:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="margin:0">Score history</h2><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="rb" id="pfImport">Import scores</button><button class="rb ghost" id="pfAdd">Add one</button></div></div>
    ${store.get(LS_LASTIMPORT, []).length ? `<p class="rm">Last import: ${store.get(LS_LASTIMPORT, []).length} scores · <a href="#" id="pfUndoImp">undo it</a></p>` : ''}
    <p class="rm">Highlighted differentials are the ones counting toward your Index. Numbers in brackets are adjusted for net double bogey. * marks an exceptional score.</p>
    <div class="cardview"><table class="pt hist"><thead><tr><th>Date</th><th>Course</th><th>Score</th><th>Rating</th><th>Diff</th></tr></thead><tbody>${recs.length ? recs.map(row).join('') + (allRecs.length > recs.length ? `<tr><td colspan="5"><button class="rb ghost" id="pfAll" style="width:100%">Show all ${allRecs.length} scores</button></td></tr>` : '') : '<tr><td colspan="5" class="rm">No scores yet. Finish a round at The Crown, or import your history from another app or GHIN.</td></tr>'}</tbody></table></div>
  </div>
  <p class="small">This is an unofficial index calculated with the World Handicap System rules (2024 revision). It doesn't apply Playing Conditions Calculation, and the expected score used for 9-hole and partial rounds is a close approximation of the USGA's formula. An official Handicap Index comes from your golf association through GHIN.</p>`;
  $('pfOffSave').onclick = () => { const v = $('pfOff').value.trim().replace('+', '-'); profile.official_index = v === '' ? null : (isNaN(+v) ? profile.official_index : Math.max(-10, Math.min(54, +v))); saveProfileLocal(); render(); toast('Saved'); };
  // traced shot rounds (from screenshots)
  const traced = data.rounds.filter(x => x.course === COURSE_ID && isImported(x)).sort((a, b) => b.started_at.localeCompare(a.started_at));
  const ownShots = data.rounds.filter(x => x.course === COURSE_ID && !isImported(x)).reduce((t, x) => t + new Set(roundShots(x.id).map(s => s.hole)).size, 0);
  el.insertAdjacentHTML('beforeend', `<div class="box" style="margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2 style="margin:0">Shot history</h2><button class="rb" id="pfTrace">Add shots from a screenshot</button></div>
    <p class="rm">Past shots show faintly on each hole you've played. Use <b>Past shots</b> on the hole view to hide them for that hole. Shots tracked in 18Birdies can be added from a screenshot of each hole; the button walks you through it.${ownShots ? ` ${ownShots} hole${ownShots === 1 ? '' : 's'} tracked with this app.` : ''}</p>
    ${traced.length ? `<table class="pt"><tbody>${traced.map(x => { const holes = [...new Set(roundShots(x.id).map(s => s.hole))].sort((a, b) => a - b); return `<tr><td>${new Date(x.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })}</td><td>${esc(x.tee || '')}<small> · from screenshots</small></td><td><small>${holes.length ? 'holes ' + holes.join(', ') : 'no shots'}</small></td><td><button class="rb ghost" data-deltr="${x.id}" style="min-height:34px;padding:6px 10px">Delete</button></td></tr>`; }).join('')}</tbody></table>` : ''}</div>`);
  $('pfTrace').onclick = () => openTrace(1);
  el.querySelectorAll('[data-deltr]').forEach(b => b.onclick = () => { const x = data.rounds.find(y => y.id === b.dataset.deltr); if (!x) return;
    openSheet(`<h3>Delete these traced shots?</h3><p class="rm">Removes every shot traced for this date.</p><div class="rbtns"><button class="rb" id="dtYes" style="background:var(--flag);color:#fff;border-color:var(--flag)">Delete</button><button class="rb ghost" id="dtNo">Cancel</button></div>`);
    $('dtYes').onclick = () => { deleteRound(x); closeSheet(); render(); YB.refresh(); }; $('dtNo').onclick = closeSheet; });
  $('pfAdd').onclick = openAddScore;
  if ($('pfOut')) $('pfOut').onclick = e => { e.preventDefault(); sync.signOut(); };
  if ($('pfIn')) $('pfIn').onclick = () => sync.signIn();
  $('pfImport').onclick = openImport;
  if ($('pfUndoImp')) $('pfUndoImp').onclick = e => { e.preventDefault(); openSheet(`<h3>Undo last import?</h3><p class="rm">Removes the ${store.get(LS_LASTIMPORT, []).length} scores from your last import${sync.user ? ', including from your account' : ''}.</p><div class="rbtns"><button class="rb" id="uiYes" style="background:var(--flag);color:#fff;border-color:var(--flag)">Remove them</button><button class="rb ghost" id="uiNo">Cancel</button></div>`); $('uiYes').onclick = () => { closeSheet(); undoLastImport(); }; $('uiNo').onclick = closeSheet; };
  $('pfRatings').onclick = openRatings;
  if ($('pfAll')) $('pfAll').onclick = () => { profileShowAll = true; renderProfile(); };
  $('pfGender').onclick = () => { profile.gender = profile.gender === 'F' ? 'M' : 'F'; saveProfileLocal(); render(); };
  if ($('pfIn')) $('pfIn').onclick = e => { e.preventDefault(); sync.signIn(); };
  el.querySelectorAll('tr.go').forEach(tr => tr.onclick = () => { viewRoundId = tr.dataset.id; location.hash = 'card'; });
  el.querySelectorAll('tr.ext').forEach(tr => tr.onclick = () => {
    const p = data.posted.find(x => x.id === tr.dataset.id); if (!p) return;
    openSheet(`<h3>${esc(p.course || 'Score')}</h3><p class="rm">${esc(p.played_on.slice(0, 10))} · ${p.ags != null ? 'score ' + p.ags + ' · ' + p.course_rating + '/' + p.slope : 'differential ' + p.differential}</p><div class="rbtns"><button class="rb" id="pDel" style="background:var(--flag);color:#fff;border-color:var(--flag)">Delete this score</button><button class="rb ghost" id="pCancel">Cancel</button></div>`);
    $('pDel').onclick = () => { deletePosted(p); closeSheet(); render(); }; $('pCancel').onclick = closeSheet;
  });
}
function openAddScore() {
  const today = new Date().toISOString().slice(0, 10);
  openSheet(`<h3>Add a score</h3>
    <div class="seg3" style="display:flex;gap:6px;margin-bottom:10px"><button class="rb" data-m="score" aria-pressed="true">Score at a course</button><button class="rb" data-m="diff" aria-pressed="false">Differential from GHIN</button></div>
    <form id="asf" class="aform">
      <label>Date<input type="date" id="asDate" value="${today}" required></label>
      <label>Course<div id="asCoursePick"></div></label>
      <div class="mscore one">
        <div class="two"><label>Tee<select id="asTee"><option value="">Pick a course first</option></select></label>
        <label>Holes<select id="asHoles"><option value="18">18</option><option value="9">9</option></select></label></div>
        <label>Score<input id="asAgs" inputmode="numeric" placeholder="e.g. 88"></label>
        <p class="rm" id="asRtg"></p>
        <div id="asManual" hidden>
          <div class="three"><label id="asTeeNameL">Tee name<input id="asTeeName" placeholder="e.g. White"></label>
          <label>Rating<input id="asCr" inputmode="decimal" placeholder="70.4"></label>
          <label>Slope<input id="asSl" inputmode="numeric" placeholder="128"></label>
          <label>Par<input id="asPar" inputmode="numeric" value="72"></label></div>
          <p class="rm">From the scorecard or GHIN's course lookup. Enter the 18-hole numbers; it's saved to the course list so nobody has to type it again.</p>
        </div>
      </div>
      <div class="mdiff" hidden><label>Score Differential<input id="asDiff" inputmode="decimal" placeholder="e.g. 14.2"></label>
        <p class="rm">In the GHIN app, your score history shows the differential for each round.</p></div>
      <p class="rm" id="asErr" style="color:var(--flag)"></p>
      <div class="rbtns"><button class="rb main" type="submit">Add score</button></div>
    </form>`);
  let mode = 'score', course = null, manual = false;
  const sel = $('asTee');
  const showTee = () => {
    const holes = +$('asHoles').value, opt = sel.value;
    manual = !course || course.isNew || opt === '__other' || opt === '__edit' || !teesForGender(course).length;
    $('asManual').hidden = !manual || !course;
    $('asTeeNameL').hidden = !(course && (course.isNew || opt === '__other' || !teesForGender(course).length));
    if (!course) { $('asRtg').textContent = ''; return; }
    if (manual) { $('asRtg').textContent = course.isNew || !teesForGender(course).length ? 'New course: add its rating and slope once.' : ''; return; }
    const t = teeFor(teesForGender(course)[+opt], holes);
    $('asRtg').innerHTML = `Rating ${(+t.rating).toFixed(1)} · Slope ${t.slope} · Par ${t.par}${t.derived ? ' (9-hole, from the 18)' : ''} · <a href="#" id="asEdit">fix</a>`;
    $('asEdit').onclick = ev => { ev.preventDefault(); const raw = teesForGender(course)[+opt]; sel.insertAdjacentHTML('beforeend', '<option value="__edit">' + esc(raw.name) + ' (edited)</option>'); sel.value = '__edit'; $('asTeeName').value = raw.name; $('asCr').value = raw.rating; $('asSl').value = raw.slope; $('asPar').value = raw.par || 72; showTee(); };
  };
  coursePicker($('asCoursePick'), { onPick: c => {
    course = c;
    const tees = c ? teesForGender(c) : [];
    sel.innerHTML = c ? tees.map((t, i) => `<option value="${i}">${esc(t.name)}${t.yards ? ' · ' + t.yards + ' yds' : ''}</option>`).join('') + `<option value="__other">${tees.length ? 'Other tee…' : 'Enter tee'}</option>` : '<option value="">Pick a course first</option>';
    if (c && tees.length) { const want = (profile.lastTees || {})[c.id]; const i = tees.findIndex(t => t.name === want); sel.value = String(i >= 0 ? i : 0); }
    showTee();
  } });
  sel.onchange = showTee; $('asHoles').onchange = showTee;
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; document.querySelectorAll('[data-m]').forEach(x => x.setAttribute('aria-pressed', x.dataset.m === mode)); document.querySelector('.mscore').hidden = mode !== 'score'; document.querySelector('.mdiff').hidden = mode !== 'diff'; });
  $('asf').onsubmit = e => {
    e.preventDefault();
    const err = m => { $('asErr').textContent = m; };
    const date = $('asDate').value, courseName = (course && course.name) || document.querySelector('#asCoursePick .cp-in').value.trim();
    if (!date || !courseName) return err('Add a date and course.');
    const p = { id: uuid(), played_on: new Date(date + 'T12:00:00').toISOString(), course: courseName, course_id: null, tee: null, holes: 18, gross: null, ags: null, course_rating: null, slope: null, par: null, differential: null };
    if (mode === 'diff') {
      const d = parseFloat($('asDiff').value.replace('+', '-')); if (isNaN(d) || d < -10 || d > 80) return err('Enter the differential, like 14.2.');
      p.differential = d;
    } else {
      if (!course) return err('Pick the course from the list, or add it as a new course.');
      const ags = parseInt($('asAgs').value, 10), holes = +$('asHoles').value;
      if (!ags || ags < 25 || ags > 200) return err('Add your score.');
      let t, c = course;
      if (manual) {
        const cr = parseFloat($('asCr').value), sl = parseInt($('asSl').value, 10), par = parseInt($('asPar').value, 10) || 72;
        const tn = $('asTeeName').value.trim() || (sel.value === '__edit' ? teesForGender(course)[0].name : '');
        if (!cr || !sl) return err('Add the course rating and slope.');
        if (sl < 55 || sl > 155 || cr < 55 || cr > 80) return err('Use the 18-hole rating (usually 60–78) and slope (55–155).');
        c = saveUserCourse(course.name, { name: tn || 'Tee', rating: cr, slope: sl, par, holes: 18 }, course) || course;
        t = teeFor({ name: tn || 'Tee', rating: cr, slope: sl, par, holes: 18 }, holes);
      } else t = teeFor(teesForGender(course)[+sel.value], holes);
      profile.lastTees = Object.assign({}, profile.lastTees, { [c.id]: t.name }); store.set(LS_PROFILE, profile);
      Object.assign(p, { course: c.name, course_id: c.id && !/^(crown|tmp-)/.test(c.id) && (c.source !== 'user' || sync.user) ? c.id : null, tee: t.name, holes, ags, gross: ags, course_rating: t.rating, slope: t.slope, par: t.par });
    }
    upsertPosted(p); closeSheet(); render(); toast('Score added');
  };
}
function openRatings() {
  const g = profile.gender || 'M', tees = ['Black', 'Blue', 'Blue/White', 'White'];
  openSheet(`<h3>The Crown · ${g === 'F' ? "women's" : "men's"} ratings</h3><p class="rm">Match these to the course card or your GHIN app.</p>
    <form id="rtf" class="aform">${tees.map((t, i) => { const rs = ratingFor(t, g) || ['', '']; return `<div class="mscore"><label>${t} rating<input id="rc${i}" inputmode="decimal" value="${rs[0]}"></label><label>${t} slope<input id="rs${i}" inputmode="numeric" value="${rs[1]}"></label></div>`; }).join('')}
    <div class="rbtns"><button class="rb main" type="submit">Save</button><button class="rb ghost" type="button" id="rtReset">Reset to defaults</button></div></form>`);
  $('rtf').onsubmit = e => {
    e.preventDefault();
    profile.tee_ratings = profile.tee_ratings || {}; profile.tee_ratings[g] = {};
    tees.forEach((t, i) => { const c = parseFloat($('rc' + i).value), s = parseInt($('rs' + i).value, 10); if (c && s) profile.tee_ratings[g][t] = [c, s]; });
    saveProfileLocal(); closeSheet(); render();
  };
  $('rtReset').onclick = () => { if (profile.tee_ratings) delete profile.tee_ratings[g]; saveProfileLocal(); closeSheet(); render(); };
}



/* ------------------------------------------------------------------ course database (shared) */
const LS_COURSES = 'yb-courses-v1';
let courseCache = store.get(LS_COURSES, []), courseApiOff = false;
const STOP = /\b(the|golf|club|course|country|cc|gc|g\.c\.|resort|spa|and|links|at|of)\b/g;
const normName = s => String(s || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim();
function crownCourse() {
  const seed = courseCache.find(c => c.source_id === 'seed:the-crown');
  const tees = [];
  ['M', 'F'].forEach(g => ['Black', 'Blue', 'Blue/White', 'White'].forEach(t => { const rs = ratingFor(t, g); if (rs) tees.push({ name: t, gender: g, rating: rs[0], slope: rs[1], par: 72, holes: 18 }); }));
  return { id: seed ? seed.id : 'crown', name: 'The Crown Golf Club', city: 'Traverse City', state: 'MI', tees, source: 'seed', source_id: 'seed:the-crown' };
}
function allCourses() { return [crownCourse()].concat(courseCache.filter(c => c.source_id !== 'seed:the-crown')); }
function cacheCourses(list) {
  const m = new Map(courseCache.map(c => [c.id, c]));
  (list || []).forEach(c => { if (c && c.id) m.set(c.id, c); });
  courseCache = [...m.values()].slice(-400); store.set(LS_COURSES, courseCache);
}
function matchScore(q, c) {
  const a = normName(q), b = normName(c.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.85;
  const ta = a.split(' '), tb = new Set(b.split(' '));
  return ta.filter(t => tb.has(t)).length / Math.max(ta.length, tb.size) * 0.8;
}
const courseLabel = c => c.name + (c.city ? ` · ${c.city}${c.state ? ', ' + c.state : ''}` : '');
async function searchCourses(q, opts = {}) {
  q = String(q || '').trim();
  const rank = () => allCourses().map(c => [c, matchScore(q, c)]).filter(x => x[1] >= 0.4).sort((a, b) => b[1] - a[1]);
  if (q.length < 3) return rank();
  if (sync.enabled) {
    // look in the shared table by the most distinctive word, then rank here
    const word = normName(q).split(' ').sort((a, b) => b.length - a.length)[0] || q;
    try { const { data, error } = await sync.client.from('courses').select('*').ilike('name', '%' + word.replace(/[%_]/g, '') + '%').limit(25); if (!error) cacheCourses(data); } catch (e) { /* offline */ }
  }
  let r = rank();
  if ((!r.length || r[0][1] < 0.85) && opts.lookup !== false && sync.user && !courseApiOff) {
    try {
      const { data, error } = await sync.client.functions.invoke('course-lookup', { body: { q } });
      if (error) { const st = error.context && error.context.status; if (!st || st === 404 || st === 501 || st === 429) courseApiOff = true; }
      else if (data && data.courses) { cacheCourses(data.courses.filter(c => c.id)); if (data.courses.some(c => !c.id)) courseCache.push(...data.courses.filter(c => !c.id).map(c => Object.assign({ id: 'tmp-' + uuid() }, c))); }
    } catch (e) { courseApiOff = true; }
    r = rank();
  }
  return r;
}
function pickTee(course, teeName, gender, holes) {
  if (!course || !course.tees || !course.tees.length) return null;
  const g = gender || profile.gender || 'M', n = String(teeName || '').toLowerCase().trim();
  let pool = course.tees.filter(t => t.gender === g); if (!pool.length) pool = course.tees;
  let t = n ? (pool.find(x => x.name.toLowerCase() === n) || pool.find(x => x.name.toLowerCase().startsWith(n) || n.startsWith(x.name.toLowerCase()))) : null;
  if (!t) return null;
  return teeFor(t, holes);
}
// ratings for the holes actually played (9-hole round on an 18-hole rating: half the rating and par, same slope)
function teeFor(t, holes) {
  const full = t.holes !== 9;
  if (holes === 9 && full) return { name: t.name, rating: Math.round(t.rating * 5) / 10, slope: t.slope, par: Math.round((t.par || 72) / 2), derived: true };
  return { name: t.name, rating: +t.rating, slope: +t.slope, par: t.par || (holes === 9 ? 36 : 72) };
}
function teesForGender(course) { const g = profile.gender || 'M'; const p = (course.tees || []).filter(t => t.gender === g); return p.length ? p : (course.tees || []); }
// save a course/tee a golfer typed in, so nobody has to type it again
function saveUserCourse(name, tee, existing) {
  name = String(name || '').trim(); if (!name || !tee || !tee.rating || !tee.slope) return null;
  const row = { name, gender: profile.gender || 'M', rating: +tee.rating, slope: +tee.slope, par: tee.par || 72, holes: tee.holes || 18 };
  row.name = (tee.name || 'Tee').trim();
  let c = existing && existing.source === 'user' && (!existing.created_by || (sync.user && existing.created_by === sync.user.id)) ? existing
    : courseCache.find(x => x.source === 'user' && normName(x.name) === normName(name) && (!x.created_by || (sync.user && x.created_by === sync.user.id)));
  if (!c) c = { id: uuid(), name, city: null, state: null, country: null, tees: [], source: 'user', updated_at: nowIso() };
  c = Object.assign({}, c, { tees: (c.tees || []).filter(t => !(t.name.toLowerCase() === row.name.toLowerCase() && t.gender === row.gender && (t.holes || 18) === row.holes)).concat([row]), updated_at: nowIso() });
  cacheCourses([c]);
  if (sync.user) queue('courses', 'upsert', courseRow(c));
  return c;
}
const courseRow = c => ({ id: c.id, name: c.name, city: c.city || null, state: c.state || null, country: c.country || null, tees: c.tees, source: 'user', updated_at: c.updated_at });

/* course search box: type, pick from the list, or add a new course */
function coursePicker(host, { value = '', onPick }) {
  host.innerHTML = `<div class="cp"><input class="cp-in" placeholder="Search for a course" autocomplete="off" value="${esc(value)}"><div class="cp-list" hidden></div></div>`;
  const inp = host.querySelector('.cp-in'), list = host.querySelector('.cp-list');
  let t = null, seq = 0;
  const show = async () => {
    const q = inp.value.trim(), my = ++seq;
    if (q.length < 2) { list.hidden = true; return; }
    list.hidden = false; list.innerHTML = `<div class="cp-st">Searching…</div>`;
    const r = await searchCourses(q);
    if (my !== seq) return;
    list.innerHTML = r.slice(0, 6).map(([c], i) => `<button type="button" data-i="${i}"><b>${esc(c.name)}</b><small>${esc([c.city, c.state].filter(Boolean).join(', '))}${c.tees && c.tees.length ? ' · ' + teesForGender(c).length + ' tees' : ''}</small></button>`).join('')
      + `<button type="button" data-new="1" class="cp-new">+ Add “${esc(q)}” as a new course</button>`;
    list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const c = r[+b.dataset.i][0]; inp.value = c.name; list.hidden = true; onPick(c); });
    list.querySelector('[data-new]').onclick = () => { list.hidden = true; onPick({ id: null, name: q, tees: [], isNew: true }); };
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(show, 300); onPick(null); };
  inp.onfocus = () => { if (inp.value.trim().length >= 2 && list.hidden) show(); };
  return inp;
}

/* ------------------------------------------------------------------ bulk import */
const LS_LASTIMPORT = 'yb-last-import';
function savedCourses() { return (profile.tee_ratings && profile.tee_ratings._courses) || {}; }
function rememberCourse(key, v) { profile.tee_ratings = profile.tee_ratings || {}; profile.tee_ratings._courses = Object.assign({}, savedCourses(), { [key]: v }); }
function knownRating(course, tee) {
  const k = YBImport.courseKey(course, tee), sc = savedCourses();
  if (sc[k]) return sc[k];
  if (/crown/i.test(course || '') && tee) { const rs = ratingFor(tee.replace(/\b\w/g, c => c.toUpperCase())); if (rs) return { rating: rs[0], slope: rs[1], par: 72 }; }
  const anyTee = Object.keys(sc).find(x => x.split('|')[0] === YBImport.courseKey(course, '').split('|')[0]);
  return anyTee && !tee ? sc[anyTee] : null;
}
const FIELD_LABELS = { date: 'Date', course: 'Course', tee: 'Tee', score: 'Score', holes: 'Holes', rating: 'Rating', slope: 'Slope', par: 'Par', diff: 'Differential' };
let imp = null;   // import session state

function openImport() {
  imp = { rows: null, header: null, map: null, items: null, src: null };
  openSheet(`<h3>Import scores</h3>
    <p class="rm">Bring in your history from another app or a spreadsheet. Each row needs a date and a score (or a Score Differential from GHIN). You'll add each course's rating and slope once.</p>
    <div class="impsrc">
      <label class="rb impfile">Upload a CSV file<input type="file" id="impFile" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>
      <button class="rb" id="impPasteBtn">Paste rows</button>
      <button class="rb" id="impTypeBtn">Type them in</button>
    </div>
    <p class="rm"><b>18Birdies</b> doesn't export scores, so open Rounds Played and type them in here (or copy them into a spreadsheet first and paste). <b>GHIN</b> users can paste their score history with the differential column.</p>`);
  $('impFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => fromText(String(rd.result), 'file'); rd.readAsText(f); };
  $('impPasteBtn').onclick = openPaste;
  $('impTypeBtn').onclick = () => openGrid([]);
}
function openPaste() {
  openSheet(`<h3>Paste rows</h3><p class="rm">Copy rows from a spreadsheet, notes or a GHIN score list. One round per line, e.g.<br><code>6/14/2025, Elmbrook, White, 88</code></p>
    <textarea id="impText" rows="10" style="width:100%;font:14px/1.4 ui-monospace,monospace;padding:10px;border:1px solid var(--rule);border-radius:8px" placeholder="Date, Course, Tee, Score"></textarea>
    <div class="rbtns"><button class="rb ghost" id="impBack">Back</button><button class="rb main" id="impGo">Continue</button></div>`);
  $('impBack').onclick = openImport;
  $('impGo').onclick = () => { const t = $('impText').value; if (t.trim()) fromText(t, 'paste'); };
}
function openGrid(prefill) {
  const courses = Array.from(new Set(data.posted.map(p => p.course).filter(Boolean).concat(allCourses().map(c => c.name)))).slice(0, 80);
  const rowHtml = (r = {}) => `<tr><td><input type="date" class="g-date" value="${r.date ? r.date.slice(0, 10) : ''}"></td><td><input class="g-course" list="impCourses" value="${esc(r.course || '')}" placeholder="Course"></td><td><input class="g-tee" value="${esc(r.tee || '')}" placeholder="Tee"></td><td><input class="g-score" inputmode="numeric" value="${r.score ?? ''}" placeholder="88"></td><td><select class="g-holes"><option ${r.holes === 9 ? '' : 'selected'}>18</option><option ${r.holes === 9 ? 'selected' : ''}>9</option></select></td></tr>`;
  openSheet(`<h3>Type in scores</h3><p class="rm">Course names fill in as you type. Leave a row blank to skip it.</p>
    <datalist id="impCourses">${courses.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="cardview"><table class="pt grid"><thead><tr><th>Date</th><th>Course</th><th>Tee</th><th>Score</th><th>Holes</th></tr></thead><tbody id="impGridBody">${(prefill.length ? prefill : Array(8).fill({})).map(rowHtml).join('')}</tbody></table></div>
    <div class="rbtns"><button class="rb ghost" id="impMore">+ 10 rows</button><button class="rb ghost" id="impBack">Back</button><button class="rb main" id="impGo">Continue</button></div>`);
  $('impMore').onclick = () => $('impGridBody').insertAdjacentHTML('beforeend', Array(10).fill(0).map(() => rowHtml()).join(''));
  $('impBack').onclick = openImport;
  // carry the course/tee down to the next empty row to save typing
  $('impGridBody').addEventListener('change', e => {
    const tr = e.target.closest('tr'), nx = tr && tr.nextElementSibling;
    if (!nx) return;
    if (e.target.classList.contains('g-course') && !nx.querySelector('.g-course').value) nx.querySelector('.g-course').placeholder = e.target.value || 'Course';
  });
  $('impGo').onclick = () => {
    const rows = [];
    let lastCourse = '', lastTee = '';
    $('impGridBody').querySelectorAll('tr').forEach(tr => {
      const d = tr.querySelector('.g-date').value, c = tr.querySelector('.g-course').value.trim() || '', t = tr.querySelector('.g-tee').value.trim(), s = tr.querySelector('.g-score').value.trim(), h = tr.querySelector('.g-holes').value;
      if (!d && !s) return;
      rows.push([d, c || lastCourse, t || (c ? '' : lastTee), s, h]);
      if (c) lastCourse = c; if (t) lastTee = t;
    });
    if (!rows.length) return;
    imp.src = 'grid'; imp.rows = rows; imp.header = ['Date', 'Course', 'Tee', 'Score', 'Holes'];
    imp.map = { date: 0, course: 1, tee: 2, score: 3, holes: 4 };
    review();
  };
}
function fromText(text, src) {
  const rows = YBImport.parseCSV(text);
  if (!rows.length) { toast('Nothing to import in that text'); return; }
  const hasHeader = YBImport.looksLikeHeader(rows[0]);
  imp.src = src;
  imp.header = hasHeader ? rows[0] : rows[0].map((_, i) => 'Column ' + (i + 1));
  imp.rows = hasHeader ? rows.slice(1) : rows;
  imp.map = hasHeader ? YBImport.guessMapping(rows[0]) : YBImport.inferMapping(imp.rows);
  review();
}
function dupKey(date, course, score, diff) { return (date || '').slice(0, 10) + '|' + (course || '').toLowerCase().trim() + '|' + (score ?? '') + '|' + (diff ?? ''); }
function review() {
  imp.items = YBImport.normalize(imp.rows, imp.map);
  const existing = new Set(data.posted.map(p => dupKey(p.played_on, p.course, p.ags, p.ags == null ? p.differential : null)));
  const seen = new Set();
  imp.items.forEach(it => {
    const k = dupKey(it.date, it.course, it.diff == null ? it.score : null, it.diff);
    it.dup = existing.has(k) || seen.has(k); seen.add(k);
  });
  const ok = imp.items.filter(i => !i.errors.length && !i.dup), bad = imp.items.filter(i => i.errors.length), dups = imp.items.filter(i => i.dup && !i.errors.length);
  const cols = imp.header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
  const mapUI = imp.src === 'grid' ? '' : `<details ${imp.map.date == null || (imp.map.score == null && imp.map.diff == null) ? 'open' : ''}><summary class="rm" style="cursor:pointer">Columns: ${Object.keys(FIELD_LABELS).filter(f => imp.map[f] != null).map(f => FIELD_LABELS[f] + ' → ' + esc(imp.header[imp.map[f]])).join(', ') || 'not detected'} · change</summary>
    <div class="aform" style="grid-template-columns:1fr 1fr;display:grid;margin-top:8px">${Object.keys(FIELD_LABELS).map(f => `<label>${FIELD_LABELS[f]}<select data-map="${f}"><option value="">(none)</option>${cols}</select></label>`).join('')}</div></details>`;
  const fmt = it => `<tr class="${it.errors.length ? 'bad' : it.dup ? 'dup' : ''}"><td style="white-space:nowrap">${it.date ? new Date(it.date).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' }) : '?'}</td><td>${esc(it.course || '')}${it.tee ? '<small> · ' + esc(it.tee) + '</small>' : ''}</td><td>${it.diff != null ? 'diff ' + it.diff : (it.score ?? '–')}${it.holes === 9 ? '<small> · 9</small>' : ''}</td><td><small>${it.errors.join(', ') || (it.dup ? 'already imported' : '')}</small></td></tr>`;
  const preview = imp.items.slice(0, 6).concat(bad.filter(b => imp.items.indexOf(b) >= 6).slice(0, 4));
  openSheet(`<h3>Review · ${imp.items.length} row${imp.items.length === 1 ? '' : 's'}</h3>
    <p class="rm"><b style="color:var(--ink)">${ok.length} ready</b>${bad.length ? ` · ${bad.length} with problems (skipped)` : ''}${dups.length ? ` · ${dups.length} already imported (skipped)` : ''}</p>
    ${mapUI}
    <div class="cardview"><table class="pt imprev"><tbody>${preview.map(fmt).join('')}</tbody></table></div>
    ${imp.items.length > preview.length ? `<p class="rm">…and ${imp.items.length - preview.length} more</p>` : ''}
    <div class="rbtns"><button class="rb ghost" id="impBack">Back</button><button class="rb main" id="impNext" ${ok.length ? '' : 'disabled'}>Next: course ratings</button></div>`);
  document.querySelectorAll('[data-map]').forEach(sel => { const f = sel.dataset.map; sel.value = imp.map[f] != null ? String(imp.map[f]) : ''; sel.onchange = () => { if (sel.value === '') delete imp.map[f]; else imp.map[f] = +sel.value; review(); }; });
  $('impBack').onclick = () => imp.src === 'grid' ? openGrid(imp.items) : imp.src === 'paste' ? openPaste() : openImport();
  $('impNext').onclick = ratingsStep;
}
async function ratingsStep() {
  const ready = imp.items.filter(i => !i.errors.length && !i.dup);
  const groups = new Map();
  ready.filter(i => i.diff == null && (i.rating == null || i.slope == null)).forEach(i => {
    const k = YBImport.courseKey(i.course, i.tee) + '|' + i.holes;
    if (!groups.has(k)) groups.set(k, { course: i.course, tee: i.tee, holes: i.holes, n: 0 });
    groups.get(k).n++;
  });
  if (!groups.size) return doImport({});
  // look each course up once: shared course list first, then the course database lookup
  const names = [...new Set([...groups.values()].map(g => g.course || ''))].filter(Boolean);
  openSheet(`<h3>Course ratings</h3><p class="rm" id="lkSt">Looking up ${names.length} course${names.length === 1 ? '' : 's'}…</p>`);
  const found = {};
  for (let i = 0; i < names.length; i++) {
    if ($('lkSt')) $('lkSt').textContent = `Looking up courses… ${i + 1} of ${names.length}`;
    const res = await searchCourses(names[i]);
    if (res.length && res[0][1] >= 0.8) found[names[i]] = res[0][0];
  }
  if (!imp) return;   // sheet closed while looking up
  const gs = [...groups.entries()].sort((a, b) => (b[1].holes - a[1].holes) || (b[1].n - a[1].n));
  gs.forEach(([, g]) => {
    g.match = found[g.course || ''] || null;
    g.tee18 = g.match ? pickTee(g.match, g.tee, null, 18) : null;
    g.auto = g.match ? pickTee(g.match, g.tee, null, g.holes) : null;
    if (!g.auto) { const kn = knownRating(g.course, g.tee); if (kn) { g.auto = teeFor({ name: g.tee || 'Tee', rating: kn.rating, slope: kn.slope, par: kn.par, holes: 18 }, g.holes); g.saved = true; } }
  });
  const nAuto = gs.filter(([, g]) => g.auto).length;
  openSheet(`<h3>Course ratings</h3>
    <p class="rm">${nAuto === gs.length ? 'Found every course. Check the numbers look right, then import.' : nAuto ? `Found ${nAuto} of ${gs.length}. Add rating and slope for the rest once and they're saved to the course list for next time.` : `Add each course's rating and slope once (scorecard or GHIN course lookup). They're saved to the course list for next time.`}${gs.some(([, g]) => g.holes === 9) ? ' 9-hole rows left blank use half the 18-hole rating.' : ''}</p>
    <form id="rtgForm" class="aform">${gs.map(([k, g], i) => {
      const a = g.auto, src = a ? (g.saved ? 'saved earlier' : g.match.source === 'golfcourseapi' ? 'course database' : g.match.source === 'seed' ? 'built in' : 'course list') : '';
      return `<div class="crow ${a ? 'auto' : ''}"><div class="cname"><b>${esc(g.course || 'Unnamed course')}</b>${g.tee ? ' · ' + esc(g.tee) : ''}${g.holes === 9 ? ' · 9 holes' : ''}<br><small class="rm">${g.n} round${g.n === 1 ? '' : 's'}${a ? ` · ✓ ${esc(g.match && !g.saved ? g.match.name + ' ' : '')}${esc(a.name || '')} (${src}${a.derived ? ', half of 18' : ''})` : g.match && !g.tee18 ? ` · ${esc(g.match.name)} found, but no “${esc(g.tee || '')}” tee` : ''}</small></div>
        <label>Rating<input id="cr${i}" inputmode="decimal" value="${a ? (+a.rating).toFixed(1) : ''}" placeholder="${g.holes === 9 ? '35.4' : '70.8'}"></label>
        <label>Slope<input id="cs${i}" inputmode="numeric" value="${a ? a.slope : ''}" placeholder="125"></label>
        <label>Par<input id="cp${i}" inputmode="numeric" value="${a ? a.par : (g.holes === 9 ? 36 : 72)}"></label></div>`; }).join('')}
      <p class="rm" id="rtgErr" style="color:var(--flag)"></p>
      <div class="rbtns"><button class="rb ghost" type="button" id="impBack">Back</button><button class="rb main" type="submit">Import</button></div></form>`);
  $('impBack').onclick = review;
  $('rtgForm').onsubmit = e => {
    e.preventDefault();
    const rmap = {};
    for (let i = 0; i < gs.length; i++) {
      const [k, g] = gs[i]; const cr = parseFloat($('cr' + i).value), sl = parseInt($('cs' + i).value, 10), par = parseInt($('cp' + i).value, 10) || (g.holes === 9 ? 36 : 72);
      if (!cr && !sl) {
        if (g.holes === 9) { const full = rmap[YBImport.courseKey(g.course, g.tee) + '|18']; if (full) rmap[k] = Object.assign(teeFor({ name: g.tee, rating: full.rating, slope: full.slope, par: full.par, holes: 18 }, 9), { course: full.course }); }
        continue;
      }
      if (!cr || !sl || sl < 55 || sl > 155 || (g.holes === 18 && (cr < 55 || cr > 80)) || (g.holes === 9 && (cr < 27 || cr > 40))) { $('rtgErr').textContent = `Check the rating and slope for ${g.course || 'that course'}.`; return; }
      let course = g.match;
      const changed = !g.auto || Math.abs(g.auto.rating - cr) > .05 || g.auto.slope !== sl;
      if (changed && g.holes === 18 && g.course) course = saveUserCourse(g.course, { name: g.tee || 'Tee', rating: cr, slope: sl, par, holes: 18 }, g.match && g.match.source === 'user' ? g.match : null) || course;
      rmap[k] = { rating: cr, slope: sl, par, course };
      if (g.holes === 18) rememberCourse(YBImport.courseKey(g.course, g.tee), { rating: cr, slope: sl, par });
    }
    doImport(rmap);
  };
}
function doImport(rmap) {
  const ready = imp.items.filter(i => !i.errors.length && !i.dup);
  const ids = []; let skipped = 0;
  ready.forEach(i => {
    const p = { id: uuid(), played_on: i.date, course: i.course, tee: i.tee, holes: i.holes, gross: null, ags: null, course_rating: null, slope: null, par: null, differential: null };
    if (i.diff != null) p.differential = i.diff;
    else {
      const r = (i.rating != null && i.slope != null) ? { rating: i.rating, slope: i.slope, par: i.par || (i.holes === 9 ? 36 : 72) } : rmap[YBImport.courseKey(i.course, i.tee) + '|' + i.holes];
      if (!r) { skipped++; return; }
      Object.assign(p, { gross: i.score, ags: i.score, course_rating: r.rating, slope: r.slope, par: r.par });
      const c = r.course; if (c && c.id && !/^(crown|tmp-)/.test(c.id) && (c.source !== 'user' || sync.user)) p.course_id = c.id;
    }
    p.updated_at = nowIso(); data.posted.push(p); outbox.push({ table: 'posted_scores', op: 'upsert', row: p }); ids.push(p.id);
  });
  save(); store.set(LS_OUTBOX, outbox); store.set(LS_LASTIMPORT, ids);
  saveProfileLocal(); sync.flushSoon();
  closeSheet(); imp = null;
  location.hash = 'profile'; render();
  const h = hcCache || handicap();
  toast(`Imported ${ids.length} score${ids.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (no rating)` : ''}${h && h.index != null ? ` · Index ${fmtIx(h.index)}` : ''}`);
}
function undoLastImport() {
  const ids = new Set(store.get(LS_LASTIMPORT, []));
  if (!ids.size) return;
  data.posted.filter(p => ids.has(p.id)).forEach(p => queue('posted_scores', 'delete', { id: p.id }));
  data.posted = data.posted.filter(p => !ids.has(p.id)); save(); store.set(LS_LASTIMPORT, []);
  render(); toast(`Removed ${ids.size} imported scores`);
}

/* ------------------------------------------------------------------ wiring */
function render() { hcCache = null; renderAcct(); renderBar(); renderMyCard(); renderProfile(); renderPastBtn(); }
function boot() {
  if (!window.YB) return setTimeout(boot, 50);
  G = geoFns();
  ensureChrome();
  YB.hooks.draw2d = (ctx, toScr, dpr) => { drawPast2d(ctx, toScr, dpr); draw2dOverlay(ctx, toScr, dpr); };
  YB.hooks.build3d = (g, THREE, toV) => { buildPast3d(g, THREE, toV); build3dOverlay(g, THREE, toV); };
  YB.hooks.tap = (e, n) => {
    if (!pending) return false;
    const p = pending; pending = null;
    if (p.kind === 'ongreen') p.place([e, n], 'map'); else recordShot(p.club, [e, n], 'map');
    return true;
  };
  window.addEventListener('hashchange', () => { closeSheet(); render(); });
  if (activeRound()) startGPS();
  render();
  sync.init();
  // keep the GPS dot moving on the hole map
  setInterval(() => { if (activeRound() && gps.fix && !/^#card$/.test(location.hash)) YB.refresh2d(); }, 4000);
}
boot();
})();
