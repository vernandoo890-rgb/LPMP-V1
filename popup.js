const $ = id => document.getElementById(id);
let products = [];
let dateTouched = false; // true bila pengguna memilih tanggal sendiri; selama false, tanggal otomatis = hari ini
let cfg = { fees: {} }; // pengaturan terbaru (biaya admin, affiliate, biaya proses, pajak) untuk keterangan pratinjau
let matchedId = null;
let editingId = null; // id transaksi yang sedang diedit lewat hasil pencarian (null = mencatat penjualan baru)
let salesCache = null; // transaksi disimpan di memori; diperbarui dari storage.onChanged, jadi mengetik tidak membaca ulang seluruh data
let tunggu = 0; // jumlah simpanan yang masih berjalan di latar belakang
const sales = async () => (salesCache ||= await store.getSales());
const bersihSales = a => (Array.isArray(a) ? a.filter(s => s && typeof s === 'object' && typeof s.date === 'string' && typeof s.product === 'string') : []);
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; }; // produk dari menu yang sedang cocok dengan nama di form

async function init() {
  $('marketplace').innerHTML = MARKETPLACES.map(m => `<option>${escapeHtml(m)}</option>`).join('');
  $('date').value = todayISO();
  $('date').addEventListener('input', () => { dateTouched = $('date').value !== todayISO(); refreshStats(); }); // ringkasan mengikuti tanggal yang dipilih
  // Lewat tengah malam: tanggal form ikut hari baru (bila tidak diubah manual) dan ringkasan "hari ini" dihitung ulang.
  onDayChange((now, old) => {
    if (!dateTouched || $('date').value === old) { $('date').value = now; dateTouched = false; }
    refreshStats();
  });
  // Popup dibuka kembali / jendela aktif lagi: pastikan tanggal tidak ketinggalan.
  window.addEventListener('focus', () => { if (!dateTouched) { $('date').value = todayISO(); refreshStats(); } });

  products = await store.getProducts();
  renderProductList();

  const settings = await store.getSettings();
  if (settings.lastMarketplace) $('marketplace').value = settings.lastMarketplace;
  applyFee(settings);

  $('marketplace').addEventListener('change', async () => applyFee(await store.getSettings()));
  ['qty', 'price', 'omzetMp', 'cogs', 'feePct', 'otherCost', 'status'].forEach(id => $(id).addEventListener('input', updatePreview));
  $('status').addEventListener('change', updatePreview);
  $('product').addEventListener('input', onProductInput);
  initCombo();
  $('form').addEventListener('submit', onSubmit);
  const cariTunda = debounce(runSearch, 120), dobelTunda = debounce(checkDupOrder, 150);
  $('orderSearch').addEventListener('input', cariTunda);
  const pilihHasil = e => {
    const li = e.target.closest ? e.target.closest('li.hit') : null;
    if (li && li.dataset.id) startEdit(li.dataset.id);
  };
  $('searchResults').addEventListener('click', pilihHasil);
  $('searchResults').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pilihHasil(e); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const hits = [...$('searchResults').querySelectorAll('li.hit')], i = hits.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      hits[(i + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length].focus();
    }
  });
  $('orderSearch').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { const h = $('searchResults').querySelector('li.hit'); if (h) { e.preventDefault(); h.focus(); } }
  });
  $('editCancel').addEventListener('click', () => { exitEdit(); showMsg('Edit dibatalkan'); });
  $('editDelete').addEventListener('click', deleteEdit);
  $('orderNo').addEventListener('input', dobelTunda);
  $('marketplace').addEventListener('change', dobelTunda);
  $('product').addEventListener('input', dobelTunda);
  $('addMore').addEventListener('click', onAddMore);
  $('openReport').addEventListener('click', () => openPage('report.html'));
  $('openProducts').addEventListener('click', () => openPage('products.html'));
  $('openAds').addEventListener('click', () => openPage('ads.html'));
  $('openFees').addEventListener('click', () => openPage('fees.html'));

  // Jendela ini tetap terbuka untuk pencatatan real-time, jadi ikut diperbarui bila data berubah dari tab lain
  // (menu Produk, Biaya admin, Iklan, Dashboard, impor/pemulihan data).
  let tundaSinkron = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sales) salesCache = bersihSales(changes.sales.newValue);
    if (changes.settings) { cfg = changes.settings.newValue || { fees: {} }; updatePreview(); }
    if (!(changes.sales || changes.ads || changes.products || changes.settings)) return;
    clearTimeout(tundaSinkron);
    tundaSinkron = setTimeout(sinkron, 150);
    function sinkron() {
      if (changes.products) syncProducts();
      if (changes.settings && document.activeElement !== $('feePct')) store.getSettings().then(applyFeeIfPristine);
      refreshStats();
      if ($('orderSearch').value.trim()) runSearch();
      if ($('orderNo').value.trim()) checkDupOrder();
    }
  });

  // Angka langsung terblok saat kolom dipilih, supaya mengetik menimpa nilai lama (qty, harga, biaya).
  document.querySelectorAll('input[type=number]').forEach(el => el.addEventListener('focus', () => setTimeout(() => el.select(), 0)));
  // Ctrl+Enter menyimpan dari kolom mana pun; Esc mengosongkan kolom cari.
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('form').requestSubmit(); }
    if (e.key === 'Escape' && document.activeElement === $('orderSearch')) { $('orderSearch').value = ''; runSearch(); }
    else if (e.key === 'Escape' && editingId) { exitEdit(); showMsg('Edit dibatalkan'); }
  });
  // Saat jendela ditutup dengan simpanan yang belum selesai, minta konfirmasi agar tidak ada data hilang.
  window.addEventListener('beforeunload', e => { if (tunggu > 0) { e.preventDefault(); e.returnValue = ''; } });
  if (!document.activeElement || document.activeElement === document.body) $('product').focus();

  updatePreview();
  refreshStats();
}

