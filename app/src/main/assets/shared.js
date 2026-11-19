// Fungsi bersama untuk popup dan dashboard.
const MARKETPLACES = ['Shopee', 'Tokopedia', 'TikTok Shop', 'Lazada', 'Blibli', 'Bukalapak', 'Lainnya'];
const STATUSES = ['selesai', 'dibatalkan', 'dikembalikan'];

const store = {
  // Kunci tulis: operasi baca-ubah-tulis berjalan satu per satu, juga antar tab/popup (Web Locks API),
  // supaya dua perubahan yang hampir bersamaan tidak saling menimpa. Jangan memanggil withLock di dalam withLock.
  async withLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('laporan-marketplace-store', () => fn());
    }
    const run = (this._q || Promise.resolve()).then(() => fn());
    this._q = run.catch(() => {});
    return run;
  },
  async getSales() {
    const { sales } = await chrome.storage.local.get('sales');
    // Buang entri rusak supaya satu data jelek tidak merusak seluruh dashboard.
    return Array.isArray(sales)
      ? sales.filter(s => s && typeof s === 'object' && typeof s.date === 'string' && typeof s.product === 'string')
      : [];
  },
  async setSales(sales) {
    await chrome.storage.local.set({ sales });
  },
  async addSale(sale) {
    return this.withLock(async () => {
      const sales = await this.getSales();
      sales.push(sale);
      await this.setSales(sales);
    });
  },
  // Selalu baca ulang dari penyimpanan sebelum mengubah, agar tidak menimpa data yang baru dicatat dari popup.
  async removeSale(id) {
    return this.withLock(async () => {
      const sales = (await this.getSales()).filter(s => s.id !== id);
      await this.setSales(sales);
      return sales;
    });
  },
  // Ubah satu transaksi (baca ulang dulu dari penyimpanan). Mengembalikan daftar terbaru, atau null bila id tidak ditemukan.
  async updateSale(id, patch) {
    return this.withLock(async () => {
      const sales = await this.getSales();
      const i = sales.findIndex(s => s.id === id);
      if (i < 0) return null;
      sales[i] = { ...sales[i], ...patch, id };
      await this.setSales(sales);
      return sales;
    });
  },
  async appendSales(incoming) {
    return this.withLock(async () => {
      const { list, added, duplicates } = mergeSales(await this.getSales(), incoming);
      await this.setSales(list);
      return { list, added, duplicates };
    });
  },
  async getAds() {
    const { ads } = await chrome.storage.local.get('ads');
    return Array.isArray(ads)
      ? ads.filter(a => a && typeof a === 'object' && typeof a.date === 'string' && Number(a.amount) >= 0)
      : [];
  },
  async setAds(ads) {
    await chrome.storage.local.set({ ads });
  },
  async addAd(ad) {
    return this.withLock(async () => {
      const ads = await this.getAds();
      ads.push(ad);
      await this.setAds(ads);
    });
  },
  async removeAd(id) {
    return this.withLock(async () => {
      const ads = (await this.getAds()).filter(a => a.id !== id);
      await this.setAds(ads);
      return ads;
    });
  },
  async getProducts() {
    const { products } = await chrome.storage.local.get('products');
    return Array.isArray(products) ? products.filter(p => p && typeof p === 'object' && typeof p.name === 'string') : [];
  },
  async setProducts(products) {
    await chrome.storage.local.set({ products });
  },
  async addProduct(product) {
    return this.withLock(async () => {
      const products = await this.getProducts();
      products.push(product);
      await this.setProducts(products);
    });
  },
  // Ubah daftar produk dari data TERBARU di penyimpanan. fn(list) mengembalikan daftar baru; hasilnya disimpan dan dikembalikan.
  async updateProducts(fn) {
    return this.withLock(async () => {
      const next = await fn(await this.getProducts());
      await this.setProducts(next);
      return next;
    });
  },
  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return settings || { fees: {} };
  },
  async setSettings(settings) {
    await chrome.storage.local.set({ settings });
  },
  // Ubah pengaturan dari data TERBARU. fn(settings) boleh mengubah objek langsung atau mengembalikan objek baru.
  async updateSettings(fn) {
    return this.withLock(async () => {
      const cur = await this.getSettings();
      const next = (await fn(cur)) || cur;
      await this.setSettings(next);
      return next;
    });
  }
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad(n) { return String(n).padStart(2, '0'); }

function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO() { return toISODate(new Date()); }

// Memanggil cb(hariBaru, hariLama) saat tanggal berganti (lewat tengah malam) selagi halaman terbuka.
// Dicek tiap 30 detik, dan juga saat jendela kembali aktif (timer ditunda browser pada tab latar belakang).
function onDayChange(cb) {
  let last = todayISO();
  const check = () => {
    const now = todayISO();
    if (now !== last) { const old = last; last = now; cb(now, old); }
  };
  setInterval(check, 30000);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  if (typeof window !== 'undefined') window.addEventListener('focus', check);
}

