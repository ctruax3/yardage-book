/* Phone app shell: tab bar, tee picker, pull-up hole drawer. Desktop layout ignores these. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const TEES = [['Black', '#1b1b1b'], ['Blue', '#2f5fb3'], ['Blue/White', 'linear-gradient(90deg,#2f5fb3 50%,#fff 50%)'], ['White', '#ffffff']];

  function boot() {
    if (!window.YB || !$('tees') || !$('tees').children.length) return setTimeout(boot, 60);

    /* tee picker: a native select on top of the chip, so phones show their own picker */
    const sel = $('teeSel');
    sel.innerHTML = TEES.map(([t]) => `<option>${t}</option>`).join('');
    const syncTee = () => { const t = YB.tee(); sel.value = t; $('teeName').textContent = t; $('teeDot').style.background = (TEES.find(x => x[0] === t) || TEES[1])[1]; };
    sel.onchange = () => { const b = document.querySelector(`#tees [data-t="${sel.value}"]`); if (b) b.click(); syncTee(); };
    new MutationObserver(syncTee).observe($('tees'), { childList: true, subtree: true, attributes: true });
    syncTee();
    // put the chip first in the header row
    const head = document.querySelector('header.top'); head.insertBefore($('teeChip'), head.firstChild);

    /* hole drawer: tap or swipe the handle / hole header */
    const panel = $('panel'), grab = $('grab');
    function openDrawer() { panel.classList.add('open'); grab.setAttribute('aria-expanded', 'true'); }
    function closeDrawer() { panel.classList.remove('open'); grab.setAttribute('aria-expanded', 'false'); panel.scrollTop = 0; }
    window.YBShell = { openDrawer, closeDrawer };
    const toggle = () => panel.classList.contains('open') ? closeDrawer() : openDrawer();
    grab.onclick = toggle;
    const head1 = panel.querySelector('.holehead'); if (head1) { head1.style.cursor = 'pointer'; head1.addEventListener('click', () => { if (matchMedia('(max-width:899px)').matches) toggle(); }); }
    let y0 = null;
    panel.addEventListener('touchstart', e => { y0 = (panel.scrollTop <= 0) ? e.touches[0].clientY : null; }, { passive: true });
    panel.addEventListener('touchend', e => {
      if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
      if (dy < -30 && !panel.classList.contains('open')) openDrawer(); else if (dy > 40 && panel.classList.contains('open')) closeDrawer();
    }, { passive: true });

    /* tab bar */
    const view = () => /^#card$/.test(location.hash) ? 'card' : /^#profile$/.test(location.hash) ? 'profile' : 'hole';
    let lastHole = (location.hash.match(/^#hole-(\d+)$/) || [])[1] || String(YB.cur());
    const route = () => {
      const v = view(); document.body.dataset.view = v;
      if (v === 'hole') lastHole = String(YB.cur());
      $('tabbar').querySelectorAll('button').forEach(b => b.setAttribute('aria-current', String(b.dataset.go === v)));
      closeDrawer();
      const sc = v === 'card' ? $('cardView') : v === 'profile' ? $('profileView') : null; if (sc) sc.scrollTop = 0;
    };
    $('tabbar').querySelectorAll('button').forEach(b => b.onclick = () => {
      const go = b.dataset.go;
      if (go === 'hole') location.hash = 'hole-' + lastHole; else location.hash = go;
    });
    window.addEventListener('hashchange', route); route();
    // red dot on Scorecard during a round
    const live = () => { const on = !!document.querySelector('#rAcct #rEnd'); const b = $('tabbar').querySelector('[data-go="card"]'); let d = b.querySelector('.live'); if (on && !d) { d = document.createElement('i'); d.className = 'live'; b.insertBefore(d, b.firstChild); } else if (!on && d) d.remove(); };
    const acct = $('rAcct'); if (acct) new MutationObserver(live).observe(acct, { childList: true, subtree: true }); live();

  }
  boot();

  /* offline support + home-screen install */
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
