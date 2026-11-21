// Mobile v2: menu bawah berikon, animasi angka, transisi halaman. Murni tampilan — tidak menyentuh data.
(function () {
  'use strict';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ICONS = {
    order: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    cari: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
    dash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>',
    produk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.2v9.6L12 21l-8-4.2V7.2z"/><path d="M4 7.2l8 4.3 8-4.3M12 11.5V21"/></svg>',
    biaya: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5L5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>',
    iklan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4a1 1 0 0 0 1 1h2.5l7 4V5l-7 4H5a1 1 0 0 0-1 1z"/><path d="M18.5 9.5a4 4 0 0 1 0 5"/></svg>'
  };
  var ITEMS = [
    ['order.html', 'Order', 'order'], ['popup.html', 'Cari', 'cari'], ['report.html', 'Dashboard', 'dash'],
    ['products.html', 'Produk', 'produk'], ['fees.html', 'Biaya', 'biaya'], ['ads.html', 'Iklan', 'iklan']
  ];

  function mountNav() {
    var nav = document.querySelector('.bnav');
    if (!nav) { nav = document.createElement('nav'); nav.className = 'bnav'; document.body.appendChild(nav); }
    nav.setAttribute('aria-label', 'Menu');
    var cur = (location.pathname.split('/').pop() || 'order.html');
    nav.innerHTML = ITEMS.map(function (it) {
      var on = it[0] === cur;
      return '<a href="' + it[0] + '"' + (on ? ' class="on" aria-current="page"' : '') + '><span class="ic">' + ICONS[it[2]] + '</span><span>' + it[1] + '</span></a>';
    }).join('');
    // transisi keluar halus sebelum pindah halaman
    nav.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a'); if (!a || reduce || a.classList.contains('on')) return;
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      document.documentElement.classList.add('leaving');
      setTimeout(function () { location.href = a.getAttribute('href'); }, 150);
    });
    window.addEventListener('pageshow', function () { document.documentElement.classList.remove('leaving'); });
  }

  // ----- Angka berhitung naik saat berubah (ringkasan Input Order) -----
  function parse(t) {
    var m = /^(-?)(Rp\s?)?(-?)([\d.]+)$/.exec((t || '').trim()); if (!m) return null;
    var digits = m[4].replace(/\./g, ''); if (!/^\d+$/.test(digits)) return null;
    return { v: (m[1] || m[3] ? -1 : 1) * Number(digits), rp: !!m[2] };
  }
  function fmt(v, rp) {
    var s = Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (v < 0 ? '-' : '') + (rp ? 'Rp ' : '') + s;
  }
  function watch(id) {
    var el = document.getElementById(id); if (!el || reduce) return;
    var last = parse(el.textContent), tok = 0;
    new MutationObserver(function () {
      var cur = el.textContent;
      if (cur === el._w) return;                         // tulisan animasi sendiri
      var nv = parse(cur); if (!nv) { last = null; return; }
      var from = last ? last.v : 0, to = nv.v; last = nv;
      if (from === to) return;
      var my = ++tok, t0 = performance.now(), dur = Math.min(700, 280 + Math.abs(to - from) / 800);
      el.classList.add('tick');
      (function step(now) {
        if (my !== tok) return;
        var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el._w = p >= 1 ? cur : fmt(from + (to - from) * e, nv.rp);
        el.textContent = el._w;
        if (p < 1) requestAnimationFrame(step); else setTimeout(function () { el.classList.remove('tick'); }, 300);
      })(t0);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  // Saat keyboard terbuka: sembunyikan menu bawah agar layar tidak sesak
  var kbT;
  document.addEventListener('focusin', function (e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'radio') { clearTimeout(kbT); document.documentElement.classList.add('kb'); }
  });
  document.addEventListener('focusout', function () { clearTimeout(kbT); kbT = setTimeout(function () { document.documentElement.classList.remove('kb'); }, 120); });

  function mount() {
    mountNav();
    ['tdOrders', 'tdRev', 'tdProfit', 'tRev', 'tCost', 'tProfit'].forEach(watch);
    // warna status bar mengikuti tema
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.content = getComputedStyle(document.documentElement).getPropertyValue('--bg-soft').trim() || '#f2f5f6';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
