// Polish v1.30: animasi angka (count-up) & gambar grafik. Murni tampilan — tidak menyentuh data.
(function () {
  'use strict';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');
  var fmt = new Intl.NumberFormat('id-ID');
  var prev = Object.create(null);

  // Cari angka bulat berformat id-ID ("Rp 1.234.567", "-Rp 5.000", "12") pada teks; teks berkoma/desimal dilewati.
  function parse(text) {
    if (text.indexOf(',') >= 0) return null;
    var m = text.match(/\d{1,3}(?:\.\d{3})+|\d+/);
    if (!m) return null;
    return { s: m[0], n: parseInt(m[0].replace(/\./g, ''), 10), i: m.index };
  }
  // Animasi angka. el._w = teks terakhir yang DITULIS animasi (untuk membedakan perubahan asli dari tulisan animasi sendiri),
  // el._tok = penanda animasi aktif (animasi lama berhenti bila ada yang baru).
  function countUp(el, key) {
    var text = el.textContent, p = parse(text);
    el._tok = (el._tok || 0) + 1;
    var tok = el._tok;
    if (!p || !isFinite(p.n)) { el._w = text; return; }
    var from = prev[key] == null ? 0 : prev[key];
    prev[key] = p.n;
    el._w = text;
    if (reduce.matches || from === p.n) return;
    var head = text.slice(0, p.i), tail = text.slice(p.i + p.s.length);
    var dur = 650, t0 = performance.now();
    (function step(now) {
      if (!el.isConnected || el._tok !== tok) return;     // diganti render / animasi baru
      var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el._w = k >= 1 ? text : head + fmt.format(Math.round(from + (p.n - from) * e)) + tail;
      el.textContent = el._w;
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  // Setelah adegan pembuka selesai, render ulang (filter, pencarian) tidak mengulang animasi masuk.
  setTimeout(function () { document.documentElement.setAttribute('data-ready', ''); }, 1500);

  // ----- Dashboard: KPI -----
  var kpis = document.getElementById('kpis');
  if (kpis) {
    new MutationObserver(function () {
      var cards = kpis.querySelectorAll('.kpi:not(.skel)');
      if (!cards.length) return;
      var seen = kpis.hasAttribute('data-seen');
      cards.forEach(function (c, i) {
        c.style.setProperty('--i', i);
        var s = c.querySelector('strong');
        if (s) countUp(s, 'k' + i);
      });
      if (!seen) setTimeout(function () { kpis.setAttribute('data-seen', ''); }, 900);
    }).observe(kpis, { childList: true });
  }

  // ----- Dashboard: grafik tren -----
  var trend = document.getElementById('trend');
  if (trend) {
    var lastSig = '';
    new MutationObserver(function () {
      var svg = trend.querySelector('svg');
      if (!svg) return;
      // Tanda tangan: skala sumbu-Y + jumlah batang. Berubah saat data/periode berganti, tidak saat jendela diubah ukurannya.
      var sig = Array.prototype.map.call(svg.querySelectorAll('.grid text'), function (t) { return t.textContent; }).join('|')
        + '#' + svg.querySelectorAll('.hit').length + '#' + svg.querySelectorAll('rect.bar').length + '#' + !!svg.querySelector('.line');
      if (sig === lastSig) return;
      lastSig = sig;
      if (reduce.matches) return;
      svg.querySelectorAll('rect.bar').forEach(function (r, i) { r.style.setProperty('--i', Math.min(i, 40)); });
      svg.querySelectorAll('circle.dot').forEach(function (r, i) { r.style.setProperty('--i', Math.min(i, 40)); });
      var line = svg.querySelector('polyline.line');
      if (line) line.setAttribute('pathLength', '1');
      trend.classList.remove('draw'); void trend.offsetWidth; trend.classList.add('draw');
      setTimeout(function () { trend.classList.remove('draw'); }, 2200);
    }).observe(trend, { childList: true });
  }

  // ----- Pop-up: angka ringkasan berdenyut saat berubah -----
  ['todayRevenue', 'todayProfit', 'monthProfit'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el || !document.getElementById('form')) return;
    new MutationObserver(function () {
      if (el.textContent === el._w) return;                 // tulisan animasi sendiri, abaikan
      var neg = /-/.test(el.textContent);
      el.classList.toggle('neg', neg);
      countUp(el, id);
      if (!reduce.matches) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  // ----- Dashboard: kartu target & biaya tetap — angka naik pelan, bilah tumbuh saat nilainya berubah -----
  ['targetBody', 'fixedBody', 'grossBody'].forEach(function (id) {
    var box = document.getElementById(id);
    if (!box) return;
    var last = null, tm;
    new MutationObserver(function () {
      var sig = box.textContent;                           // ambil DULU, sebelum angka mulai dianimasikan (teks animasi bukan nilai asli)
      box.querySelectorAll('[data-count]').forEach(function (el, i) { countUp(el, id + i); });
      var changed = last !== null && sig !== last;
      last = sig;
      if (changed && !reduce.matches && document.documentElement.hasAttribute('data-ready')) {
        box.classList.remove('grow'); void box.offsetWidth; box.classList.add('grow');
        clearTimeout(tm); tm = setTimeout(function () { box.classList.remove('grow'); }, 1000);
      }
    }).observe(box, { childList: true });
  });

  // ----- Dashboard: grafik perbandingan marketplace tergambar bertahap (hanya saat data/mode berganti, bukan saat jendela diubah ukurannya) -----
  var cmp = document.getElementById('cmpChart');
  if (cmp) {
    var cmpSig = '';
    new MutationObserver(function () {
      var svg = cmp.querySelector('svg');
      if (!svg) return;
      var mode = (document.querySelector('#cmpMode [aria-pressed="true"]') || {}).dataset;
      var grid = Array.prototype.map.call(svg.querySelectorAll('.grid text'), function (t) { return t.textContent; }).join('|');
      var heights = Array.prototype.map.call(svg.querySelectorAll('rect.seg-bar'), function (r) { return r.getAttribute('height'); }).join(',');
      var sig = (mode && mode.mode) + '#' + grid + '#' + heights + '#' + svg.querySelectorAll('path.cmp-line').length + '#' + svg.querySelectorAll('circle.cmp-dot').length;
      if (sig === cmpSig) return;
      cmpSig = sig;
      if (reduce.matches) return;
      cmp.classList.remove('draw'); void cmp.offsetWidth; cmp.classList.add('draw');
      setTimeout(function () { cmp.classList.remove('draw'); }, 2200);
    }).observe(cmp, { childList: true });
  }

  // ----- Dashboard: baris tabel masuk halus saat urutan / halaman berganti (tidak saat mengetik di pencarian) -----
  var rowsEl = document.getElementById('rows');
  if (rowsEl) {
    var armed = false, armTm, swapTm;
    var arm = function () { armed = true; clearTimeout(armTm); armTm = setTimeout(function () { armed = false; }, 700); };
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('th[data-sort], #pager button[data-pg]')) arm(); }, true);
    document.addEventListener('change', function (e) { if (e.target && (e.target.id === 'pgSize' || e.target.id === 'mSort')) arm(); }, true);
    new MutationObserver(function () {
      if (!armed || reduce.matches) return;
      armed = false;
      var trs = rowsEl.children;
      for (var i = 0; i < trs.length && i < 14; i++) trs[i].style.setProperty('--i', i);
      rowsEl.classList.remove('swap'); void rowsEl.offsetWidth; rowsEl.classList.add('swap');
      clearTimeout(swapTm); swapTm = setTimeout(function () { rowsEl.classList.remove('swap'); }, 800);
    }).observe(rowsEl, { childList: true });
  }

  // ----- Pesan validasi formulir dalam Bahasa Indonesia (bawaan Chrome berbahasa Inggris) -----
  function pesanValidasi(el) {
    var v = el.validity;
    if (v.valueMissing) return 'Wajib diisi.';
    if (v.rangeUnderflow) return Number(el.min) > 0 && Number(el.min) < 1 ? 'Isi dengan angka lebih dari 0.' : 'Nilai minimal ' + el.min + '.';
    if (v.rangeOverflow) return 'Nilai maksimal ' + el.max + '.';
    if (v.stepMismatch) return 'Isi dengan bilangan bulat.';
    if (v.badInput) return 'Isi dengan angka yang valid.';
    if (v.typeMismatch) return 'Format tidak valid.';
    return '';
  }
  document.addEventListener('invalid', function (e) {
    var el = e.target;
    if (!el || !el.setCustomValidity) return;
    el.setCustomValidity('');
    var m = pesanValidasi(el);
    if (m) el.setCustomValidity(m);
  }, true);
  document.addEventListener('input', function (e) {
    if (e.target && e.target.setCustomValidity) e.target.setCustomValidity('');
  }, true);
  // ----- HP: bayangan pada menu tab saat sudah menempel di atas -----
  var tabs = document.querySelector('.tabs');
  if (tabs) {
    var ticking = false;
    var upd = function () {
      ticking = false;
      var stuck = tabs.getBoundingClientRect().top <= 0.5 && window.scrollY > 0;
      if (stuck) tabs.setAttribute('data-stuck', ''); else tabs.removeAttribute('data-stuck');
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
    window.addEventListener('resize', upd);
    upd();
  }
  // ----- HP: tombol melayang "ke atas" (muncul setelah menggulir jauh) -----
  if (document.querySelector('.tabs') && !document.getElementById('toTop')) {
    var up = document.createElement('button');
    up.id = 'toTop'; up.type = 'button'; up.hidden = true;
    up.setAttribute('aria-label', 'Kembali ke atas');
    up.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    up.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: reduce.matches ? 'auto' : 'smooth' }); });
    document.body.appendChild(up);
    var tk = false;
    var chk = function () { tk = false; up.hidden = window.scrollY < 400; };
    window.addEventListener('scroll', function () { if (!tk) { tk = true; requestAnimationFrame(chk); } }, { passive: true });
    chk();
  }

  // ----- HP: tombol data (Template/Impor/Ekspor/Cetak/Cadangkan/Pulihkan) dilipat; ID tombol tidak berubah -----
  (function () {
    var top = document.querySelector('.top'), acts = top && top.querySelector('.actions');
    if (!acts || acts.classList.contains('solo')) return;
    var n = acts.querySelectorAll('button:not(.theme-toggle)').length;
    if (n < 3 || document.getElementById('actionsToggle')) return;
    var t = document.createElement('button');
    t.id = 'actionsToggle'; t.type = 'button'; t.setAttribute('aria-expanded', 'false');
    t.innerHTML = '<span>Menu data</span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    acts.parentNode.insertBefore(t, acts);
    top.classList.add('actions-fold');
    t.addEventListener('click', function () {
      var open = top.classList.toggle('actions-open');
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Aksi dipilih -> lipat lagi supaya layar bersih
    acts.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('button:not(.theme-toggle)')) { top.classList.remove('actions-open'); t.setAttribute('aria-expanded', 'false'); } });
  })();

  // ----- HP: ukur tinggi tab & chip untuk menumpuk sticky; ringkas placeholder pencarian -----
  (function () {
    var tabs = document.querySelector('.tabs'), chips = document.getElementById('chips'), filt = document.querySelector('.filters'), q = document.getElementById('q');
    if (!tabs || !chips || !filt) return;
    var root = document.documentElement.style, mq = matchMedia('(max-width: 600px)');
    var longPh = q ? q.placeholder : '';
    function measure() {
      root.setProperty('--tabs-h', tabs.offsetHeight + 'px');
      root.setProperty('--chips-h', chips.offsetHeight + 'px');
      if (q) q.placeholder = mq.matches ? 'Cari produk / resi' : longPh;
      var stuck = mq.matches && filt.getBoundingClientRect().top <= tabs.offsetHeight + chips.offsetHeight + 1 && window.scrollY > 40;
      if (stuck) filt.setAttribute('data-stuck', ''); else filt.removeAttribute('data-stuck');
    }
    measure();
    if (window.ResizeObserver) { var ro = new ResizeObserver(measure); ro.observe(tabs); ro.observe(chips); }
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', function () { requestAnimationFrame(measure); }, { passive: true });
    mq.addEventListener && mq.addEventListener('change', measure);
  })();

  // ----- Pop-up: tanda uang "Rp 75.000" di dalam isian harga -----
  (function () {
    if (typeof rupiah !== 'function') return;
    document.querySelectorAll('input[data-money]').forEach(function (inp) {
      var mh = document.createElement('span'); mh.className = 'mh'; mh.setAttribute('aria-hidden', 'true');
      inp.parentNode.appendChild(mh);
      var upd = function () { var v = Number(inp.value); mh.textContent = v >= 1000 ? rupiah(v) : ''; };
      inp.addEventListener('input', upd);
      new MutationObserver(upd).observe(inp, { attributes: true, attributeFilter: ['value'] });
      inp.form && inp.form.addEventListener('reset', function () { setTimeout(upd, 0); });
      setInterval(upd, 700);   // nilai yang diisi lewat skrip (isi otomatis dari menu produk, pulihkan form) tidak memicu event input
      upd();
    });
  })();
})();
