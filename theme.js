/* Ganti tema gelap / terang. Dimuat di <head> (tanpa defer) supaya tema terpasang sebelum halaman tergambar.
   Pilihan disimpan di localStorage (dipakai bersama oleh semua halaman ekstensi). Tanpa pilihan = ikut tema sistem. */
(function () {
  'use strict';
  var KEY = 'lm_theme';
  var root = document.documentElement;

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; }
  }
  function apply() {
    var s = stored();
    if (s) root.setAttribute('data-theme', s); else root.removeAttribute('data-theme');
  }
  apply();

  var SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var AUTO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';

  // Urutan klik: Otomatis (ikut sistem) -> Terang -> Gelap -> Otomatis.
  var MODES = { auto: { icon: AUTO, label: 'Otomatis' }, light: { icon: SUN, label: 'Terang' }, dark: { icon: MOON, label: 'Gelap' } };
  var NEXT = { auto: 'light', light: 'dark', dark: 'auto' };

  var btn = null;
  function refresh() {
    if (!btn) return;
    var m = stored() || 'auto', info = MODES[m];
    btn.innerHTML = info.icon + '<span class="theme-label">' + info.label + '</span>';
    var t = 'Tema: ' + info.label + (m === 'auto' ? ' (mengikuti sistem)' : '') + ' — klik untuk ganti ke ' + MODES[NEXT[m]].label;
    btn.title = t; btn.setAttribute('aria-label', t);
  }
  function toggle() {
    var next = NEXT[stored() || 'auto'];
    root.classList.add('theme-anim');
    setTimeout(function () { root.classList.remove('theme-anim'); }, 350);
    try {
      if (next === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next);
    } catch (e) { /* penyimpanan tidak tersedia: tema hanya berlaku sampai halaman ditutup */ }
    if (next === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next);
    refresh();
  }

  function mount() {
    var header = document.querySelector('header');
    if (!header || document.getElementById('themeToggle')) return;
    btn = document.createElement('button');
    btn.id = 'themeToggle'; btn.type = 'button'; btn.className = 'theme-toggle ghost';
    btn.addEventListener('click', toggle);
    var actions = header.querySelector('.actions');
    if (!actions && header.classList.contains('top')) {
      actions = document.createElement('div'); actions.className = 'actions solo'; header.appendChild(actions);
    }
    if (actions) actions.insertBefore(btn, actions.firstChild); // di depan, agar tetap terlihat saat deretan tombol bisa digeser
    else header.appendChild(btn);                                // jendela pencatatan: pojok kanan atas
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // Sinkron antar halaman yang sedang terbuka. (Mode Otomatis berganti sendiri lewat CSS saat tema sistem berubah.)
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) { apply(); refresh(); } });
  
})();