// 'YYYY-MM-DD' -> Date pada tengah malam WAKTU LOKAL. (new Date('YYYY-MM-DD') = UTC, menggeser hari di zona waktu barat.)
function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// Tanggal kalender yang benar-benar ada (menolak 2026-02-30, bulan 13, tahun ngawur).
function validYMD(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function rupiah(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (v < 0 ? '-Rp ' : 'Rp ') + s;
}

function num(n) {
  return (Math.round(Number(n) || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Hitung angka per transaksi. Hanya status "selesai" yang dihitung sebagai omzet.
function calc(s) {
  const qty = Number(s.qty) || 0;
  const price = Number(s.price) || 0;
  const cogs = Number(s.cogs) || 0;
  const feePct = Number(s.feePct) || 0;
  const other = Number(s.otherCost) || 0;
  const counted = s.status === 'selesai';
  // Omzet tertera di marketplace (total baris produk, belum dikurangi kulakan): bila diisi, dipakai menggantikan qty x harga jual.
  const omzetMp = Number(s.omzetMp) || 0;
  const revenue = counted ? (omzetMp > 0 ? omzetMp : qty * price) : 0;
  const fee = revenue * feePct / 100;
  const hpp = counted ? qty * cogs : 0;
  const otherCost = counted ? other : 0;
  const profit = revenue - fee - hpp - otherCost;
  return { revenue, fee, hpp, otherCost, profit, qty: counted ? qty : 0, counted };
}

// Satu resi / no. pesanan (di marketplace yang sama) = satu pesanan, walau berisi beberapa produk.
// Mengembalikan '' bila transaksi tidak punya resi (dianggap pesanan sendiri).
function orderKeyOf(s) {
  const no = String(s.orderNo || '').trim().toLowerCase();
  return no ? String(s.marketplace || '').trim().toLowerCase() + '|' + no : '';
}

// Transaksi yang menanggung biaya proses pesanan: hanya satu baris per pesanan (baris selesai pertama dengan resi itu).
// Baris tanpa resi menanggung sendiri. Dipakai agar biaya proses tidak terhitung berkali-kali untuk 1 resi.
function feeCarriers(sales) {
  const seen = new Set(), out = new Set();
  for (const s of sales || []) {
    if (!calc(s).counted) continue;
    const k = orderKeyOf(s);
    if (k) { if (seen.has(k)) continue; seen.add(k); }
    out.add(s);
  }
  return out;
}

function summarize(sales) {
  const t = { revenue: 0, fee: 0, hpp: 0, otherCost: 0, profit: 0, qty: 0, orders: 0, cancelled: 0 };
  const seenOrders = new Set();
  for (const s of sales) {
    const c = calc(s);
    if (c.counted) {
      t.revenue += c.revenue; t.fee += c.fee; t.hpp += c.hpp;
      t.otherCost += c.otherCost; t.profit += c.profit; t.qty += c.qty;
      const ok = orderKeyOf(s);
      if (!ok || !seenOrders.has(ok)) { t.orders += 1; if (ok) seenOrders.add(ok); }
    } else {
      t.cancelled += 1;
    }
  }
  t.margin = t.revenue ? (t.profit / t.revenue) * 100 : 0;
  t.aov = t.orders ? t.revenue / t.orders : 0;
  return t;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// Selisih hari kalender antar dua 'YYYY-MM-DD' (UTC, jadi tidak terpengaruh DST/zona waktu).
function dayDiff(a, b) {
  const u = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((u(b) - u(a)) / 86400000);
}

// Periode pembanding untuk rentang {from,to}. null bila rentang tidak berbatas ("Semua", atau tanggal kustom kosong).
// - "Bulan ini" (belum penuh): bulan lalu dengan jumlah hari yang sama, supaya adil.
// - Satu bulan kalender penuh: bulan kalender sebelumnya.
// - Selain itu: rentang sebelumnya yang sama panjang, berakhir sehari sebelum "from".
function previousRange(period, from, to, today) {
  if (from.startsWith('0000') || to.startsWith('9999') || from > to) return null;
  const f = parseISO(from), t = parseISO(to);
  if (period === 'month') {
    const pf = new Date(f.getFullYear(), f.getMonth() - 1, 1);
    const lastDay = new Date(f.getFullYear(), f.getMonth(), 0).getDate();
    const n = Math.min(parseISO(today).getDate(), lastDay);
    return { from: toISODate(pf), to: toISODate(new Date(pf.getFullYear(), pf.getMonth(), n)) };
  }
  const fullMonth = f.getDate() === 1 && f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth()
    && t.getDate() === new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  if (fullMonth) {
    return { from: toISODate(new Date(f.getFullYear(), f.getMonth() - 1, 1)), to: toISODate(new Date(f.getFullYear(), f.getMonth(), 0)) };
  }
  const n = dayDiff(from, to) + 1;
  const pt = addDays(f, -1);
  return { from: toISODate(addDays(pt, -(n - 1))), to: toISODate(pt) };
}

// Selisih persen terhadap periode pembanding. null bila pembanding 0 (tidak bisa dibuat persen).
function pctChange(cur, prev) {
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

// ---------- Cadangan & pemulihan (JSON) ----------
const BACKUP_APP = 'laporan-marketplace';

function buildBackup(data) {
  return {
    app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(),
    sales: data.sales || [], ads: data.ads || [], products: data.products || [], settings: data.settings || {}
  };
}

// Bersihkan data dari file cadangan: buang entri rusak, paksa angka tidak negatif, status valid.
function sanitizeSale(s) {
  if (!s || typeof s !== 'object' || typeof s.date !== 'string') return null;
  const m = s.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !validYMD(m[1], m[2], m[3])) return null;
  const price = Number(s.price);
  if (typeof s.product !== 'string' || !isFinite(price) || price <= 0) return null;
  const nn = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  return {
    id: typeof s.id === 'string' && s.id ? s.id : uid(),
    date: s.date, marketplace: normalizeMarketplace(s.marketplace), product: s.product.trim() || '(tanpa nama)',
    qty: nn(s.qty) || 1, price, cogs: nn(s.cogs), feePct: Math.min(100, nn(s.feePct)), otherCost: nn(s.otherCost),
    status: STATUSES.includes(s.status) ? s.status : 'selesai',
    orderNo: String(s.orderNo || '').trim().slice(0, 80),
    omzetMp: nn(s.omzetMp)
  };
}

function sanitizeAd(a) {
  if (!a || typeof a !== 'object' || typeof a.date !== 'string') return null;
  const m = a.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const amount = Number(a.amount);
  if (!m || !validYMD(m[1], m[2], m[3]) || !(amount > 0) || !isFinite(amount)) return null;
  return { id: typeof a.id === 'string' && a.id ? a.id : uid(), date: a.date, marketplace: String(a.marketplace || '').trim() || 'Lainnya', amount, note: String(a.note || '').trim() };
}

function sanitizeProduct(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) return null;
  const nn = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const str = v => String(v ?? '').trim();
  return { id: typeof p.id === 'string' && p.id ? p.id : uid(), name: p.name.trim(), sku: str(p.sku), category: str(p.category), cost: nn(p.cost), price: nn(p.price), note: str(p.note) };
}

// Teks JSON -> { sales, ads, products, settings, skipped } atau lempar Error bila bukan cadangan yang valid.
function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('File bukan JSON yang valid.'); }
  if (!obj || obj.app !== BACKUP_APP || !Array.isArray(obj.sales)) throw new Error('Ini bukan file cadangan Laporan Marketplace.');
  let skipped = 0;
  const clean = (arr, fn) => (Array.isArray(arr) ? arr : []).map(fn).filter(x => { if (!x) skipped++; return !!x; });
  const rawSettings = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  const pctMap = o => {
    const out = {};
    if (o && typeof o === 'object') for (const k of Object.keys(o)) out[k] = cleanFee(o[k]);
    return out;
  };
  const rpMap = o => {
    const out = {};
    if (o && typeof o === 'object') for (const k of Object.keys(o)) out[k] = cleanRp(o[k]);
    return out;
  };
  const settings = { fees: pctMap(rawSettings.fees), taxes: pctMap(rawSettings.taxes), affiliate: pctMap(rawSettings.affiliate), procFee: rpMap(rawSettings.procFee) };
  // PPN iklan hanya ikut dipulihkan bila ada di file; cadangan lama tanpa kolom ini tidak boleh menimpanya jadi 0.
  if (rawSettings.adTax !== undefined && rawSettings.adTax !== null && rawSettings.adTax !== '') settings.adTax = cleanFee(rawSettings.adTax);
  if (typeof rawSettings.lastMarketplace === 'string') settings.lastMarketplace = rawSettings.lastMarketplace;
  // Target bulanan (omzet & profit bersih, Rp). Hanya dipulihkan bila ada di file cadangan.
  // Biaya tetap bulanan: daftar { id, name, amount } (maks. 100).
  if (Array.isArray(rawSettings.fixedCosts)) {
    settings.fixedCosts = rawSettings.fixedCosts.slice(0, 100).map(x => ({ id: String((x && x.id) || uid()).slice(0, 40), name: String((x && x.name) || '').trim().slice(0, 60), amount: cleanRp(x && x.amount) })).filter(x => x.name && x.amount > 0);
  }
  if (rawSettings.targets && typeof rawSettings.targets === 'object') settings.targets = { revenue: cleanRp(rawSettings.targets.revenue), profit: cleanRp(rawSettings.targets.profit) };
  return { sales: clean(obj.sales, sanitizeSale), ads: clean(obj.ads, sanitizeAd), products: clean(obj.products, sanitizeProduct), settings, skipped };
}

function adSig(a) { return [a.date, String(a.marketplace || '').toLowerCase(), Number(a.amount) || 0, String(a.note || '').trim().toLowerCase()].join('|'); }

// Gabungkan cadangan ke data sekarang tanpa menghapus apa pun. Duplikat dilewati; pengaturan dari cadangan menimpa kunci yang sama.
// Entri dengan id yang sudah ada dianggap record yang sama (mis. sudah diedit setelah dicadangkan) dan tidak ditimpa.
function mergeBackup(cur, bk) {
  const saleIds = new Set(cur.sales.map(x => x.id));
  const newSales = bk.sales.filter(x => !saleIds.has(x.id));
  const s = mergeSales(cur.sales, newSales);
  s.duplicates += bk.sales.length - newSales.length;
  const adIds = new Set(cur.ads.map(x => x.id));
  const have = new Map();
  for (const a of cur.ads) { const k = adSig(a); have.set(k, (have.get(k) || 0) + 1); }
  const adList = cur.ads.slice();
  let adsAdded = 0;
  for (const a of bk.ads) {
    if (adIds.has(a.id)) continue;
    const k = adSig(a), n = have.get(k) || 0;
    if (n > 0) { have.set(k, n - 1); continue; }
    adList.push(a); adsAdded++;
  }
  const p = mergeProducts(cur.products, bk.products, { cost: true, price: true });
  const cs = cur.settings || {};
  const settings = {
    ...cs, ...bk.settings,
    fees: { ...(cs.fees || {}), ...bk.settings.fees },
    taxes: { ...(cs.taxes || {}), ...bk.settings.taxes },
    affiliate: { ...(cs.affiliate || {}), ...bk.settings.affiliate },
    procFee: { ...(cs.procFee || {}), ...bk.settings.procFee }
  };
  if (!bk.settings.lastMarketplace) { if (cs.lastMarketplace) settings.lastMarketplace = cs.lastMarketplace; else delete settings.lastMarketplace; }
  return { sales: s.list, ads: adList, products: p.list, settings,
    counts: { sales: s.added, salesDup: s.duplicates, ads: adsAdded, products: p.added, productsUpdated: p.updated } };
}

// ---------- Impor/ekspor tabel (Excel; CSV lama hanya untuk impor) ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  // deteksi pemisah: koma atau titik koma (Excel Indonesia sering pakai ;)
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* abaikan */ }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const SALE_HEADERS = ['Tanggal', 'Marketplace', 'Nama Produk', 'Qty', 'Harga Satuan (Rp)', 'Modal Satuan (Rp)', 'Biaya Admin (%)', 'Biaya Lain (Rp)', 'Status', 'No. Pesanan / Resi', 'Omzet di Marketplace (Rp)'];
// Judul kolom dibandingkan tanpa beda huruf besar/kecil dan garis bawah, jadi file lama (harga_satuan) maupun baru (Harga Satuan (Rp)) tetap terbaca.
const hk = h => String(h ?? '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');

// Sheet Excel berisi transaksi. Tanggal ditulis sebagai tanggal Excel asli, angka sebagai angka.
function salesSheet(sales) {
  const S = xlsx.STYLE;
  const rows = [SALE_HEADERS.map(h => ({ v: h, s: S.header }))];
  for (const s of sales) {
    rows.push([
      { d: s.date }, s.marketplace || '', s.product || '',
      { v: Number(s.qty) || 0 },
      { v: Number(s.price) || 0, s: S.money },
      { v: Number(s.cogs) || 0, s: S.money },
      { v: Number(s.feePct) || 0 },
      { v: Number(s.otherCost) || 0, s: S.money },
      s.status || 'selesai', s.orderNo || '',
      { v: Number(s.omzetMp) || 0, s: S.money }
    ]);
  }
  return { name: 'Penjualan', rows, widths: [13, 16, 36, 8, 18, 18, 15, 16, 14, 24, 24], freeze: true, filter: true,
    headerHeight: 34, gridRows: sales.length ? [2, sales.length + 1] : undefined, tab: 'FF0F766E',
    validations: sales.length ? [{ sqref: `I2:I${sales.length + 1}`, list: STATUSES.join(',') }] : [] };
}

// Template impor: sheet Penjualan (1 baris contoh) + sheet Petunjuk.
function templateSheets() {
  const S = xlsx.STYLE;
  const sample = { date: todayISO(), marketplace: 'Shopee', product: 'Contoh produk', qty: 2, price: 75000, cogs: 40000, feePct: 8, otherCost: 0, status: 'selesai', orderNo: 'SPXID0123456789' };
  const help = [
    ['Kolom', 'Keterangan'],
    ['Tanggal', 'Wajib. Tanggal Excel biasa, atau teks YYYY-MM-DD / DD/MM/YYYY.'],
    ['Marketplace', 'Shopee, Tokopedia, TikTok Shop, Lazada, Blibli, Bukalapak, atau nama lain.'],
    ['Nama Produk', 'Nama produk.'],
    ['Qty', 'Jumlah unit. Kosong = 1.'],
    ['Harga Satuan (Rp)', 'Wajib. Harga jual per unit (Rp), angka saja.'],
    ['Modal Satuan (Rp)', 'Modal / HPP per unit (Rp).'],
    ['Biaya Admin (%)', 'Biaya admin dalam persen, mis. 8 untuk 8%.'],
    ['Biaya Lain (Rp)', 'Biaya lain per transaksi (Rp), mis. ongkir yang ditanggung penjual.'],
    ['Status', 'selesai, dibatalkan, atau dikembalikan. Kosong = selesai.'],
    ['No. Pesanan / Resi', 'Opsional. Nomor resi atau nomor pesanan marketplace; bisa dicari di Dashboard dan popup.'],
    ['Omzet di Marketplace (Rp)', 'Opsional. Total omzet baris produk yang tertera di marketplace (Rp), belum dikurangi kulakan. Bila diisi, dipakai menggantikan Qty x Harga Satuan.'],
    ['', ''],
    ['Catatan', 'Hapus baris contoh sebelum mengisi. Yang dibaca hanya sheet "Penjualan" (atau sheet pertama); sheet ini diabaikan.']
  ].map((r, i) => r.map(c => (i === 0 ? { v: c, s: S.header } : c === '' ? '' : { v: c, s: S.wrap })));
  const tpl = salesSheet([sample]);
  tpl.validations = [{ sqref: 'I2:I2000', list: STATUSES.join(',') }]; // menu pilihan status sampai baris 2000
  return [
    tpl,
    { name: 'Petunjuk', rows: help, widths: [26, 80], headerHeight: 24, gridRows: [2, help.length], tab: 'FFB45309', landscape: false }
  ];
}

const ALIASES = {
  date: ['tanggal', 'date', 'tgl', 'waktu pesanan dibuat', 'waktu pembayaran'],
  marketplace: ['marketplace', 'platform', 'toko'],
  product: ['produk', 'product', 'nama produk', 'nama_produk', 'item'],
  qty: ['qty', 'jumlah', 'kuantitas', 'quantity'],
  price: ['harga_satuan', 'harga', 'price', 'harga satuan', 'harga awal', 'harga satuan (rp)'],
  cogs: ['modal_satuan', 'modal', 'hpp', 'cogs', 'harga modal', 'modal satuan (rp)'],
  feePct: ['fee_persen', 'fee', 'fee (%)', 'biaya admin', 'biaya admin (%)'],
  otherCost: ['biaya_lain', 'biaya lain', 'ongkir', 'other', 'biaya lain (rp)'],
  status: ['status', 'status pesanan'],
  omzetMp: ['omzet_marketplace', 'omzet marketplace', 'omzet tertera', 'omzet tertera di marketplace', 'omzet di marketplace', 'omzet di marketplace (rp)'],
  orderNo: ['no_pesanan', 'no pesanan', 'nomor pesanan', 'no. pesanan', 'resi', 'no resi', 'nomor resi', 'no. resi', 'order id', 'order_id', 'order no', 'no. pesanan / resi']
};

function parseNumber(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0; // angka asli dari Excel, tanpa tebak-tebakan format
  let s = String(v).trim().replace(/[Rp\s]/gi, '');
  if (!s) return 0;
  // "1.250.000" -> 1250000 ; "1,250,000" -> 1250000 ; "12,5" -> 12.5
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const NAMA_BULAN = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5,
  jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, agu: 8, ags: 8, agt: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11, des: 12, desember: 12, dec: 12, december: 12
};
function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/);                 // 2026-11-19, 2026/11/19
  if (m) return validYMD(m[1], m[2], m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?!\d)/);                  // 19/11/2026, 19-11-2026, 19.11.2026
  if (m) return validYMD(m[3], m[2], m[1]) ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : '';
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})(?!\d)/);                    // 19/11/26 -> 2026
  if (m) { const y = 2000 + Number(m[3]); return validYMD(y, m[2], m[1]) ? `${y}-${pad(m[2])}-${pad(m[1])}` : ''; }
  m = s.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})\.?,?[\s\-\/.]+(\d{4})(?!\d)/);   // 19 Nov 2026, 19 November 2026, 19-Nov-2026
  if (m && NAMA_BULAN[m[2].toLowerCase()]) { const mo = NAMA_BULAN[m[2].toLowerCase()]; return validYMD(m[3], mo, m[1]) ? `${m[3]}-${pad(mo)}-${pad(m[1])}` : ''; }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/);                  // Nov 19, 2026
  if (m && NAMA_BULAN[m[1].toLowerCase()]) { const mo = NAMA_BULAN[m[1].toLowerCase()]; return validYMD(m[3], mo, m[2]) ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : ''; }
  // nomor seri tanggal Excel yang tidak diberi format tanggal (mis. 46000)
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) >= 25569 && Number(s) < 80000) {
    const d = new Date(Math.floor(Number(s) - 25569) * 86400000);
    return validYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
      ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : '';
  }
  return '';
}

