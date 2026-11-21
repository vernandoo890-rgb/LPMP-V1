const $ = id => document.getElementById(id);
let products = [];
let sales = [];
let settings = { fees: {} };
let editingId = null;
let syncing = false; // cegah loop saat margin <-> harga jual saling mengisi
let driver = 'price'; // kolom yang terakhir diisi sendiri oleh pengguna: 'margin' atau 'price'

// ---------- data turunan ----------
function soldStats() {
  const map = new Map();
  const net = netProfitMap(sales, settings); // setelah admin, modal, pajak, affiliate & biaya proses
  for (const s of sales) {
    const c = calc(s);
    if (!c.counted) continue;
    const k = productKey(s.product);
    const cur = map.get(k) || { qty: 0, profit: 0 };
    cur.qty += c.qty; cur.profit += net.get(s) || 0;
    map.set(k, cur);
  }
  return map;
}

function rowsData() {
  const stats = soldStats();
  return products.map((p, i) => {
    const m = productMargin(p);
    const st = stats.get(productKey(p.name)) || { qty: 0, profit: 0 };
    return { p, i, profit: m.profit, pct: m.pct, sold: st.qty, total: st.profit };
  });
}

function filteredRows() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('catFilter').value;
  let list = rowsData().filter(r =>
    (!cat || (r.p.category || '') === cat) &&
    (!q || [r.p.name, r.p.sku, r.p.category].some(v => String(v || '').toLowerCase().includes(q)))
  );
  const sorters = {
    name: (a, b) => a.p.name.localeCompare(b.p.name, 'id'),
    marginDesc: (a, b) => b.pct - a.pct,
    marginAsc: (a, b) => a.pct - b.pct,
    profitDesc: (a, b) => b.total - a.total,
    soldDesc: (a, b) => b.sold - a.sold,
    newest: (a, b) => b.i - a.i
  };
  return list.sort(sorters[$('sort').value] || sorters.name);
}

// ---------- render ----------
function render() {
  renderKpis();
  renderCategories();
  renderTable();
}

function renderKpis() {
  const data = rowsData();
  const withPrice = data.filter(r => r.p.price > 0);
  const avg = withPrice.length ? withPrice.reduce((a, r) => a + r.pct, 0) / withPrice.length : 0;
  const loss = data.filter(r => r.p.price > 0 && r.profit < 0).length;
  const best = withPrice.slice().sort((a, b) => b.pct - a.pct)[0];
  $('kpis').innerHTML = `
    <div class="kpi"><span>Jumlah produk</span><strong>${num(products.length)}</strong><small>${new Set(products.map(p => p.category).filter(Boolean)).size} kategori</small></div>
    <div class="kpi"><span>Rata-rata margin</span><strong>${avg.toFixed(1)}%</strong><small>sebelum biaya admin</small></div>
    <div class="kpi"><span>Margin tertinggi</span><strong>${best ? best.pct.toFixed(1) + '%' : '–'}</strong><small>${best ? escapeHtml(best.p.name) : '&nbsp;'}</small></div>
    <div class="kpi"><span>Harga di bawah kulakan</span><strong class="${loss ? 'neg' : ''}">${num(loss)}</strong><small>${loss ? 'perlu dicek ulang' : 'semua produk untung'}</small></div>`;
}

