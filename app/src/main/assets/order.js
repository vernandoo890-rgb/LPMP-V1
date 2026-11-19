const $ = id => document.getElementById(id);
let products = [], settings = { fees: {} }, mp = 'Shopee', cart = [], feeTouched = false, recentIds = [];

const lastKey = 'lm_recent_ids';
const toNum = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

async function init() {
  $('date').value = todayISO();
  settings = await store.getSettings();
  products = await store.getProducts();
  mp = settings.lastMarketplace && MARKETPLACES.includes(settings.lastMarketplace) ? settings.lastMarketplace : MARKETPLACES[0];
  try { recentIds = JSON.parse(localStorage.getItem(lastKey) || '[]'); } catch (e) { recentIds = []; }
  renderChips(); applyFee(); renderTiles(); renderCart(); refreshToday(); renderRecent();
  $('pSearch').addEventListener('input', renderTiles);
  $('manualBtn').addEventListener('click', () => { const n = prompt('Nama produk:'); if (n && n.trim()) addProduct({ name: n.trim(), cost: 0, price: 0 }); });
  $('feePct').addEventListener('input', () => { feeTouched = true; update(); });
  ['otherCost', 'status'].forEach(i => $(i).addEventListener('input', update));
  $('orderNo').addEventListener('input', checkDup);
  $('date').addEventListener('change', refreshToday);
  $('saveBtn').addEventListener('click', save);
  document.querySelectorAll('input[type=number]').forEach(e => e.addEventListener('focus', () => setTimeout(() => e.select(), 0)));
  chrome.storage.onChanged.addListener(async (c, a) => { if (a === 'local' && (c.products || c.settings || c.sales)) { products = await store.getProducts(); settings = await store.getSettings(); renderTiles(); refreshToday(); } });
}

function renderChips() {
  $('mpChips').innerHTML = '';
  MARKETPLACES.forEach(m => {
    const b = el(`<button type="button" class="chip${m === mp ? ' on' : ''}" role="radio" aria-checked="${m === mp}">${escapeHtml(m)}</button>`);
    b.onclick = () => { mp = m; feeTouched = false; renderChips(); applyFee(); checkDup(); };
    $('mpChips').appendChild(b);
  });
}
function applyFee() {
  if (feeTouched) return;
  const f = settings.fees && settings.fees[mp];
  $('feePct').value = f !== undefined ? f : 0;
  update();
}

function renderTiles() {
  const q = $('pSearch').value.trim().toLowerCase();
  const list = products.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q));
  const box = $('tiles'); box.innerHTML = '';
  if (!products.length) { box.innerHTML = '<div class="empty">Belum ada produk di menu Produk. Gunakan "Produk manual" atau isi menu Produk dulu.</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="empty">Produk tidak ditemukan.</div>'; return; }
  list.forEach(p => {
    const inCart = cart.find(c => productKey(c.name) === productKey(p.name));
    const t = el(`<button type="button" class="tile"><b>${escapeHtml(p.name)}</b><small>${p.price ? rupiah(p.price) : 'harga belum diisi'}</small>${inCart ? `<span class="bdg">${inCart.qty}</span>` : ''}</button>`);
    t.onclick = () => addProduct(p);
    box.appendChild(t);
  });
}

function addProduct(p) {
  const ex = cart.find(c => productKey(c.name) === productKey(p.name));
  if (ex) ex.qty += 1;
  else cart.push({ name: p.name, qty: 1, price: toNum(p.price), cogs: toNum(p.cost) });
  renderCart(); renderTiles();
}

function renderCart() {
  const box = $('cart'); box.innerHTML = '';
  $('cartCount').textContent = cart.length ? `(${cart.length} produk)` : '';
  if (!cart.length) box.innerHTML = '<div class="none">Belum ada produk. Ketuk produk di atas.</div>';
  cart.forEach((c, i) => {
    const d = el(`<div class="item">
      <div class="top"><b>${escapeHtml(c.name)}</b><button type="button" class="del" aria-label="Hapus">✕</button></div>
      <div class="grid">
        <div class="step"><button type="button" data-a="-">−</button><input type="number" inputmode="numeric" min="1" value="${c.qty}" data-f="qty" aria-label="Jumlah"><button type="button" data-a="+">+</button></div>
        <label>Harga jual/unit<input type="number" inputmode="numeric" min="0" step="any" value="${c.price || ''}" data-f="price" placeholder="Rp"></label>
        <label>Kulakan/unit<input type="number" inputmode="numeric" min="0" step="any" value="${c.cogs || ''}" data-f="cogs" placeholder="Rp"></label>
      </div><div class="sub"></div></div>`);
    const sub = () => { d.querySelector('.sub').textContent = 'Subtotal ' + rupiah(c.qty * c.price); };
    sub();
    d.querySelector('.del').onclick = () => { cart.splice(i, 1); renderCart(); renderTiles(); };
    d.querySelectorAll('button[data-a]').forEach(b => b.onclick = () => { c.qty = Math.max(1, c.qty + (b.dataset.a === '+' ? 1 : -1)); renderCart(); renderTiles(); });
    d.querySelectorAll('input[data-f]').forEach(inp => {
      inp.addEventListener('focus', () => setTimeout(() => inp.select(), 0));
      inp.addEventListener('input', () => { c[inp.dataset.f] = inp.dataset.f === 'qty' ? Math.max(1, Math.floor(Number(inp.value)) || 1) : toNum(inp.value); sub(); update(); });
    });
    box.appendChild(d);
  });
  update();
}