function normalizeStatus(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return 'selesai';
  if (/batal|cancel/.test(s)) return 'dibatalkan';
  if (/kembali|retur|return|refund/.test(s)) return 'dikembalikan';
  return 'selesai';
}

// Satukan penulisan lain dari nama yang sama (mis. "Tokped", "TikTok", "tiktokshop") supaya data tidak terpecah dan biaya admin tetap terbaca.
const MP_ALIAS = {
  shopee: 'Shopee', tokopedia: 'Tokopedia', tokped: 'Tokopedia', tiktokshop: 'TikTok Shop', tiktok: 'TikTok Shop',
  lazada: 'Lazada', blibli: 'Blibli', bukalapak: 'Bukalapak', lainnya: 'Lainnya'
};
function normalizeMarketplace(v) {
  const s = String(v || '').trim();
  if (!s) return 'Lainnya';
  const key = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return MP_ALIAS[key] || MARKETPLACES.find(m => m.toLowerCase() === s.toLowerCase()) || s;
}

// Ubah baris tabel (dari Excel atau CSV) menjadi daftar transaksi. Mengembalikan { sales, skipped }.
function rowsToSales(rows) {
  rows = rows.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (rows.length < 2) return { sales: [], skipped: 0 };
  const header = rows[0].map(hk);
  const idx = {};
  for (const key in ALIASES) {
    const al = ALIASES[key].map(hk);
    idx[key] = header.findIndex(h => al.includes(h));
  }
  const get = (r, k) => (idx[k] >= 0 ? r[idx[k]] : '');
  const sales = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    // Baris TOTAL / RINCIAN JUMLAH di bawah tabel (hasil ekspor) bukan transaksi: berhenti di sini tanpa dihitung sebagai baris rusak.
    if (/^(total|rincian)/i.test(String(get(r, 'date') ?? '').trim())) break;
    const date = parseDate(get(r, 'date'));
    const price = parseNumber(get(r, 'price'));
    if (!date || !(price > 0)) { skipped++; continue; }
    const qty = parseNumber(get(r, 'qty'));
    const nonNeg = k => Math.max(0, parseNumber(get(r, k)));
    sales.push({
      id: uid(),
      date,
      marketplace: normalizeMarketplace(get(r, 'marketplace')),
      product: String(get(r, 'product') || '').trim() || '(tanpa nama)',
      qty: qty > 0 ? qty : 1,
      price,
      cogs: nonNeg('cogs'),
      feePct: Math.min(100, nonNeg('feePct')),
      otherCost: nonNeg('otherCost'),
      status: normalizeStatus(get(r, 'status')),
      orderNo: String(get(r, 'orderNo') ?? '').trim().slice(0, 80),
      omzetMp: nonNeg('omzetMp')
    });
  }
  return { sales, skipped };
}

// Tanda pengenal transaksi untuk mendeteksi impor ganda (id acak tidak ikut dibandingkan).
function saleSig(s) {
  return [s.date, String(s.marketplace || '').toLowerCase(), productKey(s.product), Number(s.qty) || 0, Number(s.price) || 0,
    Number(s.cogs) || 0, Number(s.feePct) || 0, Number(s.otherCost) || 0, s.status, String(s.orderNo || '').trim().toLowerCase(), Number(s.omzetMp) || 0].join('|');
}

// Gabungkan hasil impor. Baris yang persis sama dengan transaksi yang sudah ada dianggap duplikat
// (mis. file ekspor diimpor dua kali) dan dilewati. Transaksi kembar yang memang ada di file tetap masuk
// selama jumlahnya tidak melebihi yang sudah tercatat.
function mergeSales(existing, incoming) {
  const have = new Map();
  for (const s of existing) { const k = saleSig(s); have.set(k, (have.get(k) || 0) + 1); }
  const list = existing.slice();
  let added = 0, duplicates = 0;
  for (const s of incoming) {
    const k = saleSig(s);
    const n = have.get(k) || 0;
    if (n > 0) { have.set(k, n - 1); duplicates++; continue; }
    list.push(s); added++;
  }
  return { list, added, duplicates };
}

// CSV lama (hasil ekspor versi sebelumnya) tetap bisa diimpor.
function csvToSales(text) { return rowsToSales(parseCSV(text)); }