function renderCategories() {
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
  const cur = $('catFilter').value;
  $('catFilter').innerHTML = '<option value="">Semua</option>' + cats.map(c => `<option>${escapeHtml(c)}</option>`).join('');
  $('catFilter').value = cats.includes(cur) ? cur : '';
  $('catList').innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

function renderTable() {
  const list = filteredRows();
  $('count').textContent = `(${list.length}${list.length !== products.length ? ' dari ' + products.length : ''})`;
  $('empty').hidden = products.length > 0;
  $('rows').innerHTML = list.map(r => {
    const p = r.p;
    const neg = r.profit < 0;
    return `<tr data-id="${escapeHtml(p.id)}" title="Klik untuk mengedit">
      <td class="prod"><strong>${escapeHtml(p.name)}</strong>${p.sku ? `<div class="sub">SKU ${escapeHtml(p.sku)}</div>` : ''}${p.note ? `<div class="sub">${escapeHtml(p.note)}</div>` : ''}</td>
      <td data-label="Kategori">${p.category ? `<span class="badge">${escapeHtml(p.category)}</span>` : '–'}</td>
      <td class="r" data-label="Harga kulakan">${rupiah(p.cost)}</td>
      <td class="r" data-label="Harga jual">${rupiah(p.price)}</td>
      <td class="r ${neg ? 'neg' : ''}" data-label="Untung / unit">${rupiah(r.profit)}</td>
      <td class="r ${neg ? 'neg' : ''}" data-label="Margin">${p.price > 0 ? r.pct.toFixed(1) + '%' : '–'}</td>
      <td class="r" data-label="Terjual">${r.sold ? num(r.sold) : '–'}</td>
      <td class="r ${r.total < 0 ? 'neg' : ''}" data-label="Total profit">${r.sold ? rupiah(r.total) : '–'}</td>
      <td class="nowrap"><button type="button" class="edit" data-edit="${escapeHtml(p.id)}">Edit</button> <button type="button" data-del="${escapeHtml(p.id)}">Hapus</button></td>
    </tr>`;
  }).join('');
}

// ---------- pop-up saran pencarian ----------
// Muncul di bawah kolom cari saat mengetik; klik (atau Enter) pada produk membuka form edit produk itu.
let qActive = -1;
const hlText = (text, q) => {
  const t = String(text || ''), i = t.toLowerCase().indexOf(q);
  return i < 0 ? escapeHtml(t) : escapeHtml(t.slice(0, i)) + '<mark>' + escapeHtml(t.slice(i, i + q.length)) + '</mark>' + escapeHtml(t.slice(i + q.length));
};
function hideSuggest() { const b = $('qSuggest'); b.hidden = true; qActive = -1; $('q').setAttribute('aria-expanded', 'false'); }
function renderSuggest() {
  const q = $('q').value.trim().toLowerCase();
  const box = $('qSuggest');
  if (!q) return hideSuggest();
  const cat = $('catFilter').value;
  const hits = rowsData()
    .filter(r => (!cat || (r.p.category || '') === cat) && [r.p.name, r.p.sku, r.p.category].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => (String(b.p.name).toLowerCase().startsWith(q) - String(a.p.name).toLowerCase().startsWith(q)) || a.p.name.localeCompare(b.p.name, 'id'));
  qActive = -1;
  if (!hits.length) {
    box.innerHTML = '<li class="qs-empty">Tidak ada produk yang cocok.</li>';
  } else {
    const MAX = 8;
    box.innerHTML = '<li class="qs-head" aria-hidden="true">' + num(hits.length) + ' produk cocok · klik untuk mengedit' + (hits.length > MAX ? ' · menampilkan ' + MAX : '') + '</li>' +
      hits.slice(0, MAX).map(r => {
        const p = r.p;
        const info = [p.sku ? 'SKU ' + hlText(p.sku, q) : '', p.category ? hlText(p.category, q) : '', `kulakan ${rupiah(p.cost)}`, p.price > 0 ? `margin ${r.pct.toFixed(1).replace('.', ',')}%` : ''].filter(Boolean).join(' · ');
        return `<li role="option" class="qs-item" data-id="${escapeHtml(p.id)}">
          <span class="qs-main">${hlText(p.name, q)}</span><span class="qs-val">${rupiah(p.price)}</span>
          <small>${info}</small></li>`;
      }).join('');
  }
  box.hidden = false;
  $('q').setAttribute('aria-expanded', 'true');
}
function pickSuggest(li) {
  if (!li || !li.dataset.id) return;
  hideSuggest();
  startEdit(li.dataset.id);
}

// ---------- form ----------
function readForm() {
  return {
    name: $('pName').value.trim(),
    sku: $('pSku').value.trim(),
    category: $('pCat').value.trim(),
    cost: Number($('pCost').value) || 0,
    price: Number($('pPrice').value) || 0,
    note: $('pNote').value.trim()
  };
}

function updatePreview() {
  const f = readForm();
  const m = productMargin(f);
  const el = $('pPreview');
  if (f.price > 0 && m.profit < 0) {
    el.textContent = `Harga jual di bawah kulakan: rugi ${rupiah(-m.profit)} per unit`;
    el.className = 'preview warn';
  } else {
    el.textContent = `Untung per unit ${rupiah(m.profit)} · Margin ${f.price > 0 ? m.pct.toFixed(1) : '0'}%`;
    el.className = 'preview';
  }
}

// Isi margin -> harga jual dihitung. Isi harga jual -> margin diperbarui.
function fromMargin() {
  if (syncing) return;
  driver = 'margin';
  const m = $('pMargin').value;
  if (m === '') return updatePreview();
  syncing = true;
  const price = priceFromMargin($('pCost').value, m);
  $('pPrice').value = price || '';
  syncing = false;
  updatePreview();
}

function fromPrice() {
  if (syncing) return;
  driver = 'price';
  syncing = true;
  const f = readForm();
  $('pMargin').value = f.price > 0 ? Math.round(productMargin(f).pct * 10) / 10 : '';
  syncing = false;
  updatePreview();
}

function fromCost() {
  // Harga jual mengikuti kulakan hanya bila margin yang terakhir Anda isi; selain itu harga jual tetap dan margin yang diperbarui.
  const keep = driver;
  if (keep === 'margin' && $('pMargin').value !== '') fromMargin();
  else fromPrice();
  driver = keep;
}

function resetForm() {
  editingId = null;
  driver = 'price';
  $('pform').reset();
  $('formTitle').textContent = 'Tambah produk';
  $('pSave').textContent = 'Simpan produk';
  $('pCancel').hidden = true;
  updatePreview();
}

function startEdit(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  $('pName').value = p.name; $('pSku').value = p.sku || ''; $('pCat').value = p.category || '';
  $('pCost').value = p.cost; $('pPrice').value = p.price; $('pNote').value = p.note || '';
  fromPrice();
  driver = 'price';
  $('formTitle').textContent = 'Edit produk';
  $('pSave').textContent = 'Simpan perubahan';
  $('pCancel').hidden = false;
  $('pName').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('pName').focus();
  formMsg('');
}

function formMsg(text, isError) {
  const el = $('pMsg');
  el.textContent = text;
  el.className = 'wide pmsg' + (isError ? ' error' : '');
  if (text && !isError) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
}

async function onSubmit(e) {
  e.preventDefault();
  const f = readForm();
  if (!f.name) return formMsg('Nama produk wajib diisi.', true);
  if (!(f.price > 0)) return formMsg('Harga jual harus lebih dari 0.', true);
  const dup = findProduct(products, f.name);
  if (dup && dup.id !== editingId) return formMsg(`Produk "${dup.name}" sudah ada. Edit produk itu, atau pakai nama lain (mis. tambah ukuran/varian).`, true);

  const wasEdit = !!editingId, eid = editingId;
  try {
    // Pakai data terbaru dari penyimpanan, bukan salinan lama di halaman ini.
    products = await store.updateProducts(list => {
      if (list.some(p => p.id !== eid && productKey(p.name) === productKey(f.name))) throw new Error(`Produk "${f.name}" sudah ada di tab lain.`);
      return eid && list.some(p => p.id === eid) ? list.map(p => (p.id === eid ? { ...p, ...f } : p)) : list.concat({ id: uid(), ...f });
    });
  } catch (err) {
    return formMsg('Gagal menyimpan: ' + err.message, true);
  }
  resetForm();
  render();
  formMsg(wasEdit ? 'Perubahan tersimpan ✓' : 'Produk tersimpan ✓');
  $('pName').focus();
}

// ---------- aksi ----------
let noticeTimer;
// Pesan singkat; bila "aksi" ({label, run}) diberikan muncul tombol (mis. Urungkan) dan pesan bertahan lebih lama.
function notice(text, aksi) {
  const el = $('notice');
  clearTimeout(noticeTimer);
  el.textContent = text;
  if (text && aksi) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'notice-act'; b.textContent = aksi.label;
    b.addEventListener('click', async () => { b.disabled = true; try { await aksi.run(); } catch (err) { notice('Gagal: ' + err.message); } });
    el.append(' ', b);
  }
  el.hidden = !text;
  if (text) noticeTimer = setTimeout(() => { el.hidden = true; }, aksi ? 9000 : 5000);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function load() {
  [products, sales, settings] = await Promise.all([store.getProducts(), store.getSales(), store.getSettings()]);
  render();
}

function init() {
  ['pCost'].forEach(id => $(id).addEventListener('input', fromCost));
  $('pMargin').addEventListener('input', fromMargin);
  $('pPrice').addEventListener('input', fromPrice);
  $('pform').addEventListener('submit', onSubmit);
  $('pCancel').addEventListener('click', resetForm);
  ['q', 'catFilter', 'sort'].forEach(id => $(id).addEventListener('input', renderTable));
  $('q').addEventListener('input', renderSuggest);
  $('q').addEventListener('focus', renderSuggest);
  $('catFilter').addEventListener('input', () => { if (!$('qSuggest').hidden) renderSuggest(); });
  $('q').addEventListener('keydown', e => {
    const box = $('qSuggest');
    if (box.hidden) return;
    const items = [...box.querySelectorAll('.qs-item')];
    if (e.key === 'Escape') { hideSuggest(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      qActive = (qActive + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => { li.classList.toggle('active', i === qActive); li.setAttribute('aria-selected', String(i === qActive)); });
      items[qActive].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && qActive >= 0) {
      e.preventDefault();
      pickSuggest(items[qActive]);
    }
  });
  $('qSuggest').addEventListener('mousedown', e => e.preventDefault());   // jaga fokus di kolom cari agar klik tidak menutup daftar lebih dulu
  $('qSuggest').addEventListener('click', e => { e.preventDefault(); pickSuggest(e.target.closest ? e.target.closest('.qs-item') : null); });   // preventDefault: klik di dalam <label> tidak boleh melempar fokus balik ke kolom cari
  document.addEventListener('click', e => { if (!e.target.closest || !e.target.closest('.q-wrap')) hideSuggest(); });

  $('rows').addEventListener('click', async e => {
    const btn = e.target.closest ? e.target.closest('button') : null;
    const t = (btn && btn.dataset) || {};
    if (!btn) {   // klik di baris (bukan tombol) juga membuka edit produk itu
      const tr = e.target.closest ? e.target.closest('tr[data-id]') : null;
      if (tr && !(window.getSelection && String(window.getSelection()))) startEdit(tr.dataset.id);
      return;
    }
    if (t.edit) return startEdit(t.edit);
    if (t.del) {
      const p = products.find(x => x.id === t.del);
      if (!p) return;
      try { products = await store.updateProducts(list => list.filter(x => x.id !== t.del)); } catch (err) { return notice('Gagal menghapus: ' + err.message); }
      if (editingId === t.del) resetForm();
      render();
      notice(`Produk "${p.name}" dihapus. Riwayat transaksi tidak ikut terhapus.`, {
        label: 'Urungkan',
        run: async () => { await store.addProduct(p); products = await store.getProducts(); render(); notice('Penghapusan dibatalkan ✓'); }
      });
    }
  });

  $('btnExport').addEventListener('click', async () => {
    try { await load(); } catch (err) { return notice('Gagal memuat data terbaru: ' + err.message); } // data terbaru sebelum diekspor
    if (!products.length) return notice('Belum ada produk untuk diekspor.');
    download(`produk-${todayISO()}.xlsx`, xlsx.build([productsSheet(products)]), xlsx.MIME);
  });
  $('btnTemplate').addEventListener('click', () => {
    download('template-produk.xlsx', xlsx.build(productTemplateSheets()), xlsx.MIME);
  });

  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return notice('File terlalu besar (maksimal 20 MB).');
    let rows;
    try {
      if (/\.xlsx$/i.test(file.name)) rows = await xlsx.read(await file.arrayBuffer(), /^produk$/i);
      else if (/\.csv$/i.test(file.name)) rows = parseCSV(await file.text());
      else if (/\.xls$/i.test(file.name)) return notice('Format .xls lama belum didukung. Buka di Excel lalu simpan sebagai .xlsx.');
      else return notice('Format file tidak didukung. Pilih file Excel (.xlsx).');
    } catch (err) {
      return notice('Gagal membaca file: ' + err.message);
    }
    const { products: incoming, skipped, has } = rowsToProducts(rows);
    if (!incoming.length) return notice('Tidak ada baris valid. Pastikan ada kolom Nama Produk (lihat Template Excel).');
    // Baca ulang dari penyimpanan supaya tidak menimpa perubahan dari tab lain.
    let merged;
    try {
      merged = null;
      await store.updateProducts(list => { merged = mergeProducts(list, incoming, has); return merged.list; });
    } catch (err) {
      return notice('Gagal menyimpan hasil impor: ' + err.message);
    }
    products = merged.list;
    render();
    notice(`${merged.added} produk baru, ${merged.updated} diperbarui${skipped ? `, ${skipped} baris dilewati (nama kosong)` : ''}.`);
  });

  $('btnClear').addEventListener('click', async () => {
    if (!products.length) return;
    if (!confirm(`Hapus SEMUA ${products.length} produk dari menu? Riwayat transaksi tidak ikut terhapus. Ekspor Excel dulu bila perlu.`)) return;
    try { products = await store.updateProducts(() => []); } catch (err) { return notice('Gagal menghapus: ' + err.message); }
    resetForm();
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.products || changes.sales || changes.settings)) load();
  });

  updatePreview();
  load();
}

init();