// Buka halaman menu: bila sudah terbuka di salah satu tab, pindah ke tab itu (tidak membuat tab dobel).
// Dipakai dari jendela pop-up, jadi tab baru diarahkan ke jendela Chrome biasa, bukan ke jendela pencatatan ini.
async function openPage(file) {
  const url = chrome.runtime.getURL(file);
  try {
    // getContexts tidak butuh izin "tabs" (alamat tab disembunyikan Chrome tanpa izin itu, jadi tabs.query tidak bisa dipakai)
    const [ada] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
    if (ada && ada.tabId >= 0) {
      await chrome.tabs.update(ada.tabId, { active: true });
      await chrome.windows.update(ada.windowId, { focused: true });
      return;
    }
    let normal = null;
    try { normal = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch (e) { /* tidak ada jendela biasa */ }
    if (normal && normal.type === 'normal') {
      await chrome.tabs.create({ url, windowId: normal.id, active: true });
      await chrome.windows.update(normal.id, { focused: true });
      return;
    }
    await chrome.windows.create({ url, focused: true });
  } catch (err) {
    chrome.tabs.create({ url });
  }
}

// Daftar produk berubah dari menu Produk: muat ulang daftar saran dan harga produk yang sedang cocok.
async function syncProducts() {
  products = await store.getProducts();
  renderProductList();
  const p = findProduct(products, $('product').value);
  if (p && document.activeElement !== $('price') && document.activeElement !== $('cogs')) {
    $('price').value = p.price || '';
    $('cogs').value = p.cost || 0;
    matchedId = p.id;
  }
  onProductInput();
}

// Biaya admin default berubah dari menu Biaya admin: terapkan ke form hanya bila belum diubah manual.
let feeDefault = null;
function applyFeeIfPristine(settings) {
  const f = settings.fees && settings.fees[$('marketplace').value];
  const baru = f !== undefined ? f : 0;
  if (feeDefault === null || Number($('feePct').value) === feeDefault) $('feePct').value = baru;
  feeDefault = baru;
  cfg = settings;
  updatePreview();
}

// Cari transaksi berdasarkan resi / nomor pesanan / nama produk (hasil terbaru dulu, maksimal 8).
async function runSearch() {
  const q = $('orderSearch').value.trim();
  const box = $('searchResults');
  if (!q) { box.hidden = true; box.innerHTML = ''; return; }
  const found = (await sales()).map((s, i) => ({ s, i })).filter(x => matchSale(x.s, q))
    .sort((a, b) => b.s.date.localeCompare(a.s.date) || b.i - a.i).slice(0, 8).map(x => x.s);
  box.innerHTML = found.length
    ? '<li class="rs-head" aria-hidden="true">Klik pesanan untuk mengedit</li>' + found.map(s => {
        const [yy, mm, dd] = s.date.split('-');
        const c = calc(s);
        return `<li class="hit${s.id === editingId ? ' editing' : ''}" role="button" tabindex="0" data-id="${escapeHtml(s.id)}" title="Klik untuk mengedit pesanan ini"><strong>${escapeHtml(s.orderNo || '(tanpa resi)')}</strong>
          <span>${escapeHtml(s.product)} · ${escapeHtml(s.marketplace)}</span>
          <small>${dd}/${mm}/${yy} · ${num(s.qty)} pcs · ${s.status === 'selesai' ? rupiah(c.revenue) : escapeHtml(s.status)}</small></li>`;
      }).join('')
    : '<li class="none">Tidak ditemukan</li>';
  box.hidden = false;
}

// ---------- Edit pesanan dari hasil pencarian ----------
// Klik hasil pencarian: isi form dengan pesanan itu. Tombol Simpan berubah menjadi "Simpan perubahan" dan memperbarui pesanan yang sama.
async function startEdit(id) {
  const sale = (await sales()).find(x => x.id === id);
  if (!sale) { showMsg('Pesanan tidak ditemukan (mungkin sudah dihapus).', true); runSearch(); return; }
  editingId = id;
  fillForm(sale);
  // Harga di form harus tetap harga pesanan ini, bukan harga terbaru dari menu produk.
  $('price').value = sale.price; $('cogs').value = sale.cogs || 0;
  const p = findProduct(products, sale.product);
  matchedId = p ? p.id : null;
  $('productHint').hidden = true; $('saveProductWrap').hidden = true; $('saveProduct').checked = false;
  dateTouched = sale.date !== todayISO();
  const nama = sale.orderNo ? `${sale.orderNo} · ${sale.product}` : sale.product;
  $('editText').textContent = `Mengedit: ${nama}`;
  $('editBar').hidden = false;
  $('saveLabel').textContent = 'Simpan perubahan';
  $('addMore').hidden = true;
  updatePreview(); refreshStats(); runSearch(); checkDupOrder();
  $('editBar').scrollIntoView({ block: 'nearest' });
  $('qty').focus();
}

function resetForm() {
  if (!dateTouched) $('date').value = todayISO();
  $('orderNo').value = '';
  $('orderDup').hidden = true;
  $('product').value = '';
  $('price').value = '';
  $('omzetMp').value = '';
  $('cogs').value = 0;
  $('qty').value = 1;
  $('otherCost').value = 0;
  $('status').value = 'selesai';
  $('saveProduct').checked = false;
  matchedId = null;
  onProductInput();
}

function exitEdit() {
  const adaEdit = editingId !== null;
  editingId = null;
  resetDeleteBtn();
  $('editBar').hidden = true;
  $('saveLabel').textContent = 'Simpan';
  $('addMore').hidden = false;
  if (adaEdit) { dateTouched = false; $('date').value = todayISO(); resetForm(); refreshStats(); if ($('orderSearch').value.trim()) runSearch(); }
}

// Hapus pesanan yang sedang diedit. Dua langkah (klik, lalu klik lagi dalam 4 detik) supaya tidak terhapus tidak sengaja.
let hapusTimer = 0;
function resetDeleteBtn() { clearTimeout(hapusTimer); const b = $('editDelete'); b.textContent = 'Hapus pesanan'; b.dataset.confirm = ''; }
function deleteEdit() {
  const b = $('editDelete');
  if (!editingId) return;
  if (b.dataset.confirm !== '1') {
    b.dataset.confirm = '1'; b.textContent = 'Yakin hapus? Klik lagi';
    clearTimeout(hapusTimer); hapusTimer = setTimeout(resetDeleteBtn, 4000);
    return;
  }
  const id = editingId, cache = salesCache, sale = cache && cache.find(x => x.id === id);
  resetDeleteBtn();
  if (salesCache) salesCache = salesCache.filter(x => x.id !== id);
  exitEdit();
  refreshStats(); if ($('orderSearch').value.trim()) runSearch();
  tunggu++;
  showMsg('Menghapus…');
  store.removeSale(id).then(() => {
    tunggu--;
    if (tunggu === 0) showMsg('Pesanan dihapus ✓');
  }).catch(err => {
    tunggu--;
    salesCache = cache;
    refreshStats(); if ($('orderSearch').value.trim()) runSearch();
    showMsg(`Gagal menghapus${sale ? ' ' + sale.product : ''}: ${err.message}. Coba lagi.`, true);
  });
}

function saveEdit() {
  const sale = buildSale();
  if (!sale) return;
  const id = editingId;
  sale.id = id;
  const cache = salesCache;
  if (salesCache) salesCache = salesCache.map(x => (x.id === id ? { ...x, ...sale } : x));
  exitEdit();
  refreshStats(); if ($('orderSearch').value.trim()) runSearch();
  tunggu++;
  showMsg('Menyimpan…');
  store.updateSale(id, sale).then(r => {
    tunggu--;
    if (r === null) { salesCache = cache; refreshStats(); showMsg('Pesanan tidak ditemukan (mungkin sudah dihapus), perubahan tidak tersimpan.', true); return; }
    if (tunggu === 0) showMsg('Perubahan tersimpan ✓');
  }).catch(err => {
    tunggu--;
    salesCache = cache;
    refreshStats(); if ($('orderSearch').value.trim()) runSearch();
    if (!$('product').value.trim() && editingId === null) startEdit(id);   // kembalikan pesanan ke form bila form belum dipakai lagi
    showMsg(`Gagal menyimpan perubahan: ${err.message}. Coba lagi.`, true);
  });
}

// Info bila resi / nomor pesanan yang diketik sudah punya produk: produk baru digabung ke pesanan yang sama
// (biaya proses dihitung 1x per resi). Peringatan merah bila produk yang sama sudah ada di resi itu (kemungkinan dobel).
async function checkDupOrder() {
  const v = $('orderNo').value.trim().toLowerCase();
  const el = $('orderDup');
  if (!v) { el.hidden = true; return; }
  const mp = $('marketplace').value.trim().toLowerCase();
  const same = (await sales()).filter(s => s.id !== editingId && String(s.orderNo || '').trim().toLowerCase() === v && String(s.marketplace || '').trim().toLowerCase() === mp);
  if (!same.length) { el.hidden = true; return; }
  const names = same.map(s => s.product);
  const twin = names.some(n => productKey(n) === productKey($('product').value));
  const daftar = `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;
  el.textContent = (editingId
    ? `Resi ini juga berisi ${same.length} produk lain: ${daftar}.`
    : `Resi ini sudah berisi ${same.length} produk: ${daftar}. Produk baru digabung ke pesanan yang sama (biaya proses dihitung 1×).`)
    + (twin ? ' Produk yang sama sudah ada di resi ini, cek agar tidak dobel!' : '');
  el.className = 'hint' + (twin ? ' warn' : '');
  el.hidden = false;
}

// ---------- daftar pilihan produk (combobox) ----------
let comboItems = [], comboActive = -1;

function renderProductList() {
  if (!$('productList').hidden) showCombo();   // daftar produk berubah saat daftar terbuka: segarkan
}

function comboMatches(q) {
  const tokens = productKey(q).split(/\s+/).filter(Boolean);
  const hay = p => `${p.name} ${p.sku || ''} ${p.category || ''}`.toLowerCase();
  const list = products.filter(p => tokens.every(t => hay(p).includes(t)));
  const starts = p => (tokens.length && p.name.toLowerCase().startsWith(tokens[0]) ? 0 : 1);
  return list.sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name, 'id'));
}

function highlight(text, q) {
  const tokens = productKey(q).split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!tokens.length) return escapeHtml(text);
  const re = new RegExp('(' + tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
}

function showCombo() {
  const q = $('product').value;
  const ul = $('productList');
  comboItems = comboMatches(q);
  // satu-satunya hasil sama persis dengan isi kolom = produk sudah terpilih, tidak perlu dibuka lagi
  if (comboItems.length === 1 && productKey(comboItems[0].name) === productKey(q)) return hideCombo();
  const shown = comboItems.slice(0, 40);
  if (!products.length) {
    ul.innerHTML = '<li class="combo-empty" role="presentation">Menu produk masih kosong. Ketik nama produk baru, lalu centang “Simpan produk ini”.</li>';
  } else if (!shown.length) {
    ul.innerHTML = '<li class="combo-empty" role="presentation">Tidak ada produk yang cocok. Lanjut ketik untuk produk baru.</li>';
  } else {
    ul.innerHTML = `<li class="combo-head" role="presentation">${q.trim() ? num(comboItems.length) + ' produk cocok' : 'Menu produk · ' + num(products.length)}</li>`
      + shown.map((p, i) => {
        const m = productMargin(p);
        const badge = p.price > 0 ? `<span class="combo-badge ${m.profit < 0 ? 'neg' : ''}" title="Margin kotor sebelum biaya marketplace">${m.profit < 0 ? '' : '+'}${Math.round(m.pct)}%</span>` : '';
        return `<li id="combo-${i}" role="option" data-i="${i}" aria-selected="false" class="combo-item">
          <span class="combo-main"><span class="combo-name">${highlight(p.name, q)}</span>
          <span class="combo-meta">Modal ${rupiah(p.cost || 0)} · Jual ${p.price > 0 ? rupiah(p.price) : '–'}${p.category ? ' · ' + escapeHtml(p.category) : ''}</span></span>${badge}</li>`;
      }).join('')
      + (comboItems.length > shown.length ? `<li class="combo-more" role="presentation">+${num(comboItems.length - shown.length)} lagi. Ketik lebih spesifik untuk mempersempit.</li>` : '');
  }
  ul.hidden = false;
  $('product').setAttribute('aria-expanded', 'true');
  setComboActive(shown.length ? 0 : -1);
}

function hideCombo() {
  $('productList').hidden = true;
  $('product').setAttribute('aria-expanded', 'false');
  $('product').removeAttribute('aria-activedescendant');
  comboActive = -1;
}

function setComboActive(i) {
  const ul = $('productList');
  const n = Math.min(comboItems.length, 40);
  comboActive = n ? (i + n) % n : -1;
  ul.querySelectorAll('.combo-item').forEach((el, k) => { el.classList.toggle('active', k === comboActive); el.setAttribute('aria-selected', k === comboActive ? 'true' : 'false'); });
  const el = comboActive >= 0 ? $('combo-' + comboActive) : null;
  if (el) { $('product').setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
  else $('product').removeAttribute('aria-activedescendant');
}

function pickCombo(i) {
  const p = comboItems[i];
  if (!p) return;
  $('product').value = p.name;
  hideCombo();
  $('product').dispatchEvent(new Event('input', { bubbles: true }));   // isi harga & modal otomatis seperti biasa
  const next = $('orderNo');
  if (next) next.focus();
}

function initCombo() {
  const input = $('product'), ul = $('productList');
  input.addEventListener('click', () => { if (ul.hidden) showCombo(); });
  input.addEventListener('input', showCombo);
  input.addEventListener('keydown', e => {
    const open = !ul.hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); open ? setComboActive(comboActive + 1) : showCombo(); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setComboActive(comboActive - 1); }
    else if (e.key === 'Enter' && open && comboActive >= 0) { e.preventDefault(); pickCombo(comboActive); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hideCombo(); }
    else if (e.key === 'Tab') hideCombo();
  });
  // mousedown (bukan click) + preventDefault supaya kolom tidak kehilangan fokus sebelum pilihan terbaca
  ul.addEventListener('mousedown', e => { e.preventDefault(); const li = e.target.closest('.combo-item'); if (li) pickCombo(Number(li.dataset.i)); });
  ul.addEventListener('mousemove', e => { const li = e.target.closest('.combo-item'); if (li && Number(li.dataset.i) !== comboActive) setComboActive(Number(li.dataset.i)); });
  input.addEventListener('blur', hideCombo);
}

// Bila nama cocok dengan menu produk, harga jual dan kulakan terisi otomatis.
function onProductInput() {
  const name = $('product').value;
  const p = findProduct(products, name);
  const hint = $('productHint');
  if (p) {
    if (p.id !== matchedId) {
      $('price').value = p.price || '';
      $('cogs').value = p.cost || 0;
      matchedId = p.id;
    }
    hint.textContent = 'Harga terisi dari menu produk (bisa diubah untuk transaksi ini)';
    hint.hidden = false;
    $('saveProductWrap').hidden = true;
    $('saveProduct').checked = false;
  } else {
    matchedId = null;
    hint.hidden = true;
    $('saveProductWrap').hidden = !name.trim();
  }
  updatePreview();
}

// Biaya admin terisi dari menu Biaya Admin per marketplace (bisa diubah untuk transaksi ini saja).
function applyFee(settings) {
  cfg = settings || { fees: {} };
  const f = settings.fees && settings.fees[$('marketplace').value];
  $('feePct').value = f !== undefined ? f : 0;
  feeDefault = Number($('feePct').value);
  updatePreview();
}

function readForm() {
  return {
    date: $('date').value,
    marketplace: $('marketplace').value,
    product: $('product').value.trim(),
    qty: Number($('qty').value),
    price: Number($('price').value),
    cogs: Number($('cogs').value) || 0,
    feePct: Number($('feePct').value) || 0,
    otherCost: Number($('otherCost').value) || 0,
    status: $('status').value,
    orderNo: $('orderNo').value.trim(),
    omzetMp: Number($('omzetMp').value) || 0
  };
}

// "Opsi lainnya" terbuka otomatis bila isinya bukan nilai bawaan (mis. saat mengisi ulang pesanan); tidak pernah menutup sendiri saat mengetik.
function syncMore() {
  const m = $('more'); if (!m) return;
  const terisi = Number($('omzetMp').value) > 0 || Number($('otherCost').value) > 0 || $('status').value !== 'selesai';
  if (terisi) m.open = true;
  $('moreBadge').hidden = !terisi;
}

function updatePreview() {
  const f = readForm();
  const c = calc(f);
  const below = f.price > 0 && f.cogs > 0 && f.price < f.cogs;
  // Affiliate, biaya proses & pajak per marketplace dipotong di dashboard, bukan di sini: beri tahu supaya angkanya tidak membingungkan.
  const mp = $('marketplace').value;
  const aff = cleanFee((cfg.affiliate || {})[mp]), proc = cleanRp((cfg.procFee || {})[mp]), tax = cleanFee((cfg.taxes || {})[mp]);
  const extra = [aff ? `affiliate ${aff}%` : '', proc ? `biaya proses ${rupiah(proc)}/pesanan` : '', tax ? `pajak ${tax}%` : ''].filter(Boolean);
  $('preview').innerHTML = c.counted
    ? `<span class="pv-main"><span>Profit perkiraan</span><strong>${rupiah(c.profit)}</strong></span>`
      + `<span class="pv-side">Omzet ${rupiah(c.revenue)}${below ? '<b>Harga jual di bawah kulakan!</b>' : ''}</span>`
      + (extra.length ? `<small title="Dipotong di Dashboard">Belum dipotong ${escapeHtml(extra.join(', '))}</small>` : '')
    : '<span class="pv-main"><span>Pesanan tidak dihitung sebagai omzet</span></span>';
  syncMore();
  $('preview').className = 'preview' + (below || (c.counted && c.profit < 0) ? ' warn' : '');
}

// Validasi isi form dan bentuk transaksinya. null bila belum lengkap (pesan sudah ditampilkan).
function buildSale() {
  const sale = readForm();
  // Hanya omzet marketplace yang diisi: harga jual / unit dihitung dari omzet dibagi qty.
  if (!(sale.price > 0) && sale.omzetMp > 0 && sale.qty > 0) sale.price = sale.omzetMp / sale.qty;
  if (!sale.date || !sale.product || !(sale.qty > 0) || !(sale.price > 0)) {
    showMsg('Lengkapi tanggal, produk, qty (> 0), dan harga jual atau omzet marketplace (> 0).', true);
    return null;
  }
  sale.id = uid();
  return sale;
}

// Tulis ke penyimpanan (berjalan di latar belakang; urutan antar simpanan dijaga oleh kunci tulis di store).
async function persistSale(sale, simpanProduk) {
  await store.addSale(sale); // gagal di sini = transaksi belum tersimpan (ditangani pemanggil)
  // Langkah tambahan: bila gagal, transaksi sudah aman tersimpan, jadi jangan dianggap gagal (mencegah catatan ganda).
  try {
    if (simpanProduk && !findProduct(products, sale.product)) {
      await store.addProduct({ id: uid(), name: sale.product, sku: '', category: '', cost: sale.cogs, price: sale.price, note: '' });
      products = await store.getProducts();
      renderProductList();
    }
    // Persentase biaya admin default diatur di menu Biaya Admin; di sini hanya mengingat marketplace terakhir.
    await store.updateSettings(st => { st.lastMarketplace = sale.marketplace; });
  } catch (err) { console.warn('Langkah tambahan gagal:', err); }
}

// Catat dengan tampilan langsung "maju": ringkasan ikut naik dan form siap diisi lagi tanpa menunggu penulisan
// (di data besar menulis bisa makan ~1 detik). Bila penulisan gagal, isi form dikembalikan dan pesan galat muncul.
function commitSale(sale, simpanProduk, pesanOk) {
  const cache = salesCache;
  if (salesCache) salesCache = [...salesCache, sale];
  refreshStats(); runSearch();
  tunggu++;
  showMsg('Menyimpan…');
  persistSale(sale, simpanProduk).then(() => {
    if (--tunggu === 0) showMsg(pesanOk);
  }).catch(err => {
    tunggu--;
    salesCache = cache ? cache.filter(x => x.id !== sale.id) : null;
    refreshStats(); runSearch();
    if (!$('product').value.trim()) fillForm(sale); // kembalikan isian bila form belum dipakai lagi
    showMsg(`Gagal menyimpan ${sale.product}${sale.orderNo ? ' (' + sale.orderNo + ')' : ''}: ${err.message}. Coba lagi.`, true);
  });
}

function fillForm(sale) {
  $('date').value = sale.date; $('marketplace').value = sale.marketplace; $('product').value = sale.product;
  $('orderNo').value = sale.orderNo || ''; $('qty').value = sale.qty; $('price').value = sale.price; $('cogs').value = sale.cogs;
  $('feePct').value = sale.feePct; $('otherCost').value = sale.otherCost; $('status').value = sale.status; $('omzetMp').value = sale.omzetMp || '';
  matchedId = null; onProductInput(); checkDupOrder();
}

// Simpan produk ini lalu siapkan form untuk produk berikutnya di pesanan (resi) yang sama.
// Tanggal, marketplace, resi, status, dan biaya admin dipertahankan; kolom produk dikosongkan.
function onAddMore() {
  if (!$('orderNo').value.trim()) {
    showMsg('Isi Resi / No. pesanan dulu supaya produk digabung jadi 1 pesanan.', true);
    return $('orderNo').focus();
  }
  const sale = buildSale();
  if (!sale) return;
  const simpanProduk = $('saveProduct').checked;
  commitSale(sale, simpanProduk, 'Produk tersimpan ✓ isi produk berikutnya (resi sama)');
  $('product').value = '';
  $('price').value = '';
  $('omzetMp').value = '';
  $('cogs').value = 0;
  $('qty').value = 1;
  $('otherCost').value = 0;
  if ($('status').value === 'selesai') $('more').open = false;
  $('saveProduct').checked = false;
  matchedId = null;
  onProductInput();
  $('product').focus();
  checkDupOrder();
}

function onSubmit(e) {
  e.preventDefault();
  if (editingId) return saveEdit();
  const sale = buildSale();
  if (!sale) return;
  const simpanProduk = $('saveProduct').checked;
  commitSale(sale, simpanProduk, 'Tersimpan ✓');
  if (!dateTouched) $('date').value = todayISO();
  $('orderNo').value = '';
  $('orderDup').hidden = true;
  $('product').value = '';
  $('price').value = '';
  $('omzetMp').value = '';
  $('cogs').value = 0;
  $('qty').value = 1;
  $('otherCost').value = 0;   // biaya lain berlaku per transaksi, jangan terbawa ke catatan berikutnya
  $('status').value = 'selesai';
  $('saveProduct').checked = false;
  matchedId = null;
  onProductInput();
  $('product').focus();
}

function showMsg(text, isError) {
  const el = $('msg');
  el.textContent = text;
  el.className = isError ? 'error' : '';
  if (text !== 'Menyimpan…') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, isError ? 8000 : 2500);
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Ringkasan mengikuti tanggal yang dipilih di form (default: hari ini).
let statsSeq = 0;
async function refreshStats() {
  const seq = ++statsSeq;
  const [allSales, ads, settings] = await Promise.all([sales(), store.getAds(), store.getSettings()]);
  if (seq !== statsSeq) return; // ada pembaruan yang lebih baru, abaikan hasil lama
  const today = todayISO();
  const sel = /^\d{4}-\d{2}-\d{2}$/.test($('date').value) ? $('date').value : today;
  const month = sel.slice(0, 7);
  const daySales = allSales.filter(s => s.date === sel);
  const t = summarize(daySales);
  t.profit -= deductions(daySales, ads.filter(a => a.date === sel), settings).total; // setelah iklan, pajak, affiliate & biaya proses (sama dengan profit bulanan)
  const monthSales = allSales.filter(s => s.date.startsWith(month));
  const m = summarize(monthSales);
  m.profit -= deductions(monthSales, ads.filter(a => a.date.startsWith(month)), settings).total; // setelah iklan & pajak
  const [y, mo, d] = sel.split('-');
  $('dayLabel').textContent = sel === today ? 'Omzet hari ini' : `Omzet ${d}/${mo}/${y}`;
  $('monthLabel').textContent = month === today.slice(0, 7) ? 'Profit bulan ini' : `Profit ${BULAN[Number(mo) - 1]} ${y}`;
  $('todayRevenue').textContent = rupiah(t.revenue);
  $('todayOrders').textContent = `${t.orders} pesanan`;
  $('dayProfitLabel').textContent = sel === today ? 'Profit hari ini' : `Profit ${d}/${mo}`;
  $('todayProfit').textContent = rupiah(t.profit);
  $('todayMargin').textContent = t.revenue ? `Margin ${(t.profit / t.revenue * 100).toFixed(1)}%` : 'Belum ada omzet';
  $('monthProfit').textContent = rupiah(m.profit);
  $('monthRevenue').textContent = `Omzet ${rupiah(m.revenue)}`;
}

init();