// ---------- Biaya admin per marketplace ----------
// settings.fees = { 'Shopee': 8, ... } (persen dari omzet). Nilai harus 0-100.
function cleanFee(v) {
  const n = Number(v);
  return isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

// settings.affiliate = { marketplace: % komisi affiliate dari omzet }.
// settings.procFee   = { marketplace: Rp biaya proses per pesanan selesai }.
function cleanRp(v) {
  const n = Number(v);
  return isFinite(n) ? Math.min(1e9, Math.max(0, n)) : 0;
}

// Biaya per transaksi yang diambil dari pengaturan marketplace (berlaku untuk semua transaksi, juga yang lama).
function saleExtras(s, settings, carrier = true) {
  const st = settings || {};
  const c = calc(s);
  if (!c.counted) return { tax: 0, affiliate: 0, procFee: 0 };
  const mp = s.marketplace;
  return {
    tax: c.revenue * cleanFee((st.taxes || {})[mp]) / 100,
    affiliate: c.revenue * cleanFee((st.affiliate || {})[mp]) / 100,
    procFee: carrier ? cleanRp((st.procFee || {})[mp]) : 0 // biaya proses: sekali per pesanan (lihat feeCarriers)
  };
}

// Profit tiap transaksi setelah biaya admin, modal, biaya lain, pajak, affiliate & biaya proses pesanan (sebelum iklan).
// Mengembalikan Map(transaksi -> angka). Biaya proses hanya dibebankan ke satu baris per resi (lihat feeCarriers),
// jadi jumlahnya sama dengan "Profit bersih" di dashboard (di luar iklan).
function netProfitMap(sales, settings) {
  const carriers = feeCarriers(sales);
  const out = new Map();
  for (const s of sales || []) {
    const c = calc(s);
    const x = saleExtras(s, settings, carriers.has(s));
    out.set(s, c.profit - x.tax - x.affiliate - x.procFee);
  }
  return out;
}

// Profit kotor tiap transaksi = omzet - biaya admin - biaya lain - affiliate - biaya proses pesanan (SEBELUM modal, pajak & iklan).
// Jumlah semua barisnya sama dengan "Profit kotor" di dashboard dan di sheet Ringkasan.
function grossProfitMap(sales, settings) {
  const carriers = feeCarriers(sales);
  const out = new Map();
  for (const s of sales || []) {
    const c = calc(s);
    const x = saleExtras(s, settings, carriers.has(s));
    out.set(s, c.revenue - c.fee - c.otherCost - x.affiliate - x.procFee);
  }
  return out;
}

// ---------- Iklan & pajak ----------
// settings.adTax = PPN iklan (% dari biaya iklan); settings.taxes = { marketplace: % pajak dari omzet }.
// Iklan: { id, date, marketplace, amount, note }.
function deductions(sales, ads, settings) {
  const st = settings || {};
  const adTaxPct = cleanFee(st.adTax);
  let adSpend = 0, adTax = 0, tax = 0, affiliate = 0, procFee = 0;
  for (const a of ads || []) {
    const amt = Number(a.amount) || 0;
    adSpend += amt;
    adTax += amt * adTaxPct / 100;
  }
  const carriers = feeCarriers(sales);
  for (const s of sales || []) {
    const x = saleExtras(s, st, carriers.has(s));
    tax += x.tax; affiliate += x.affiliate; procFee += x.procFee;
  }
  // total = semua pengurang di luar biaya admin, modal & biaya lain (iklan, PPN iklan, pajak, affiliate, biaya proses pesanan)
  return { adSpend, adTax, tax, affiliate, procFee, total: adSpend + adTax + tax + affiliate + procFee };
}

// ---------- Menu produk: harga kulakan & harga jual ----------
// Bentuk data: { id, name, sku, category, cost (harga kulakan), price (harga jual), note }
function productKey(name) { return String(name || '').trim().toLowerCase(); }

function findProduct(products, name) {
  const k = productKey(name);
  return k ? products.find(p => productKey(p.name) === k) : undefined;
}

// Untung kotor per unit (sebelum biaya admin marketplace) dan margin terhadap harga jual.
function productMargin(p) {
  const cost = Number(p.cost) || 0;
  const price = Number(p.price) || 0;
  const profit = price - cost;
  const pct = price > 0 ? (profit / price) * 100 : 0;
  return { profit, pct };
}

// Harga jual dari harga kulakan + target margin (% dari harga jual). Margin harus < 100 (negatif = jual rugi).
function priceFromMargin(cost, marginPct) {
  const c = Number(cost) || 0, m = Number(marginPct) || 0;
  if (m >= 100) return 0;
  return Math.round(c / (1 - m / 100));
}

const PRODUCT_HEADERS = ['Nama Produk', 'SKU', 'Kategori', 'Harga Kulakan (Rp)', 'Harga Jual (Rp)', 'Catatan', 'Untung per Unit (Rp)', 'Margin (%)'];

// Sheet Excel "Produk". Dua kolom terakhir hasil hitung, hanya informasi (diabaikan saat impor).
function productsSheet(products) {
  const S = xlsx.STYLE;
  const rows = [PRODUCT_HEADERS.map(h => ({ v: h, s: S.header }))];
  for (const p of products) {
    const m = productMargin(p);
    rows.push([
      p.name, p.sku || '', p.category || '',
      { v: Number(p.cost) || 0, s: S.money },
      { v: Number(p.price) || 0, s: S.money },
      p.note || '',
      { v: m.profit, s: S.money },
      { v: Math.round(m.pct * 10) / 10 }
    ]);
  }
  const last = products.length + 1;
  return { name: 'Produk', rows, widths: [36, 14, 16, 19, 18, 28, 20, 13], freeze: true, filter: true, headerHeight: 34, tab: 'FF8B5CF6',
    gridRows: products.length ? [2, last] : undefined,
    cf: products.length ? [{ sqref: `G2:G${last}`, op: 'lessThan', val: 0, dxf: 0 }, { sqref: `H2:H${last}`, op: 'lessThan', val: 0, dxf: 0 }] : [] };
}

function productTemplateSheets() {
  const S = xlsx.STYLE;
  const sample = { name: 'Contoh produk', sku: 'SKU-001', category: 'Fashion', cost: 40000, price: 75000, note: '' };
  const help = [
    ['Kolom', 'Keterangan'],
    ['Nama Produk', 'Wajib. Nama unik; bila sudah ada di menu produk, datanya diperbarui.'],
    ['SKU', 'Opsional. Kode produk Anda.'],
    ['Kategori', 'Opsional. Untuk pengelompokan dan filter.'],
    ['Harga Kulakan (Rp)', 'Harga beli / modal per unit (Rp), angka saja.'],
    ['Harga Jual (Rp)', 'Harga jual per unit (Rp), angka saja.'],
    ['Catatan', 'Opsional.'],
    ['Untung per Unit (Rp), Margin (%)', 'Hasil hitung otomatis di aplikasi; diabaikan saat impor.'],
    ['', ''],
    ['Catatan', 'Hapus baris contoh sebelum mengisi. Yang dibaca hanya sheet "Produk" (atau sheet pertama).']
  ].map((r, i) => r.map(c => (i === 0 ? { v: c, s: S.header } : c === '' ? '' : { v: c, s: S.wrap })));
  return [productsSheet([sample]), { name: 'Petunjuk', rows: help, widths: [32, 80], headerHeight: 24, gridRows: [2, help.length], tab: 'FFB45309', landscape: false }];
}

const PRODUCT_ALIASES = {
  name: ['nama_produk', 'nama produk', 'produk', 'product', 'nama', 'item'],
  sku: ['sku', 'kode', 'kode produk'],
  category: ['kategori', 'category', 'jenis'],
  cost: ['harga_kulakan', 'harga kulakan', 'kulakan', 'modal', 'modal_satuan', 'hpp', 'harga modal', 'harga beli', 'harga kulakan (rp)'],
  price: ['harga_jual', 'harga jual', 'harga', 'price', 'harga_satuan', 'harga jual (rp)'],
  note: ['catatan', 'note', 'keterangan']
};

// Baris tabel -> daftar produk. has = kolom harga mana yang ada di file (untuk memperbarui, bukan menimpa dengan 0).
function rowsToProducts(rows) {
  rows = rows.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (rows.length < 2) return { products: [], skipped: 0, has: {} };
  const header = rows[0].map(hk);
  const idx = {};
  for (const key in PRODUCT_ALIASES) { const al = PRODUCT_ALIASES[key].map(hk); idx[key] = header.findIndex(h => al.includes(h)); }
  const get = (r, k) => (idx[k] >= 0 ? r[idx[k]] : '');
  const str = (r, k) => String(get(r, k) ?? '').trim();
  const products = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const name = str(r, 'name');
    if (!name) { skipped++; continue; }
    products.push({
      id: uid(), name, sku: str(r, 'sku'), category: str(r, 'category'),
      cost: Math.max(0, parseNumber(get(r, 'cost'))), price: Math.max(0, parseNumber(get(r, 'price'))), note: str(r, 'note')
    });
  }
  return { products, skipped, has: { cost: idx.cost >= 0, price: idx.price >= 0, sku: idx.sku >= 0, category: idx.category >= 0, note: idx.note >= 0 } };
}

// Gabungkan hasil impor ke daftar yang ada: nama sama -> diperbarui, nama baru -> ditambah.
function mergeProducts(existing, incoming, has) {
  const list = existing.map(p => ({ ...p }));
  let added = 0, updated = 0;
  for (const n of incoming) {
    const cur = findProduct(list, n.name);
    if (!cur) { list.push(n); added++; continue; }
    if (has.cost) cur.cost = n.cost;
    if (has.price) cur.price = n.price;
    if (n.sku) cur.sku = n.sku;
    if (n.category) cur.category = n.category;
    if (n.note) cur.note = n.note;
    updated++;
  }
  return { list, added, updated };
}



// ---------- Impor laporan penghasilan Shopee ----------
// File "Laporan Penghasilan" dari Seller Centre Shopee: sheet "Penghasilan" berisi baris "Order" (total satu pesanan) dan baris "Sku"
// (satu per produk). Kita pakai baris Sku sebagai transaksi. Laporan ini TIDAK mencantumkan jumlah (qty) maupun harga modal:
// qty diperkirakan dari harga (kelipatan harga yang paling sering muncul untuk produk itu), modal diisi pengguna / diambil dari Menu Produk.
function noSpaceKey(name) { return String(name || '').toLowerCase().replace(/\s+/g, ''); }

function findShopeeHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const h = (rows[i] || []).map(c => String(c ?? '').trim().toLowerCase());
    if (h.includes('lihat berdasarkan') && h.includes('no. pesanan') && h.includes('total penghasilan') && h.includes('harga produk')) return { head: i, h };
  }
  return null;
}

// Mengembalikan null bila bukan laporan penghasilan Shopee. Selain itu:
// { lines, orders, from, to, total, revenue, fee, proc, procPerOrder, topup, groups, skipped }
function parseShopeeIncome(rows) {
  const hd = findShopeeHeader(rows);
  if (!hd) return null;
  const idx = k => hd.h.findIndex(x => (Array.isArray(k) ? k : [k]).includes(x));
  const C = {
    kind: idx('lihat berdasarkan'), order: idx('no. pesanan'), pid: idx('id produk'), name: idx('nama produk'),
    created: idx('waktu pesanan dibuat'), released: idx('tanggal dana dilepaskan'), total: idx('total penghasilan'), price: idx('harga produk'),
    refund: idx('jumlah pengembalian dana ke pembeli'), admin: idx('biaya administrasi'),
    service: idx(['ps_finance_pdf_income_service_fee_for_id', 'biaya layanan']), proc: idx('biaya proses pesanan'),
    trans: idx('biaya transaksi'), camp: idx('biaya kampanye'), topup: idx('biaya isi saldo otomatis (dari penghasilan)')
  };
  const num0 = (r, k) => (C[k] >= 0 ? parseNumber(r[C[k]]) : 0);
  const str = (r, k) => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');
  const orders = new Map();
  for (const r of rows.slice(hd.head + 1)) {
    const no = str(r, 'order');
    if (!no) continue;
    const kind = str(r, 'kind').toLowerCase();
    const o = orders.get(no) || { no, order: null, skus: [] };
    if (kind === 'sku') o.skus.push(r); else if (kind === 'order') o.order = r;
    orders.set(no, o);
  }
  // qty diperkirakan per ID produk: harga yang paling sering muncul dianggap harga 1 unit; baris yang hampir tepat kelipatan 2x, 3x, ... = qty itu.
  const prices = new Map();
  for (const o of orders.values()) for (const r of o.skus) { const p = num0(r, 'price'), id = str(r, 'pid'); if (p > 0) { const m = prices.get(id) || new Map(); m.set(p, (m.get(p) || 0) + 1); prices.set(id, m); } }
  const unit = new Map();
  prices.forEach((m, id) => { let best = 0, bc = 0; m.forEach((c, p) => { if (c > bc || (c === bc && p < best)) { best = p; bc = c; } }); unit.set(id, best); });
  const estQty = (id, p) => { const u = unit.get(id) || 0; if (!(u > 0)) return 1; const ratio = p / u, k = Math.round(ratio); return k >= 2 && Math.abs(ratio - k) <= 0.07 * k ? k : 1; };

  const lines = []; let skipped = 0;
  const procSeen = new Map(); let topup = 0, total = 0, revenue = 0, fee = 0, procSum = 0;
  let from = '', to = '';
  for (const o of orders.values()) {
    const base = o.skus.length ? o.skus : (o.order ? [o.order] : []);
    const orderPrice = o.order ? num0(o.order, 'price') : base.reduce((a, r) => a + num0(r, 'price'), 0);
    const orderTopup = o.order ? -num0(o.order, 'topup') : 0;
    for (const r of base) {
      const date = parseDate(r[C.created]) || parseDate(r[C.released]) || (o.order && (parseDate(o.order[C.created]) || parseDate(o.order[C.released])));
      const price = num0(r, 'price');
      if (!date || !(price > 0)) { skipped++; continue; }
      const feeRp = -(num0(r, 'admin') + num0(r, 'service') + num0(r, 'trans') + num0(r, 'camp'));
      const procRp = -num0(r, 'proc');
      const tot = num0(r, 'total');
      const share = orderPrice > 0 ? price / orderPrice : 1 / base.length;
      const topupRp = Math.max(0, orderTopup) * share;
      // semua pengurang lain (voucher penjual, ongkir bersih, komisi AMS, hemat biaya kirim, isi saldo otomatis) = sisa agar profit cocok dengan "Total Penghasilan"
      const other = Math.max(0, price - Math.max(0, feeRp) - Math.max(0, procRp) - tot);
      const id = str(r, 'pid');
      const name = str(r, 'name');
      const product = !name || name === '-' ? (id && id !== '-' ? 'Produk ' + id : '(tanpa nama)') : name;
      const refunded = Math.abs(num0(r, 'refund')) > 0 || (o.order && Math.abs(num0(o.order, 'refund')) > 0);
      lines.push({ order: o.no, date, product, key: noSpaceKey(product), pid: id, price, qty: estQty(id, price), fee: Math.max(0, feeRp), other, topup: Math.min(other, topupRp), refunded });
      total += tot; if (!refunded) revenue += price; fee += Math.max(0, feeRp); procSum += Math.max(0, procRp);
      topup += Math.min(other, topupRp);
      if (!from || date < from) from = date; if (!to || date > to) to = date;
    }
    const p = o.order ? -num0(o.order, 'proc') : 0;
    if (p > 0) procSeen.set(p, (procSeen.get(p) || 0) + 1);
  }
  const groups = new Map();
  for (const l of lines) {
    const g = groups.get(l.key) || { key: l.key, name: l.product, lines: 0, units: 0 };
    g.lines++; g.units += l.qty; groups.set(l.key, g);
  }
  let procPerOrder = 0, pc = 0;
  procSeen.forEach((c, p) => { if (c > pc) { pc = c; procPerOrder = p; } });
  return { lines, orders: orders.size, from, to, total, revenue, fee, proc: procSum, procPerOrder, topup, groups: [...groups.values()].sort((a, b) => b.lines - a.lines), skipped };
}