function build() {
  const feePct = Math.min(100, toNum($('feePct').value));
  const status = $('status').value, orderNo = $('orderNo').value.trim();
  const other = toNum($('otherCost').value);
  return cart.map((c, i) => ({
    id: uid(), date: $('date').value || todayISO(), marketplace: mp, product: c.name,
    qty: c.qty, price: c.price, cogs: c.cogs, feePct, otherCost: i === 0 ? other : 0, status, orderNo, omzetMp: 0
  }));
}

function update() {
  const rows = build();
  let rev = 0, cost = 0, profit = 0;
  rows.forEach(s => { const c = calc(s); rev += c.revenue; cost += c.fee + c.hpp + c.otherCost; profit += c.profit; });
  $('tRev').textContent = rupiah(rev); $('tCost').textContent = rupiah(cost); $('tProfit').textContent = rupiah(profit);
  const ok = cart.length > 0 && cart.every(c => c.price > 0);
  $('saveBtn').disabled = !ok;
  $('saveBtn').textContent = cart.length && !ok ? 'Isi harga jual semua produk' : 'Simpan Order';
}

async function checkDup() {
  const no = $('orderNo').value.trim(), w = $('dupWarn');
  if (!no) { w.hidden = true; return; }
  const key = (mp.toLowerCase() + '|' + no.toLowerCase());
  const dup = (await store.getSales()).filter(s => orderKeyOf(s) === key);
  w.hidden = !dup.length;
  if (dup.length) w.textContent = `Resi ini sudah tercatat (${dup.length} produk). Pastikan bukan input ganda.`;
}

function msg(t, err) { const m = $('msg'); m.textContent = t; m.className = err ? 'err' : ''; clearTimeout(msg.t); msg.t = setTimeout(() => { m.textContent = ''; }, 4000); }

async function save() {
  const rows = build();
  if (!rows.length || rows.some(s => !(s.price > 0))) return msg('Isi harga jual semua produk', true);
  const no = rows[0].orderNo;
  if (no) {
    const key = orderKeyOf(rows[0]);
    if ((await store.getSales()).some(s => orderKeyOf(s) === key) && !confirm('Resi ini sudah pernah dicatat. Tetap simpan?')) return;
  }
  $('saveBtn').disabled = true;
  try {
    await store.withLock(async () => { const all = await store.getSales(); rows.forEach(r => all.push(r)); await store.setSales(all); });
    await store.updateSettings(s => { s.lastMarketplace = mp; return s; });
    recentIds.unshift({ ids: rows.map(r => r.id), no: no || '(tanpa resi)', mp, n: rows.length, date: rows[0].date, rev: rows.reduce((a, s) => a + calc(s).revenue, 0) });
    recentIds = recentIds.slice(0, 5);
    try { localStorage.setItem(lastKey, JSON.stringify(recentIds)); } catch (e) {}
    cart = []; $('orderNo').value = ''; $('otherCost').value = 0; $('status').value = 'selesai'; $('dupWarn').hidden = true; feeTouched = false;
    renderCart(); renderTiles(); applyFee(); renderRecent(); refreshToday();
    msg('✓ Order tersimpan');
    if (navigator.vibrate) navigator.vibrate(30);
  } catch (e) { msg('Gagal menyimpan: ' + e.message, true); }
  update();
}

function renderRecent() {
  const ul = $('recentList'); ul.innerHTML = '';
  $('recent').hidden = !recentIds.length;
  recentIds.forEach((r, i) => {
    const li = el(`<li><span><b>${escapeHtml(r.no)}</b> · ${escapeHtml(r.mp)}<small>${r.n} produk · ${rupiah(r.rev)}</small></span><button type="button">Batalkan</button></li>`);
    li.querySelector('button').onclick = async () => {
      if (!confirm('Hapus order ini dari catatan?')) return;
      await store.withLock(async () => { const all = (await store.getSales()).filter(s => !r.ids.includes(s.id)); await store.setSales(all); });
      recentIds.splice(i, 1); try { localStorage.setItem(lastKey, JSON.stringify(recentIds)); } catch (e) {}
      renderRecent(); refreshToday(); msg('Order dihapus');
    };
    ul.appendChild(li);
  });
}

async function refreshToday() {
  const d = $('date').value || todayISO();
  const list = (await store.getSales()).filter(s => s.date === d);
  const orders = new Set(list.map((s, i) => orderKeyOf(s) || 'x' + i)).size;
  let rev = 0, profit = 0; const pm = netProfitMap(list, settings);
  list.forEach(s => { rev += calc(s).revenue; profit += pm.get(s) || 0; });
  $('tdOrders').textContent = orders; $('tdRev').textContent = rupiah(rev); $('tdProfit').textContent = rupiah(profit);
}
init();