// Ubah hasil parseShopeeIncome menjadi transaksi. opts.costs = { kunciProduk: modal per unit }, opts.includeTopup = hitung isi saldo otomatis sebagai biaya lain.
function shopeeToSales(parsed, opts = {}) {
  const costs = opts.costs || {};
  const r2 = n => Math.round(n * 100) / 100;
  return parsed.lines.map(l => {
    const other = l.other - (opts.includeTopup ? 0 : l.topup);
    return {
      id: uid(), date: l.date, marketplace: 'Shopee', product: l.product, qty: l.qty,
      price: r2(l.price / l.qty), cogs: Math.max(0, Number(costs[l.key]) || 0),
      feePct: Math.min(100, Math.round(l.fee / l.price * 1e6) / 1e4), otherCost: Math.max(0, r2(other)),
      status: l.refunded ? 'dikembalikan' : 'selesai', orderNo: String(l.order).slice(0, 80), omzetMp: l.price
    };
  });
}

// Buang baris yang pesanan + produknya sudah tercatat di Shopee (mis. file yang sama diimpor lagi dengan modal berbeda).
function dropKnownShopee(existing, incoming) {
  const k = s => String(s.orderNo || '').trim().toLowerCase() + '|' + noSpaceKey(s.product);
  const have = new Map();
  for (const s of existing) if (String(s.marketplace).toLowerCase() === 'shopee' && String(s.orderNo || '').trim()) have.set(k(s), (have.get(k(s)) || 0) + 1);
  const fresh = []; let dup = 0;
  for (const s of incoming) { const n = have.get(k(s)) || 0; if (n > 0) { have.set(k(s), n - 1); dup++; } else fresh.push(s); }
  return { fresh, dup };
}

// Cari modal per unit di Menu Produk (nama persis, lalu tanpa memperhatikan spasi/huruf besar).
function costFromMenu(products, name) {
  const p = findProduct(products, name) || (products || []).find(x => noSpaceKey(x.name) === noSpaceKey(name));
  return p && p.cost > 0 ? p.cost : 0;
}

// ---------- Ekspor laporan lengkap (banyak sheet) ----------
// Sheet pertama "Ringkasan", lalu "Penjualan" (tetap bisa diimpor ulang; kolom hitung di kanan diabaikan saat impor),
// "Per Marketplace", "Per Produk", "Per Tanggal" dan "Iklan".
function reportWorkbook(sales, ads, settings, info) {
  const S = xlsx.STYLE;
  const st = settings || {};
  const adTaxPct = cleanFee(st.adTax);
  info = info || {};
  const r0 = n => Math.round((Number(n) || 0) * 100) / 100;
  const fmtDMY = iso => iso.split('-').reverse().join('/');
  const NOMP = '(tanpa marketplace)';
  const carriers = feeCarriers(sales); // biaya proses hanya di 1 baris per resi

  const t = summarize(sales);
  const d = deductions(sales, ads, settings);
  const gross = t.revenue - t.fee - t.hpp - t.otherCost - d.affiliate - d.procFee;   // laba setelah modal = profit kotor - modal (sebelum pajak & iklan)
  const adsTax = d.adSpend + d.adTax + d.tax;   // iklan, PPN iklan & pajak (affiliate & biaya proses sudah dikurangi di atas)
  const net = gross - adsTax;

  // ----- 1. Ringkasan -----
  const R = [];
  const put = (label, value, opt = {}) => R.push([{ v: label, s: opt.total ? S.totLabel : (opt.bold ? S.bold : 0) },
    value === null ? '' : Object.assign({ s: opt.total ? S.totMoney : opt.bold ? S.boldMoney : S.moneyR }, typeof value === 'object' ? value : { v: value }),
    opt.note ? { v: opt.note, s: S.noteWrap } : '']);
  R.push([{ v: 'Laporan Penjualan Marketplace', s: S.title }]);
  R.push([{ v: 'Periode', s: S.bold }, info.range || 'Semua periode']);
  R.push([{ v: 'Marketplace', s: S.bold }, info.marketplace || 'Semua']);
  if (info.query) R.push([{ v: 'Cari produk / resi', s: S.bold }, info.query]);
  R.push([{ v: 'Dibuat', s: S.bold }, fmtDMY(todayISO())]);
  if (info.at) R.push([{ v: 'Data per', s: S.bold }, info.at]);
  if (info.query) R.push([{ v: 'Catatan', s: S.note }, { v: 'Pencarian aktif, jadi biaya iklan tidak ikut dihitung (tidak terkait produk).', s: S.note }]);
  R.push([]);
  R.push([{ v: 'Rincian Perhitungan', s: S.header }, { v: 'Jumlah (Rp)', s: S.header }, { v: 'Keterangan', s: S.header }]);
  const base = R.length + 1;            // nomor baris Excel untuk baris berikutnya
  const row = k => base + k;            // baris ke-k (0-based) dari blok rincian
  put('Omzet (penjualan selesai)', r0(t.revenue), { bold: true, note: `${num(t.orders)} pesanan · ${num(t.qty)} unit` });          // 0
  put('Biaya admin marketplace', r0(t.fee), { note: 'Potongan % dari omzet per marketplace' });                                             // 1
  put('Modal / HPP', r0(t.hpp), { note: 'Qty × modal satuan' });                                                                          // 2
  put('Biaya lain per transaksi', r0(t.otherCost), { note: 'Mis. ongkir yang ditanggung penjual' });                                       // 3
  put('Laba setelah modal (sebelum pajak & iklan)', { v: r0(gross), f: `B${row(0)}-B${row(1)}-B${row(2)}-B${row(3)}-B${row(8)}-B${row(9)}` }, { bold: true, note: 'Omzet - biaya admin - modal - biaya lain - affiliate - biaya proses (= Profit kotor - modal)' });                 // 4
  put('Biaya iklan', r0(d.adSpend), { note: `${num(ads.length)} catatan iklan` });                                                         // 5
  put(`PPN iklan (${adTaxPct}% dari iklan)`, r0(d.adTax));                                                                                 // 6
  put('Pajak penjualan', r0(d.tax), { note: 'Persen pajak per marketplace × omzet' });                                                     // 7
  put('Affiliate', r0(d.affiliate), { note: 'Persen affiliate per marketplace × omzet' });                                                  // 8
  put('Biaya proses pesanan', r0(d.procFee), { note: 'Biaya per pesanan selesai × jumlah pesanan (1 resi = 1 pesanan)' });                                       // 9
  put('Total iklan & pajak', { v: r0(adsTax), f: `B${row(5)}+B${row(6)}+B${row(7)}` }, { bold: true });  // 10
  put('PROFIT BERSIH', { v: r0(net), f: `B${row(4)}-B${row(10)}` }, { total: true, note: 'Setelah biaya admin, modal, iklan, pajak, affiliate & biaya proses' }); // 11
  R.push([{ v: 'Margin profit bersih', s: S.bold }, { v: t.revenue ? net / t.revenue : 0, f: `IF(B${row(0)}=0,0,B${row(11)}/B${row(0)})`, s: S.pct }, '']); // 12
  // 13-14: profit kotor = omzet - biaya marketplace, SEBELUM modal/harga kulakan, pajak & iklan (tambahan; tidak menggeser baris di atas)
  const grossBeforeCogs = t.revenue - t.fee - t.otherCost - d.affiliate - d.procFee;
  put('Profit kotor (sebelum modal / harga kulakan)', { v: r0(grossBeforeCogs), f: `B${row(0)}-B${row(1)}-B${row(3)}-B${row(8)}-B${row(9)}` }, { bold: true, note: 'Omzet - biaya admin - biaya lain - affiliate - biaya proses (modal, pajak & iklan belum dikurangi)' }); // 13
  R.push([{ v: 'Margin profit kotor', s: S.bold }, { v: t.revenue ? grossBeforeCogs / t.revenue : 0, f: `IF(B${row(0)}=0,0,B${row(13)}/B${row(0)})`, s: S.pct }, '']); // 14
  R.push([]);
  R.push([{ v: 'Statistik Penjualan', s: S.header }, { v: 'Nilai', s: S.header }, '']);
  const stat = (l, v) => R.push([l, { v: Math.round(v), s: S.moneyR }, '']);
  stat('Pesanan selesai', t.orders);
  stat('Unit terjual', t.qty);
  stat('Pesanan batal / dikembalikan', t.cancelled);
  stat('Rata-rata omzet per pesanan', t.aov);
  R.push([{ v: 'Margin laba setelah modal', s: 0 }, { v: t.revenue ? gross / t.revenue : 0, s: S.pct }, '']);
  R.push([{ v: 'Rata-rata biaya admin', s: 0 }, { v: t.revenue ? t.fee / t.revenue : 0, s: S.pct }, '']);
  R.push([{ v: 'Total potongan ÷ omzet', s: 0 }, { v: t.revenue ? (t.fee + t.otherCost + d.total) / t.revenue : 0, f: `IF(B${row(0)}=0,0,(B${row(1)}+B${row(3)}+B${row(8)}+B${row(9)}+B${row(10)})/B${row(0)})`, s: S.pct }, { v: 'Biaya admin + biaya lain + iklan, pajak, affiliate & biaya proses', s: S.noteWrap }]);
  R.push([{ v: 'ROAS iklan (omzet ÷ biaya iklan)', s: 0 }, { v: d.adSpend ? t.revenue / d.adSpend : 0, f: `IF(B${row(5)}=0,0,B${row(0)}/B${row(5)})`, s: S.mult }, { v: 'Tiap Rp 1 iklan menghasilkan omzet berapa kali lipat (0 = tidak ada iklan)', s: S.noteWrap }]);

  // ----- 2. Penjualan (kompatibel impor) -----
  // Urutan kolom: identitas -> HASIL BERSIH (di depan) -> data input -> hitungan -> potongan (pajak, affiliate, biaya proses).
  // Nama kolom input sama dengan template, jadi file ini tetap bisa diimpor ulang; baris TOTAL & rincian di bawahnya diabaikan saat impor.
  const COLS = [
    ['Tanggal', 13], ['Marketplace', 16], ['Nama Produk', 36], ['No. Pesanan / Resi', 24], ['Hasil Bersih (Rp)', 19], ['Status', 14],
    ['Qty', 8], ['Harga Satuan (Rp)', 18], ['Modal Satuan (Rp)', 18], ['Biaya Admin (%)', 15], ['Biaya Lain (Rp)', 16],
    ['Omzet (Rp)', 17], ['Biaya Admin (Rp)', 17], ['Modal Total (Rp)', 17], ['Laba setelah Modal (Rp)', 20],
    ['Pajak (%)', 12], ['Pajak (Rp)', 15], ['Affiliate (Rp)', 15], ['Biaya Proses (Rp)', 17],
    ['Omzet di Marketplace (Rp)', 24]   // kolom input: dibutuhkan agar impor ulang tidak kehilangan omzet yang diisi manual
  ];
  const hdrStyle = i => (i === 4 ? S.hdrResult : i === 19 ? S.header : i >= 15 ? S.hdrDeduct : S.header);
  const prow = [COLS.map((c, i) => ({ v: c[0], s: hdrStyle(i) }))];
  const sorted = sales.slice().sort((a, b) => a.date.localeCompare(b.date));
  const T = { hasil: 0, qty: 0, other: 0, rev: 0, fee: 0, hpp: 0, gross: 0, tax: 0, aff: 0, proc: 0 };
  for (const s of sorted) {
    const c = calc(s);
    const ex = saleExtras(s, st, carriers.has(s));
    const taxPct = cleanFee((st.taxes || {})[s.marketplace]);
    const hasil = r0(c.profit - ex.tax - ex.affiliate - ex.procFee);   // = Laba setelah modal - pajak
    prow.push([
      { d: s.date }, s.marketplace || '', s.product || '', s.orderNo || '',
      { v: hasil, s: S.hasil }, { v: s.status || 'selesai', s: S.center },
      { v: Number(s.qty) || 0 },
      { v: Number(s.price) || 0, s: S.money },
      { v: Number(s.cogs) || 0, s: S.money },
      { v: Number(s.feePct) || 0, s: S.pctNum },
      { v: Number(s.otherCost) || 0, s: S.money },
      { v: r0(c.revenue), s: S.moneyR },
      { v: r0(c.fee), s: S.moneyR },
      { v: r0(c.hpp), s: S.moneyR },
      { v: r0(c.profit - ex.affiliate - ex.procFee), s: S.moneyR },
      { v: taxPct, s: S.pctNum },
      { v: r0(ex.tax), s: S.moneyR },
      { v: r0(ex.affiliate), s: S.moneyR },
      { v: r0(ex.procFee), s: S.moneyR },
      { v: Number(s.omzetMp) || 0, s: S.money }
    ]);
    T.hasil += hasil; T.qty += c.qty; T.other += c.otherCost; T.rev += r0(c.revenue); T.fee += r0(c.fee);
    T.hpp += r0(c.hpp); T.gross += r0(c.profit - ex.affiliate - ex.procFee); T.tax += r0(ex.tax); T.aff += r0(ex.affiliate); T.proc += r0(ex.procFee);
  }
  if (sorted.length) {
    const last = prow.length;            // nomor baris Excel data terakhir
    const tot = last + 1;                // baris TOTAL
    const rng = col => `${col}2:${col}${last}`;
    const blank = { v: '', s: S.totLabel };
    const sum = (col, v, style = S.totMoney) => ({ v: r0(v), f: `SUM(${rng(col)})`, s: style });
    const trow = COLS.map(() => blank);
    trow[0] = { v: 'TOTAL', s: S.totLabel };
    trow[2] = { v: 'hanya pesanan berstatus selesai', s: S.totLabel };
    trow[4] = sum('E', T.hasil, S.totHasil);
    trow[6] = { v: T.qty, f: `SUMIF(${rng('F')},"selesai",${rng('G')})`, s: S.totMoney };
    trow[10] = { v: r0(T.other), f: `SUMIF(${rng('F')},"selesai",${rng('K')})`, s: S.totMoney };
    trow[11] = sum('L', T.rev); trow[12] = sum('M', T.fee); trow[13] = sum('N', T.hpp); trow[14] = sum('O', T.gross);
    trow[16] = sum('Q', T.tax); trow[17] = sum('R', T.aff); trow[18] = sum('S', T.proc);
    prow.push(trow);

    // Rincian jumlah (label di kolom A meluber ke B-D, angka di kolom E, sejajar dengan kolom Hasil Bersih)
    prow.push([]);
    prow.push([{ v: 'Rincian Jumlah', s: S.headerL }, { v: '', s: S.headerL }, { v: '', s: S.headerL }, { v: '', s: S.headerL }, { v: 'Jumlah', s: S.header }]);
    const item = (label, cell, strong) => { prow.push([{ v: label, s: strong ? S.bold : 0 }, '', '', '', cell]); return prow.length; };
    const ref = (col, v) => ({ v: r0(v), f: `${col}${tot}`, s: S.moneyR });
    item('Jumlah transaksi (baris)', { v: sorted.length, f: `COUNTA(${rng('A')})`, s: S.moneyR });
    item('Pesanan selesai (1 resi = 1 pesanan)', { v: t.orders, s: S.moneyR });
    item('Unit terjual', ref('G', T.qty));
    item('Omzet', ref('L', T.rev));
    item('Biaya admin marketplace', ref('M', T.fee));
    item('Modal / HPP', ref('N', T.hpp));
    item('Biaya lain per transaksi', ref('K', T.other));
    item('Pajak penjualan', ref('Q', T.tax));
    item('Affiliate', ref('R', T.aff));
    item('Biaya proses pesanan', ref('S', T.proc));
    const rHasil = item('Hasil bersih penjualan', { v: r0(T.hasil), f: `E${tot}`, s: S.boldMoney }, true);
    const adsCost = r0(d.adSpend + d.adTax);
    const rAds = item('Biaya iklan + PPN iklan', { v: adsCost, s: S.moneyR });
    prow.push([{ v: 'HASIL BERSIH AKHIR', s: S.totLabel }, blank, blank, blank, { v: r0(T.hasil - adsCost), f: `E${rHasil}-E${rAds}`, s: S.totHasil }]);
    prow.push([{ v: 'Hasil bersih akhir sama dengan PROFIT BERSIH di sheet Ringkasan (setelah iklan).', s: S.note }]);
  }
  const lastS = sorted.length + 1;
  const sheetSales = { name: 'Penjualan', rows: prow, widths: COLS.map(c => c[1]), freeze: true, freezeCols: 3, filter: true, filterRows: lastS,
    headerHeight: 36, gridRows: sorted.length ? [2, lastS] : undefined, tab: 'FF0F766E', printTitle: true,
    cf: sorted.length ? [
      { sqref: `A2:T${lastS}`, expr: '$F2<>"selesai"', dxf: 2 },
      { sqref: `E2:E${lastS}`, op: 'lessThan', val: 0, dxf: 0 },
      { sqref: `O2:O${lastS}`, op: 'lessThan', val: 0, dxf: 0 }
    ] : [],
    validations: sorted.length ? [{ sqref: `F2:F${lastS}`, list: STATUSES.join(',') }] : [] };

  // ----- helper tabel dengan baris total -----
  const sumCols = (rows, from, to) => {
    const tot = [];
    for (let c = from; c <= to; c++) tot.push(rows.reduce((a, r) => a + (Number(r[c]) || 0), 0));
    return tot;
  };

  // ----- 3. Per Marketplace -----
  const mpNames = new Set();
  sales.forEach(s => mpNames.add(s.marketplace || 'Lainnya'));
  ads.forEach(a => mpNames.add(a.marketplace || NOMP));
  const mpRows = [...mpNames].map(name => {
    const ss = sales.filter(s => (s.marketplace || 'Lainnya') === name);
    const aa = ads.filter(a => (a.marketplace || NOMP) === name);
    const ts = summarize(ss), dd = deductions(ss, aa, settings);
    const g = ts.revenue - ts.fee - ts.hpp - ts.otherCost - dd.affiliate - dd.procFee;   // laba setelah modal
    const gk = ts.revenue - ts.fee - ts.otherCost - dd.affiliate - dd.procFee;   // profit kotor (sebelum modal, pajak & iklan)
    return [name, ts.orders, ts.qty, r0(ts.revenue), r0(ts.fee), r0(ts.hpp), r0(ts.otherCost), r0(g), r0(dd.adSpend), r0(dd.adTax), r0(dd.tax), r0(dd.affiliate), r0(dd.procFee), r0(g - dd.adSpend - dd.adTax - dd.tax), r0(gk)];
  }).sort((a, b) => b[3] - a[3]);
  const mpHead = ['Marketplace', 'Pesanan', 'Unit', 'Omzet', 'Biaya admin', 'Modal', 'Biaya lain', 'Laba setelah modal (sebelum pajak & iklan)', 'Iklan', 'PPN iklan', 'Pajak', 'Affiliate', 'Biaya proses pesanan', 'Profit bersih', 'Margin bersih', 'Profit kotor (sebelum modal)', 'Margin kotor'];
  const mpOut = [mpHead.map((h, i) => ({ v: h, s: i === 13 ? S.hdrResult : i >= 8 && i <= 12 ? S.hdrDeduct : S.header }))]; // iklan, PPN, pajak, affiliate, proses = oranye; profit bersih = hijau
  mpRows.forEach((r, i) => {
    const x = i + 2;
    mpOut.push([r[0], ...r.slice(1).map(v => ({ v, s: S.moneyR })).slice(0, 13),
      { v: r[3] ? r[13] / r[3] : 0, f: `IF(D${x}=0,0,N${x}/D${x})`, s: S.pct },
      { v: r[14], s: S.moneyR },
      { v: r[3] ? r[14] / r[3] : 0, f: `IF(D${x}=0,0,P${x}/D${x})`, s: S.pct }]);
  });
  if (mpRows.length) {
    const n = mpRows.length + 1, tot = sumCols(mpRows, 1, 13);
    const colL = i => String.fromCharCode(66 + i);
    mpOut.push([{ v: 'TOTAL', s: S.totLabel },
      ...tot.map((v, i) => ({ v, f: `SUM(${colL(i)}2:${colL(i)}${n})`, s: S.totMoney })),
      { v: tot[2] ? tot[12] / tot[2] : 0, f: `IF(D${n + 1}=0,0,N${n + 1}/D${n + 1})`, s: S.totPct },
      { v: r0(mpRows.reduce((a, r) => a + r[14], 0)), f: `SUM(P2:P${n})`, s: S.totMoney },
      { v: tot[2] ? mpRows.reduce((a, r) => a + r[14], 0) / tot[2] : 0, f: `IF(D${n + 1}=0,0,P${n + 1}/D${n + 1})`, s: S.totPct }]);
  }
  const mpN = mpRows.length + 1;
  const sheetMp = { name: 'Per Marketplace', rows: mpOut, widths: [20, 10, 10, 16, 16, 16, 14, 22, 14, 14, 14, 14, 18, 16, 14, 20, 13], freeze: true,
    headerHeight: 44, gridRows: mpRows.length ? [2, mpN] : undefined, tab: 'FF0EA5E9', printTitle: true,
    filter: mpRows.length > 1, filterRows: mpN,
    cf: mpRows.length ? [{ sqref: `N2:N${mpN}`, op: 'lessThan', val: 0, dxf: 0 }, { sqref: `H2:H${mpN}`, op: 'lessThan', val: 0, dxf: 0 }] : [],
    charts: mpRows.length ? [{ type: 'bar', title: 'Omzet vs profit bersih per marketplace', cat: `A2:A${mpN}`,
      series: [{ name: 'Omzet', nameRef: 'D1', ref: `D2:D${mpN}`, color: 'FF0F766E' }, { name: 'Profit bersih', nameRef: 'N1', ref: `N2:N${mpN}`, color: 'FF16A34A' }],
      from: [0, mpRows.length + 4], to: [8, mpRows.length + 22] }] : [] };

  // ----- 4. Per Produk -----
  const pmap = new Map();
  const grossMap = grossProfitMap(sales, settings);
  for (const s of sales) {
    const c = calc(s);
    if (!c.counted) continue;
    const k = productKey(s.product);
    const cur = pmap.get(k) || { name: s.product, qty: 0, orders: 0, revenue: 0, fee: 0, hpp: 0, other: 0, profit: 0, gk: 0 };
    cur.qty += c.qty; cur.orders += 1; cur.revenue += c.revenue; cur.fee += c.fee; cur.hpp += c.hpp; cur.other += c.otherCost; cur.gk += grossMap.get(s) || 0; cur.profit += (grossMap.get(s) || 0) - c.hpp;
    pmap.set(k, cur);
  }
  const pRows = [...pmap.values()].sort((a, b) => b.revenue - a.revenue);
  const pHead = ['Produk', 'Pesanan', 'Unit', 'Omzet', 'Biaya admin', 'Modal', 'Biaya lain', 'Laba setelah modal (sebelum pajak & iklan)', 'Margin', 'Profit kotor (sebelum modal)', 'Margin kotor'];
  const pOut = [pHead.map(h => ({ v: h, s: S.header }))];
  pRows.forEach((p, i) => {
    const x = i + 2;
    pOut.push([p.name, { v: p.orders, s: S.moneyR }, { v: p.qty, s: S.moneyR }, { v: r0(p.revenue), s: S.moneyR }, { v: r0(p.fee), s: S.moneyR },
      { v: r0(p.hpp), s: S.moneyR }, { v: r0(p.other), s: S.moneyR }, { v: r0(p.profit), s: S.moneyR },
      { v: p.revenue ? p.profit / p.revenue : 0, f: `IF(D${x}=0,0,H${x}/D${x})`, s: S.pct },
      { v: r0(p.gk), s: S.moneyR },
      { v: p.revenue ? p.gk / p.revenue : 0, f: `IF(D${x}=0,0,J${x}/D${x})`, s: S.pct }]);
  });
  if (pRows.length) {
    const n = pRows.length + 1;
    const tot = [pRows.reduce((a, p) => a + p.orders, 0), pRows.reduce((a, p) => a + p.qty, 0), ...['revenue', 'fee', 'hpp', 'other', 'profit'].map(k => pRows.reduce((a, p) => a + p[k], 0))];
    const colL = i => String.fromCharCode(66 + i);
    pOut.push([{ v: 'TOTAL', s: S.totLabel },
      ...tot.map((v, i) => ({ v: r0(v), f: `SUM(${colL(i)}2:${colL(i)}${n})`, s: S.totMoney })),
      { v: tot[2] ? tot[6] / tot[2] : 0, f: `IF(D${n + 1}=0,0,H${n + 1}/D${n + 1})`, s: S.totPct },
      { v: r0(pRows.reduce((a, p) => a + p.gk, 0)), f: `SUM(J2:J${n})`, s: S.totMoney },
      { v: tot[2] ? pRows.reduce((a, p) => a + p.gk, 0) / tot[2] : 0, f: `IF(D${n + 1}=0,0,J${n + 1}/D${n + 1})`, s: S.totPct }]);
  }
  const pN = pRows.length + 1, pTop = Math.min(pRows.length, 8) + 1;
  const sheetProd = { name: 'Per Produk', rows: pOut, widths: [38, 10, 10, 16, 16, 16, 14, 22, 12, 20, 13], freeze: true,
    headerHeight: 44, gridRows: pRows.length ? [2, pN] : undefined, tab: 'FF8B5CF6', printTitle: true,
    filter: pRows.length > 1, filterRows: pN,
    cf: pRows.length ? [{ sqref: `H2:H${pN}`, op: 'lessThan', val: 0, dxf: 0 }] : [],
    charts: pRows.length ? [{ type: 'bar', title: `Omzet vs profit ${pRows.length > 8 ? '8 produk teratas' : 'per produk'}`, cat: `A2:A${pTop}`,
      series: [{ name: 'Omzet', nameRef: 'D1', ref: `D2:D${pTop}`, color: 'FF0F766E' }, { name: 'Laba setelah modal (sebelum pajak & iklan)', nameRef: 'H1', ref: `H2:H${pTop}`, color: 'FF16A34A' }],
      from: [0, pRows.length + 4], to: [8, pRows.length + 22] }] : [] };

  // ----- 5. Per Tanggal -----
  const dmap = new Map();
  const dayOf = k => dmap.get(k) || (dmap.set(k, { orders: 0, keys: new Set(), revenue: 0, fee: 0, hpp: 0, other: 0, tax: 0, aff: 0, proc: 0, ad: 0 }), dmap.get(k));
  for (const s of sales) {
    const c = calc(s);
    if (!c.counted) continue;
    const x = dayOf(s.date);
    const ok = orderKeyOf(s);
    if (!ok || !x.keys.has(ok)) { x.orders += 1; if (ok) x.keys.add(ok); }
    x.revenue += c.revenue; x.fee += c.fee; x.hpp += c.hpp; x.other += c.otherCost;
    const ex = saleExtras(s, st, carriers.has(s));
    x.tax += ex.tax; x.aff += ex.affiliate; x.proc += ex.procFee;
  }
  for (const a of ads) dayOf(a.date).ad += Number(a.amount) || 0;
  const days = [...dmap.keys()].sort();
  const dHead = ['Tanggal', 'Pesanan', 'Omzet', 'Biaya admin', 'Modal', 'Biaya lain', 'Iklan', 'PPN iklan', 'Pajak', 'Affiliate', 'Biaya proses pesanan', 'Profit bersih'];
  const dOut = [dHead.map((h, i) => ({ v: h, s: i === 11 ? S.hdrResult : i >= 6 && i <= 10 ? S.hdrDeduct : S.header }))];
  const dVals = [];
  days.forEach((k, i) => {
    const x = dmap.get(k), x2 = i + 2;
    const ppn = x.ad * adTaxPct / 100;
    const profit = x.revenue - x.fee - x.hpp - x.other - x.ad - ppn - x.tax - x.aff - x.proc;
    dVals.push([x.orders, x.revenue, x.fee, x.hpp, x.other, x.ad, ppn, x.tax, x.aff, x.proc, profit]);
    dOut.push([{ d: k }, { v: x.orders, s: S.moneyR }, { v: r0(x.revenue), s: S.moneyR }, { v: r0(x.fee), s: S.moneyR }, { v: r0(x.hpp), s: S.moneyR },
      { v: r0(x.other), s: S.moneyR }, { v: r0(x.ad), s: S.moneyR }, { v: r0(ppn), s: S.moneyR }, { v: r0(x.tax), s: S.moneyR },
      { v: r0(x.aff), s: S.moneyR }, { v: r0(x.proc), s: S.moneyR },
      { v: r0(profit), f: `C${x2}-D${x2}-E${x2}-F${x2}-G${x2}-H${x2}-I${x2}-J${x2}-K${x2}`, s: S.moneyR }]);
  });
  if (days.length) {
    const n = days.length + 1, tot = sumCols(dVals, 0, 10);
    const colL = i => String.fromCharCode(66 + i);
    dOut.push([{ v: 'TOTAL', s: S.totLabel }, ...tot.map((v, i) => ({ v: r0(v), f: `SUM(${colL(i)}2:${colL(i)}${n})`, s: S.totMoney }))]);
  }
  const dN = days.length + 1;
  const sheetDay = { name: 'Per Tanggal', rows: dOut, widths: [12, 10, 16, 16, 16, 14, 14, 14, 14, 14, 18, 16], freeze: true,
    headerHeight: 32, gridRows: days.length ? [2, dN] : undefined, tab: 'FFF59E0B', printTitle: true,
    filter: days.length > 1, filterRows: dN,
    cf: days.length ? [{ sqref: `L2:L${dN}`, op: 'lessThan', val: 0, dxf: 0 }] : [],
    charts: days.length > 1 ? [{ type: 'line', title: 'Omzet & profit bersih harian', cat: `A2:A${dN}`,
      series: [{ name: 'Omzet', nameRef: 'C1', ref: `C2:C${dN}`, color: 'FF2563EB' }, { name: 'Profit bersih', nameRef: 'L1', ref: `L2:L${dN}`, color: 'FFF97316' }],
      from: [13, 1], to: [24, 22] }] : [] };

  // ----- 5b. Per Bulan -----
  const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const mmap = new Map();
  days.forEach(k => {
    const x = dmap.get(k), key = k.slice(0, 7);
    const m = mmap.get(key) || { orders: 0, revenue: 0, fee: 0, hpp: 0, other: 0, ad: 0, tax: 0, aff: 0, proc: 0 };
    m.orders += x.orders; m.revenue += x.revenue; m.fee += x.fee; m.hpp += x.hpp; m.other += x.other; m.ad += x.ad; m.tax += x.tax; m.aff += x.aff; m.proc += x.proc;
    mmap.set(key, m);
  });
  const months = [...mmap.keys()].sort();
  const mHead = ['Bulan', 'Pesanan', 'Omzet', 'Biaya admin', 'Modal', 'Biaya lain', 'Iklan', 'PPN iklan', 'Pajak', 'Affiliate', 'Biaya proses pesanan', 'Profit bersih', 'Margin bersih', 'Pertumbuhan omzet'];
  const mOut = [mHead.map((h, i) => ({ v: h, s: i === 11 ? S.hdrResult : i >= 6 && i <= 10 ? S.hdrDeduct : S.header }))];
  const mVals = [];
  months.forEach((k, i) => {
    const m = mmap.get(k), x = i + 2, ppn = m.ad * adTaxPct / 100;
    const profit = m.revenue - m.fee - m.hpp - m.other - m.ad - ppn - m.tax - m.aff - m.proc;
    mVals.push([m.orders, m.revenue, m.fee, m.hpp, m.other, m.ad, ppn, m.tax, m.aff, m.proc, profit]);
    const prevM = i > 0 ? mmap.get(months[i - 1]) : null;
    mOut.push([`${BLN[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`, { v: m.orders, s: S.moneyR }, { v: r0(m.revenue), s: S.moneyR }, { v: r0(m.fee), s: S.moneyR }, { v: r0(m.hpp), s: S.moneyR },
      { v: r0(m.other), s: S.moneyR }, { v: r0(m.ad), s: S.moneyR }, { v: r0(ppn), s: S.moneyR }, { v: r0(m.tax), s: S.moneyR }, { v: r0(m.aff), s: S.moneyR }, { v: r0(m.proc), s: S.moneyR },
      { v: r0(profit), f: `C${x}-D${x}-E${x}-F${x}-G${x}-H${x}-I${x}-J${x}-K${x}`, s: S.moneyR },
      { v: m.revenue ? profit / m.revenue : 0, f: `IF(C${x}=0,0,L${x}/C${x})`, s: S.pct },
      i === 0 ? '' : { v: prevM && prevM.revenue ? m.revenue / prevM.revenue - 1 : 0, f: `IF(C${x - 1}=0,0,C${x}/C${x - 1}-1)`, s: S.pct }]);
  });
  if (months.length) {
    const n = months.length + 1, tot = sumCols(mVals, 0, 10);
    const colL = i => String.fromCharCode(66 + i);
    mOut.push([{ v: 'TOTAL', s: S.totLabel }, ...tot.map((v, i) => ({ v: r0(v), f: `SUM(${colL(i)}2:${colL(i)}${n})`, s: S.totMoney })),
      { v: tot[1] ? tot[10] / tot[1] : 0, f: `IF(C${n + 1}=0,0,L${n + 1}/C${n + 1})`, s: S.totPct }, { v: '', s: S.totLabel }]);
  }
  const mN = months.length + 1;
  const sheetMonth = { name: 'Per Bulan', rows: mOut, widths: [14, 10, 16, 16, 16, 14, 14, 14, 14, 14, 18, 16, 14, 16], freeze: true,
    headerHeight: 32, gridRows: months.length ? [2, mN] : undefined, tab: 'FFEC4899', printTitle: true,
    cf: months.length ? [{ sqref: `L2:L${mN}`, op: 'lessThan', val: 0, dxf: 0 }, { sqref: `N2:N${mN}`, op: 'lessThan', val: 0, dxf: 0 }, { sqref: `N2:N${mN}`, op: 'greaterThan', val: 0, dxf: 1 }] : [],
    charts: months.length ? [{ type: 'bar', title: 'Omzet vs profit bersih per bulan', cat: `A2:A${mN}`,
      series: [{ name: 'Omzet', nameRef: 'C1', ref: `C2:C${mN}`, color: 'FF0F766E' }, { name: 'Profit bersih', nameRef: 'L1', ref: `L2:L${mN}`, color: 'FF16A34A' }],
      from: [0, months.length + 4], to: [8, months.length + 22] }] : [] };

  // ----- 6. Iklan -----
  const aSorted = ads.slice().sort((a, b) => a.date.localeCompare(b.date));
  const aOut = [['Tanggal', 'Marketplace', 'Catatan', 'Biaya iklan', 'PPN iklan (%)', 'PPN iklan (Rp)', 'Total dengan PPN'].map(h => ({ v: h, s: S.header }))];
  aSorted.forEach((a, i) => {
    const x = i + 2, amt = Number(a.amount) || 0;
    aOut.push([{ d: a.date }, a.marketplace || NOMP, a.note || '', { v: amt, s: S.moneyR }, { v: adTaxPct },
      { v: r0(amt * adTaxPct / 100), f: `D${x}*E${x}/100`, s: S.moneyR }, { v: r0(amt * (1 + adTaxPct / 100)), f: `D${x}+F${x}`, s: S.moneyR }]);
  });
  if (aSorted.length) {
    const n = aSorted.length + 1;
    const sa = aSorted.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    aOut.push([{ v: 'TOTAL', s: S.totLabel }, { v: '', s: S.totLabel }, { v: '', s: S.totLabel },
      { v: r0(sa), f: `SUM(D2:D${n})`, s: S.totMoney }, { v: '', s: S.totLabel },
      { v: r0(sa * adTaxPct / 100), f: `SUM(F2:F${n})`, s: S.totMoney }, { v: r0(sa * (1 + adTaxPct / 100)), f: `SUM(G2:G${n})`, s: S.totMoney }]);
  }
  const aN = aSorted.length + 1;
  const sheetAds = { name: 'Iklan', rows: aOut, widths: [12, 18, 36, 16, 14, 16, 18], freeze: true,
    headerHeight: 30, gridRows: aSorted.length ? [2, aN] : undefined, tab: 'FFB45309', printTitle: true, filter: aSorted.length > 1, filterRows: aN };

  // Sorotan otomatis: siapa yang terbaik / terburuk pada periode ini.
  const hi = (arr, f) => arr.reduce((b, x) => (b === null || f(x) > f(b) ? x : b), null);
  const pctOf = (v, tot) => (tot ? ` · ${Math.round((v / tot) * 100)}% dari total` : '');
  const insights = [];
  if (mpRows.length) {
    const bestRev = hi(mpRows, r => r[3]), bestNet = hi(mpRows, r => r[13]);
    insights.push(['Marketplace omzet tertinggi', bestRev[0], `Omzet ${rupiah(bestRev[3])}${pctOf(bestRev[3], t.revenue)}`]);
    insights.push(['Marketplace profit bersih tertinggi', bestNet[0], `Profit bersih ${rupiah(bestNet[13])}`]);
  }
  if (pRows.length) {
    const topQty = hi(pRows, p => p.qty), topProfit = hi(pRows, p => p.profit);
    insights.push(['Produk terlaris (unit)', topQty.name, `${num(topQty.qty)} unit · omzet ${rupiah(topQty.revenue)}`]);
    insights.push(['Produk profit tertinggi', topProfit.name, `Profit ${rupiah(topProfit.profit)} sebelum pajak & iklan`]);
    const loss = pRows.filter(p => p.profit < 0);
    if (loss.length) insights.push(['Produk yang rugi', `${loss.length} produk`, loss.slice(0, 5).map(p => p.name).join(', ') + (loss.length > 5 ? ', …' : '')]);
  }
  if (days.length) {
    const bd = days.reduce((b, k) => (b === null || dmap.get(k).revenue > dmap.get(b).revenue ? k : b), null);
    insights.push(['Hari omzet tertinggi', fmtDMY(bd), `Omzet ${rupiah(dmap.get(bd).revenue)} · ${num(dmap.get(bd).orders)} pesanan`]);
  }
  if (months.length > 1) {
    const bm = hi(months.map(k => ({ k, v: mmap.get(k).revenue })), x => x.v);
    insights.push(['Bulan omzet tertinggi', `${BLN[Number(bm.k.slice(5, 7)) - 1]} ${bm.k.slice(0, 4)}`, `Omzet ${rupiah(bm.v)}`]);
  }
  if (insights.length) {
    R.push([]);
    R.push([{ v: 'Sorotan Periode', s: S.header }, { v: 'Pemenang', s: S.header }, { v: 'Keterangan', s: S.header }]);
    insights.forEach(i => R.push([i[0], { v: i[1], s: S.wrap }, { v: i[2], s: S.noteWrap }]));
  }
  R.push([]);
  R.push([{ v: 'Cara membaca: PROFIT KOTOR = omzet - biaya admin - biaya lain - affiliate - biaya proses (modal belum dikurangi). LABA SETELAH MODAL = profit kotor - modal (pajak & iklan belum dikurangi). PROFIT BERSIH = laba setelah modal - pajak - iklan.', s: S.noteWrap }]);
  const legendRow = R.length;
  R.push([{ v: 'Omzet dihitung hanya dari transaksi berstatus "selesai". Batal/retur tidak masuk omzet, modal, pajak, affiliate maupun biaya proses. Satu resi / no. pesanan = 1 pesanan: biaya proses dihitung sekali walau berisi beberapa produk.', s: S.noteWrap }]);
  const noteRow = R.length;
  R.push([{ v: 'Panduan sheet: Penjualan (bisa diimpor ulang) · Per Marketplace · Per Produk · Per Tanggal · Per Bulan · Iklan' + '. Angka total memakai rumus Excel, jadi ikut berubah bila Anda mengedit data.', s: S.noteWrap }]);
  const summary = { name: 'Ringkasan', rows: R, widths: [56, 22, 58], tab: 'FF0F766E', landscape: false,
    merges: ['A1:C1', `A${legendRow}:C${legendRow}`, `A${noteRow}:C${noteRow}`, `A${noteRow + 1}:C${noteRow + 1}`], rowHeights: { 1: 24, [legendRow]: 48, [noteRow]: 42, [noteRow + 1]: 30 },
    cf: [{ sqref: `B${base + 11}:B${base + 12}`, op: 'lessThan', val: 0, dxf: 0 }] };

  return [summary, sheetSales, sheetMp, sheetProd, sheetDay, sheetMonth, sheetAds];
}

if (typeof module !== 'undefined') {
  module.exports = { matchSale, mergeSales, saleSig, validYMD, parseISO, calc, summarize, parseCSV, csvToSales, rowsToSales, salesSheet, templateSheets, parseNumber, parseDate, rupiah,
    reportWorkbook, netProfitMap, grossProfitMap, cleanFee, previousRange, pctChange, dayDiff, addDays, buildBackup, parseBackup, mergeBackup, sanitizeSale, deductions, cleanRp, saleExtras, orderKeyOf, feeCarriers, productKey, findProduct, productMargin, priceFromMargin, productsSheet, productTemplateSheets, rowsToProducts, mergeProducts };
}

// Cocokkan transaksi dengan kata kunci: nama produk atau nomor resi / pesanan.
function matchSale(s, q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return true;
  return String(s.product || '').toLowerCase().includes(q) || String(s.orderNo || '').toLowerCase().includes(q);
}

// Tinggi kepala yang menempel dipakai bar filter agar menempel tepat di bawahnya (bagian yang terlihat = tinggi - padding atas halaman).
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const h = document.getElementById('stickyHead');
    if (!h) return;
    const set = () => {
      const pad = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
      document.documentElement.style.setProperty('--stick-h', (h.offsetHeight - pad) + 'px');
    };
    set();
    window.addEventListener('resize', set);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(h);
  });
}
