const $ = id => document.getElementById(id);
let allSales = [];
let allAds = [];
let settings = { fees: {} };
let chartMode = 'both'; // 'both' | 'revenue' | 'profit'
let lastTrend = null;

const mpColor = name => {
  const i = MARKETPLACES.indexOf(name);
  return `var(--c${(i >= 0 ? i : MARKETPLACES.length - 1) + 1})`;
};

// ---------- rentang tanggal ----------
function getRange() {
  const p = $('period').value;
  const now = new Date();
  const today = toISODate(now);
  switch (p) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: toISODate(addDays(now, -6)), to: today };
    case '30d': return { from: toISODate(addDays(now, -29)), to: today };
    case 'month': return { from: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), to: toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case 'lastmonth': return { from: toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: toISODate(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case 'custom': {
      const f = $('from').value || '0000-01-01', t = $('to').value || '9999-12-31';
      return f > t ? { from: t, to: f } : { from: f, to: t }; // tanggal terbalik tetap menghasilkan data, bukan kosong
    }
    default: return { from: '0000-01-01', to: '9999-12-31' };
  }
}

function filtered(range = getRange()) {
  const { from, to } = range;
  const mp = $('mp').value;
  const q = $('q').value.trim().toLowerCase();
  return allSales.filter(s =>
    s.date >= from && s.date <= to &&
    (!mp || s.marketplace === mp) &&
    (!q || matchSale(s, q))
  );
}

// Iklan ikut filter periode dan marketplace; tidak ikut bila sedang mencari nama produk (iklan tidak terkait produk).
function filteredAds(range = getRange()) {
  const { from, to } = range;
  const mp = $('mp').value;
  if ($('q').value.trim()) return [];
  return allAds.filter(a => a.date >= from && a.date <= to && (!mp || a.marketplace === mp));
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---------- render ----------
// Beberapa pemicu dalam satu frame (ketik, ganti filter, data berubah dari popup) digabung jadi satu kali gambar.
let renderQueued = 0;
function render() {
  if (renderQueued) return;
  renderQueued = requestAnimationFrame(() => { renderQueued = 0; renderNow(); });
}
function renderNow() {
  if (renderQueued) { cancelAnimationFrame(renderQueued); renderQueued = 0; }
  document.querySelectorAll('#chips button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === $('period').value)));
  const list = filtered();
  const { from, to } = getRange();
  $('rangeLabel').textContent = from.startsWith('0000') && to.startsWith('9999')
    ? 'Semua periode'
    : `${from.startsWith('0000') ? '…' : fmtDate(from)} – ${to.startsWith('9999') ? '…' : fmtDate(to)}`;

  const prevRange = previousRange($('period').value, from, to, todayISO());
  let prev = null;
  if (prevRange) {
    const pl = filtered(prevRange);
    const pd = deductions(pl, filteredAds(prevRange), settings);
    const pt = summarize(pl);
    prev = { revenue: pt.revenue, net: pt.profit - pd.total, orders: pt.orders, label: `${fmtDate(prevRange.from)} – ${fmtDate(prevRange.to)}` };
  }
  const dd = deductions(list, filteredAds(), settings);
  renderKpis(list, dd, prev);
  renderGross(list, dd);
  renderTrend(list, from, to);
  renderCompare(list, from, to);
  renderByMarketplace(list);
  renderTopProducts(list);
  renderTable(list);
  renderAlerts(list);
  renderTarget();
  renderFixed();
}



// ---------- profit kotor (sebelum harga kulakan) ----------
// Profit kotor = omzet − biaya marketplace (admin, affiliate, biaya proses, biaya lain per pesanan).
// Sesudahnya dikurangi modal, pajak, dan iklan → sama persis dengan Profit bersih di kartu atas.
function grossBreakdown(list, d) {
  const t = summarize(list);
  const gross = t.revenue - t.fee - d.affiliate - d.procFee - t.otherCost;
  const net = gross - t.hpp - d.tax - d.adSpend - d.adTax;   // identik dengan t.profit - d.total
  return { t, gross, net };
}
function renderGross(list, d) {
  const { t, gross, net } = grossBreakdown(list, d);
  const box = $('grossBody');
  const adsAll = d.adSpend + d.adTax;
  if (!t.revenue && !d.total) { box.innerHTML = '<p class="empty">Belum ada penjualan pada periode ini.</p>'; return; }
  const pctOf = v => (t.revenue > 0 ? (Math.abs(v) / t.revenue) * 100 : 0);
  const rows = [
    { l: 'Omzet', v: t.revenue, k: 'base', always: true },
    { l: 'Biaya admin marketplace', v: -t.fee },
    { l: 'Affiliate', v: -d.affiliate },
    { l: 'Biaya proses pesanan', v: -d.procFee },
    { l: 'Biaya lain per pesanan', v: -t.otherCost },
    { l: 'Profit kotor', v: gross, k: 'gross', always: true, note: 'sebelum harga kulakan' },
    { l: 'Modal / harga kulakan', v: -t.hpp, always: true },
    { l: 'Pajak', v: -d.tax },
    { l: 'Iklan & PPN iklan', v: -adsAll },
    { l: 'Profit bersih', v: net, k: 'net', always: true, note: 'setelah semua biaya' }
  ].filter(r => r.always || r.v !== 0);
  const money = v => (v < 0 ? '−' : '') + rupiah(Math.abs(v));
  const gm = t.revenue > 0 ? (gross / t.revenue) * 100 : 0;
  box.innerHTML = `<div class="gross-hero">
      <div><span>Profit kotor</span><strong data-count class="${gross < 0 ? 'neg' : ''}">${rupiah(gross)}</strong>
        <small>${t.revenue > 0 ? `Margin kotor ${gm.toFixed(1).replace('.', ',')}% dari omzet` : 'Belum ada omzet'} · sebelum harga kulakan</small></div>
      <div><span>Modal / harga kulakan</span><strong>${rupiah(t.hpp)}</strong>
        <small>${t.revenue > 0 ? `${((t.hpp / t.revenue) * 100).toFixed(1).replace('.', ',')}% dari omzet` : ''}</small></div>
    </div>
    <ul class="wf" aria-label="Dari omzet ke profit bersih">${rows.map(r => `
      <li class="wf-${r.k || (r.v < 0 ? 'minus' : 'plus')}">
        <span class="wf-l">${r.k === 'base' ? '' : (r.k ? '= ' : '− ')}${r.l}${r.note ? ` <small>${r.note}</small>` : ''}</span>
        <span class="wf-bar" aria-hidden="true"><i class="wf-fill" style="width:${Math.min(100, pctOf(r.v)).toFixed(1)}%"></i></span>
        <span class="wf-v ${r.v < 0 && r.k ? 'neg' : ''}">${r.k ? rupiah(r.v) : money(r.v)}</span>
      </li>`).join('')}</ul>`;
}

// ---------- target bulanan & peringatan produk ----------
const LOW_MARGIN = 10; // % — di bawah ini dianggap perlu perhatian
function marginAlertsHtml(list) {
  const net = netProfitMap(list, settings);
  const by = new Map();
  for (const s of list) {
    const c = calc(s);
    if (!c.counted) continue;
    const k = productKey(s.product);
    const g = by.get(k) || { name: s.product, revenue: 0, profit: 0, qty: 0 };
    g.revenue += c.revenue; g.profit += net.get(s) || 0; g.qty += c.qty;
    by.set(k, g);
  }
  const bad = [...by.values()].filter(g => g.revenue > 0 && (g.profit / g.revenue) * 100 < LOW_MARGIN)
    .map(g => ({ ...g, margin: (g.profit / g.revenue) * 100 })).sort((a, b) => a.margin - b.margin);
  if (!by.size) return '<p class="empty">Belum ada data.</p>';
  if (!bad.length) return '<p class="goal-ok">✓ Semua produk bermargin sehat (≥ ' + LOW_MARGIN + '%).</p>';
  return '<h3 class="al-h">Margin rendah</h3><ul class="alert-list">' + bad.slice(0, 5).map(g => `
    <li><span class="al-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
      <span class="al-val ${g.profit < 0 ? 'neg' : ''}">${g.margin.toFixed(1).replace('.', ',')}%</span>
      <small>${g.profit < 0 ? 'Rugi ' : 'Profit '}${rupiah(Math.abs(g.profit))} dari omzet ${rupiah(g.revenue)} · ${num(g.qty)} unit</small></li>`).join('') + '</ul>'
    + (bad.length > 5 ? `<p class="sub">+ ${num(bad.length - 5)} produk lain.</p>` : '');
}


// Tingkat batal/retur per marketplace dan produk (dihitung per baris transaksi pada filter saat ini).
function returnAlertsHtml(list) {
  const rate = (arr, keyFn) => {
    const g = new Map();
    for (const s of arr) { const k = keyFn(s); const o = g.get(k) || { name: k, total: 0, bad: 0 }; o.total++; if (s.status !== 'selesai') o.bad++; g.set(k, o); }
    return [...g.values()].map(o => ({ ...o, pct: (o.bad / o.total) * 100 }));
  };
  const mps = rate(list, s => s.marketplace).filter(o => o.total >= 5 && o.pct >= 10).sort((a, b) => b.pct - a.pct);
  const prods = rate(list, s => s.product).filter(o => o.bad >= 3 && o.pct >= 15).sort((a, b) => b.bad - a.bad || b.pct - a.pct).slice(0, 3);
  if (!mps.length && !prods.length) return '';
  const li = o => `<li><span class="al-name" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</span><span class="al-val">${o.pct.toFixed(0)}%</span><small>${num(o.bad)} dari ${num(o.total)} transaksi dibatalkan/dikembalikan</small></li>`;
  return '<h3 class="al-h">Batal &amp; retur tinggi</h3><ul class="alert-list">' + mps.map(li).join('') + prods.map(li).join('') + '</ul>';
}
function renderAlerts(list) { $('alerts').innerHTML = marginAlertsHtml(list) + returnAlertsHtml(list); }

// Target dibandingkan dengan bulan kalender berjalan (semua marketplace), tidak ikut filter periode.
function monthTotals() {
  const ym = todayISO().slice(0, 7);
  const sales = allSales.filter(s => s.date.slice(0, 7) === ym);
  const ads = allAds.filter(a => a.date.slice(0, 7) === ym);
  const t = summarize(sales);
  return { revenue: t.revenue, profit: t.profit - deductions(sales, ads, settings).total };
}
function goalBar(label, cur, target, dayFrac) {
  const pct = target > 0 ? (cur / target) * 100 : 0;
  const width = Math.max(0, Math.min(100, pct));
  const pace = target * dayFrac;
  const ahead = cur >= pace;
  const proj = dayFrac > 0 ? cur / dayFrac : 0;
  return `<div class="goal">
    <div class="goal-head"><span>${label}</span><span class="goal-pct ${cur < 0 ? 'neg' : ''}" data-count>${pct.toFixed(0)}%</span></div>
    <div class="goal-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(width)}" aria-label="${label}">
      <div class="goal-fill ${pct >= 100 ? 'done' : ahead ? 'ahead' : 'behind'}" style="width:${width}%"></div>
      <i class="goal-pace" style="left:${Math.min(100, dayFrac * 100)}%" title="Posisi ideal hari ini"></i>
    </div>
    <small>${rupiah(cur)} dari ${rupiah(target)} · ${pct >= 100 ? 'target tercapai 🎉' : `sisa ${rupiah(target - cur)}`}<br>
      ${pct >= 100 ? '' : `${ahead ? 'Di atas' : 'Di bawah'} laju ideal (${rupiah(pace)}) · perkiraan akhir bulan ${rupiah(proj)}`}</small></div>`;
}
function renderTarget() {
  const tg = settings.targets || {};
  const tr = Number(tg.revenue) || 0, tp = Number(tg.profit) || 0;
  const body = $('targetBody');
  if (!(tr > 0) && !(tp > 0)) {
    body.innerHTML = '<p class="empty">Belum ada target. Klik <b>Atur target</b> untuk menentukan target omzet dan profit bulan ini.</p>';
    return;
  }
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayFrac = now.getDate() / dim;
  const m = monthTotals();
  body.innerHTML = (tr > 0 ? goalBar('Omzet', m.revenue, tr, dayFrac) : '') + (tp > 0 ? goalBar('Profit bersih', m.profit, tp, dayFrac) : '')
    + `<p class="sub">Bulan berjalan, semua marketplace · hari ke-${now.getDate()} dari ${dim}.</p>`;
}
function openTargetForm(open) {
  const f = $('targetForm');
  f.hidden = !open;
  $('btnTarget').setAttribute('aria-expanded', String(open));
  if (open) {
    const tg = settings.targets || {};
    $('tgtRevenue').value = tg.revenue > 0 ? tg.revenue : '';
    $('tgtProfit').value = tg.profit > 0 ? tg.profit : '';
    $('tgtRevenue').focus();
  }
}


// ---------- biaya tetap & titik impas ----------
// Biaya tetap (sewa, gaji, dll.) dibandingkan dengan profit bersih bulan berjalan. Sengaja TIDAK dimasukkan ke
// angka "Profit bersih" di kartu atas dan ekspor Excel, agar angka lama tidak berubah.
function renderFixed() {
  const items = (settings.fixedCosts || []).filter(x => x && x.amount > 0);
  const total = items.reduce((a, x) => a + x.amount, 0);
  $('fixedList').innerHTML = items.length ? items.map(x => `<li><span class="fx-name">${escapeHtml(x.name)}</span><span class="fx-amt">${rupiah(x.amount)}</span><button type="button" class="danger" data-fxdel="${escapeHtml(x.id)}" aria-label="Hapus ${escapeHtml(x.name)}">Hapus</button></li>`).join('') : '<li class="muted">Belum ada biaya tetap.</li>';
  const body = $('fixedBody');
  if (!total) { body.innerHTML = '<p class="empty">Belum ada biaya tetap. Klik <b>Atur biaya tetap</b> untuk menambah sewa, gaji, internet, dll. Anda akan melihat laba setelah biaya tetap dan titik impas bulan ini.</p>'; return; }
  const m = monthTotals();
  const after = m.profit - total;
  const margin = m.revenue > 0 ? m.profit / m.revenue : 0;
  const be = margin > 0 ? total / margin : 0; // omzet yang dibutuhkan agar impas, dengan margin bersih bulan ini
  const pct = be > 0 ? Math.max(0, Math.min(100, (m.revenue / be) * 100)) : 0;
  let verdict;
  if (after >= 0) verdict = '<p class="goal-ok">✓ Sudah melewati titik impas bulan ini.</p>';
  else if (be > 0) verdict = `<p class="fx-verdict">Perlu omzet sekitar <b>${rupiah(be)}</b> untuk impas (kurang ${rupiah(be - m.revenue)}), dengan margin bersih bulan ini ${(margin * 100).toFixed(1).replace('.', ',')}%.</p>`;
  else verdict = '<p class="fx-verdict">Titik impas belum bisa diperkirakan karena belum ada profit bersih bulan ini.</p>';
  body.innerHTML = `<div class="fx-grid">
      <div><span>Biaya tetap / bulan</span><strong data-count>${rupiah(total)}</strong></div>
      <div><span>Profit bersih bulan ini</span><strong data-count class="${m.profit < 0 ? 'neg' : ''}">${rupiah(m.profit)}</strong><small>setelah iklan &amp; pajak</small></div>
      <div><span>Laba setelah biaya tetap</span><strong data-count class="${after < 0 ? 'neg' : 'pos'}">${rupiah(after)}</strong></div>
    </div>`
    + (be > 0 ? `<div class="goal-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Menuju titik impas"><div class="goal-fill ${after >= 0 ? 'done' : 'behind'}" style="width:${pct}%"></div></div>` : '')
    + verdict
    + '<p class="sub">Bulan berjalan, semua marketplace. Biaya tetap dihitung penuh sebulan dan tidak masuk ke angka Profit bersih di kartu atas maupun ekspor Excel.</p>';
}
function openFixedForm(open) {
  $('fixedForm').hidden = !open;
  $('btnFixed').setAttribute('aria-expanded', String(open));
  if (open) $('fxName').focus();
}
async function saveFixed(mutate) {
  try { settings = await store.updateSettings(c => ({ ...c, fixedCosts: mutate((c.fixedCosts || []).slice()) })); }
  catch (err) { return notice('Gagal menyimpan biaya tetap: ' + err.message); }
  renderFixed();
}

// Selisih terhadap periode pembanding: naik = hijau, turun = merah (untuk omzet, profit, pesanan lebih besar = lebih baik).
function deltaHtml(cur, prevVal, prev) {
  if (!prev) return '';
  const pc = pctChange(cur, prevVal);
  const tip = `Periode pembanding ${prev.label}`;
  if (pc === null) return `<span class="delta" title="${tip}">${cur ? 'Baru · ' : ''}periode lalu 0</span>`;
  if (Math.abs(pc) < 0.05) return `<span class="delta" title="${tip}">▬ sama dgn periode lalu</span>`;
  const up = pc > 0;
  return `<span class="delta ${up ? 'up' : 'down'}" title="${tip}">${up ? '▲' : '▼'} ${Math.abs(pc).toFixed(1).replace('.', ',')}% vs periode lalu</span>`;
}

function renderKpis(list, d, prev) {
  const t = summarize(list);
  const net = t.profit - d.total;
  const margin = t.revenue ? (net / t.revenue) * 100 : 0;
  const cls = net < 0 ? 'neg' : '';
  $('kpis').innerHTML = `
    <div class="kpi k-rev"><span>Omzet</span><strong>${rupiah(t.revenue)}</strong><small>${num(t.qty)} unit terjual</small>${deltaHtml(t.revenue, prev && prev.revenue, prev)}</div>
    <div class="kpi k-profit"><span>Profit bersih</span><strong class="${cls}">${rupiah(net)}</strong><small>Margin ${margin.toFixed(1)}% · setelah semua biaya</small>${deltaHtml(net, prev && prev.net, prev)}</div>
    <div class="kpi k-orders"><span>Pesanan selesai</span><strong>${num(t.orders)}</strong><small>${t.cancelled} batal/retur</small>${deltaHtml(t.orders, prev && prev.orders, prev)}</div>
    <div class="kpi k-aov"><span>Rata-rata / pesanan</span><strong>${rupiah(t.aov)}</strong><small>Omzet ÷ pesanan selesai</small></div>
    <div class="kpi k-fee"><span>Biaya admin</span><strong>${rupiah(t.fee)}</strong><small>Modal ${rupiah(t.hpp)}</small></div>
    <div class="kpi k-ads"><span>Iklan &amp; pajak</span><strong>${rupiah(d.adSpend + d.adTax + d.tax)}</strong><small>Iklan ${rupiah(d.adSpend + d.adTax)} · Pajak ${rupiah(d.tax)}</small></div>
    <div class="kpi k-aff"><span>Affiliate &amp; biaya proses</span><strong>${rupiah(d.affiliate + d.procFee)}</strong><small>Affiliate ${rupiah(d.affiliate)} · Proses ${rupiah(d.procFee)}</small></div>`;
}

// Tren: per hari bila rentang <= 62 hari, selain itu per bulan.
function renderTrend(list, from, to) {
  const counted = list.filter(s => s.status === 'selesai');
  const dates = list.map(s => s.date).sort();
  let start = from.startsWith('0000') ? (dates[0] || todayISO()) : from;
  let end = to.startsWith('9999') ? (dates[dates.length - 1] || todayISO()) : to;
  const today = todayISO();
  // Rentang bulan ini berakhir di akhir bulan; potong sampai hari ini, kecuali ada transaksi bertanggal setelahnya
  // (supaya grafik tetap sama dengan angka KPI).
  if (end > today && $('period').value !== 'custom') {
    const lastSale = dates[dates.length - 1] || today;
    const newEnd = lastSale > today ? lastSale : today;
    if (newEnd < end) end = newEnd;
    if (end < start) end = start;
  }

  const days = dayDiff(start, end) + 1;
  const byMonth = days > 62;
  const buckets = new Map();

  if (byMonth) {
    let d = parseISO(start.slice(0, 7) + '-01');
    const last = end.slice(0, 7);
    while (toISODate(d).slice(0, 7) <= last) {
      buckets.set(toISODate(d).slice(0, 7), { revenue: 0, profit: 0 });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  } else {
    const first = parseISO(start);
    for (let i = 0; i < days; i++) buckets.set(toISODate(addDays(first, i)), { revenue: 0, profit: 0 });
  }
  for (const s of counted) {
    const k = byMonth ? s.date.slice(0, 7) : s.date;
    const b = buckets.get(k);
    if (!b) continue;
    const c = calc(s);
    b.revenue += c.revenue; b.profit += c.profit;
  }
  const keys = [...buckets.keys()];
  const data = keys.map(k => ({ key: k, ...buckets.get(k) }));
  if (!data.length || data.every(d => d.revenue === 0)) {
    $('trend').innerHTML = '<p class="empty">Belum ada data untuk digambar.</p>';
    return;
  }

  // Grafik: batang omzet + garis profit (sebelum iklan). Mode bisa diganti lewat tombol di atas grafik.
  lastTrend = { data, byMonth };
  const mode = chartMode;
  const W = Math.max(320, Math.round($('trend').clientWidth) || 800), H = 240, pl = 52, pr = 10, pt = 14, pb = 28;
  const vals = [];
  if (mode !== 'profit') data.forEach(d => vals.push(d.revenue));
  if (mode !== 'revenue') data.forEach(d => vals.push(d.profit));
  const maxV = Math.max(...vals, 1), minV = Math.min(0, ...vals);
  const span = (maxV - minV) || 1;
  const y = v => pt + (H - pt - pb) * (1 - (v - minV) / span);
  const slot = (W - pl - pr) / data.length;
  const bw = Math.max(3, Math.min(34, slot * 0.68));
  const x = i => pl + slot * i + slot / 2;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik omzet dan profit">`;
  svg += '<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c2)"/><stop offset="1" style="stop-color:var(--c2);stop-opacity:.35"/></linearGradient>'
    + '<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>';
  svg += '<g class="grid">';
  for (let t = 0; t <= 3; t++) {
    const v = minV + (span * t) / 3;
    svg += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${shortRp(v)}</text>`;
  }
  svg += '</g>';
  if (minV < 0) svg += `<line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (mode !== 'profit') {
    data.forEach((d, i) => {
      const top = Math.min(y(d.revenue), y(0)), h = Math.abs(y(0) - y(d.revenue));
      svg += `<rect class="bar" x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="3" fill="url(#barGrad)"/>`;
    });
  }
  if (mode !== 'revenue') {
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.profit).toFixed(1)}`);
    if (data.length > 1) {
      svg += `<path class="area" d="M${x(0).toFixed(1)},${y(0)} L${pts.join(' L')} L${x(data.length - 1).toFixed(1)},${y(0)} Z" fill="url(#areaGrad)"/>`;
      svg += `<polyline class="line" points="${pts.join(' ')}" fill="none"/>`;
    }
    if (data.length <= 62) data.forEach((d, i) => { svg += `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.profit).toFixed(1)}" r="${data.length > 31 ? 2 : 3}"/>`; });
  }
  const every = Math.ceil(data.length / Math.max(2, Math.floor((W - pl) / 90)));
  data.forEach((d, i) => {
    if (i % every === 0) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(d.key, byMonth)}</text>`;
  });
  data.forEach((d, i) => { svg += `<rect class="hit" data-i="${i}" x="${pl + slot * i}" y="${pt}" width="${slot}" height="${H - pt - pb}"/>`; });
  svg += '</svg>';
  $('trend').innerHTML = svg + '<div class="tip" hidden></div>';
  $('trend').dataset.w = W;
}


// ---------- perbandingan antar marketplace (omzet bertumpuk / margin) ----------
let cmpMode = 'mp'; // 'mp' | 'margin'
function trendKeys(list, from, to) {
  const dates = list.map(s => s.date).sort();
  const start = from.startsWith('0000') ? (dates[0] || todayISO()) : from;
  let end = to.startsWith('9999') ? (dates[dates.length - 1] || todayISO()) : to;
  const today = todayISO();
  if (end > today && $('period').value !== 'custom') { // sama seperti grafik utama: potong sampai hari ini
    const lastSale = dates[dates.length - 1] || today;
    const newEnd = lastSale > today ? lastSale : today;
    if (newEnd < end) end = newEnd;
    if (end < start) end = start;
  }
  const days = dayDiff(start, end) + 1;
  const byMonth = days > 62;
  const keys = [];
  if (byMonth) {
    let d = parseISO(start.slice(0, 7) + '-01');
    const last = end.slice(0, 7);
    while (toISODate(d).slice(0, 7) <= last) { keys.push(toISODate(d).slice(0, 7)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  } else {
    const first = parseISO(start);
    for (let i = 0; i < days; i++) keys.push(toISODate(addDays(first, i)));
  }
  return { keys, byMonth };
}
function renderCompare(list, from, to) {
  const box = $('cmpChart');
  const { keys, byMonth } = trendKeys(list, from, to);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const per = new Map(); // marketplace -> { revenue[], profit[], total }
  for (const s of list) {
    if (s.status !== 'selesai') continue;
    const i = idx.get(byMonth ? s.date.slice(0, 7) : s.date);
    if (i === undefined) continue;
    const c = calc(s);
    const g = per.get(s.marketplace) || { revenue: keys.map(() => 0), profit: keys.map(() => 0), total: 0 };
    g.revenue[i] += c.revenue; g.profit[i] += c.profit; g.total += c.revenue;
    per.set(s.marketplace, g);
  }
  const names = [...per.keys()].sort((a, b) => per.get(b).total - per.get(a).total);
  $('cmpLegend').innerHTML = names.map(n => `<span><i class="sw" style="background:${mpColor(n)}"></i>${escapeHtml(n)}</span>`).join('')
    + (cmpMode === 'margin' && names.length ? '<span><i class="sw all"></i>Semua</span>' : '');
  if (!names.length || !keys.length) { box.innerHTML = '<p class="empty">Belum ada data untuk dibandingkan.</p>'; $('cmpNote').textContent = ''; return; }

  const W = Math.max(320, Math.round(box.clientWidth) || 800), H = 240, pl = 52, pr = 10, pt = 14, pb = 28;
  const slot = (W - pl - pr) / keys.length;
  const x = i => pl + slot * i + slot / 2;
  const every = Math.ceil(keys.length / Math.max(2, Math.floor((W - pl) / 90)));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${cmpMode === 'mp' ? 'Omzet per marketplace' : 'Margin per marketplace'}">`;
  let grid = '', body = '';
  const axisX = () => keys.map((k, i) => (i % every === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(k, byMonth)}</text>` : '')).join('');
  const tipRects = fn => keys.map((k, i) => `<rect class="hit" x="${pl + slot * i}" y="${pt}" width="${slot}" height="${H - pt - pb}"><title>${escapeHtml(fn(i))}</title></rect>`).join('');

  if (cmpMode === 'mp') {
    const totals = keys.map((_, i) => names.reduce((a, n) => a + per.get(n).revenue[i], 0));
    const maxV = Math.max(...totals, 1);
    const y = v => pt + (H - pt - pb) * (1 - v / maxV);
    const bw = Math.max(3, Math.min(34, slot * 0.68));
    for (let t = 0; t <= 3; t++) { const v = (maxV * t) / 3; grid += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${shortRp(v)}</text>`; }
    keys.forEach((k, i) => {
      let acc = 0;
      for (const n of names) {
        const v = per.get(n).revenue[i]; if (v <= 0) continue;
        const y1 = y(acc + v), h2 = y(acc) - y1; acc += v;
        body += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h2 - 0.6).toFixed(1)}" rx="2" class="seg-bar" style="--i:${Math.min(i, 40)};transform-origin:0 ${y(0).toFixed(1)}px;fill:${mpColor(n)}"/>`;
      }
    });
    svg += `<g class="grid">${grid}</g>${body}${axisX()}${tipRects(i => `${label(keys[i], byMonth)} — ` + names.filter(n => per.get(n).revenue[i] > 0).map(n => `${n}: ${rupiah(per.get(n).revenue[i])}`).join(' · ') + (totals[i] ? ` · Total: ${rupiah(totals[i])}` : ' — tidak ada penjualan'))}`;
    $('cmpNote').textContent = 'Omzet pesanan selesai per marketplace, ditumpuk. Arahkan kursor ke kolom untuk melihat rinciannya.';
  } else {
    const m = (p, r) => (r > 0 ? (p / r) * 100 : null);
    const series = names.map(n => ({ n, v: keys.map((_, i) => m(per.get(n).profit[i], per.get(n).revenue[i])) }));
    const all = keys.map((_, i) => m(names.reduce((a, n) => a + per.get(n).profit[i], 0), names.reduce((a, n) => a + per.get(n).revenue[i], 0)));
    const vals = [...series.flatMap(s => s.v), ...all].filter(v => v !== null);
    // Sumbu dipersempit bila semua margin positif supaya naik-turunnya terlihat (garis nol tetap muncul bila ada margin negatif).
    const vmin = vals.length ? Math.min(...vals) : 0, vmax = vals.length ? Math.max(...vals) : 10;
    const lo = vmin >= 0 ? Math.max(0, Math.floor((vmin - 5) / 5) * 5) : Math.floor(vmin / 10) * 10;
    const hi = Math.max(lo + 10, Math.ceil((vmax + 2) / 5) * 5);
    const y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
    for (let t = 0; t <= 4; t++) { const v = lo + ((hi - lo) * t) / 4; grid += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}%</text>`; }
    if (lo < 0) body += `<line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/>`;
    const path = vals2 => { let d = '', pen = false; vals2.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; }); return d; };
    const dots = (vals2, color, r) => keys.length <= 62 ? vals2.map((v, i) => (v === null ? '' : `<circle class="cmp-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${r}" style="--i:${Math.min(i, 40)};fill:var(--card);stroke:${color}" stroke-width="1.6"/>`)).join('') : '';
    for (const s of series) body += `<path class="cmp-line" pathLength="1" d="${path(s.v)}" fill="none" style="stroke:${mpColor(s.n)}" stroke-width="1.6" stroke-linejoin="round" opacity=".85"/>${dots(s.v, mpColor(s.n), 2.2)}`;
    body += `<path d="${path(all)}" fill="none" class="all-line" stroke-width="2.6" stroke-linejoin="round" stroke-dasharray="5 4"/>`;
    svg += `<g class="grid">${grid}</g>${body}${axisX()}${tipRects(i => `${label(keys[i], byMonth)} — ` + (all[i] === null ? 'tidak ada penjualan' : series.filter(s => s.v[i] !== null).map(s => `${s.n}: ${s.v[i].toFixed(1)}%`).join(' · ') + ` · Semua: ${all[i].toFixed(1)}%`))}`;
    $('cmpNote').textContent = 'Margin = profit ÷ omzet (setelah biaya admin, modal, pajak, affiliate & biaya proses; sebelum iklan). Garis putus-putus = gabungan semua marketplace. Periode panjang otomatis dirangkum per bulan agar tren lebih stabil.';
  }
  svg += '</svg>';
  box.innerHTML = svg;
  box.dataset.w = W;
}

function label(key, byMonth) {
  if (byMonth) { const [y, m] = key.split('-'); return `${m}/${y.slice(2)}`; }
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function shortRp(v) {
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(1).replace('.0', '')}M`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1).replace('.0', '')}jt`;
  if (a >= 1e3) return `${sign}${Math.round(a / 1e3)}rb`;
  return `${sign}${Math.round(a)}`;
}

function renderByMarketplace(list) {
  const groups = {};
  for (const s of list) {
    const g = groups[s.marketplace] || (groups[s.marketplace] = []);
    g.push(s);
  }
  const net = netProfitMap(list, settings);
  const gross = grossProfitMap(list, settings);
  const rows = Object.entries(groups)
    .map(([name, items]) => ({ name, ...summarize(items), profit: items.reduce((a, x) => a + (net.get(x) || 0), 0), gross: items.reduce((a, x) => a + (gross.get(x) || 0), 0) }))
    .filter(r => r.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);
  if (!rows.length) { $('byMp').innerHTML = '<p class="empty">Belum ada data.</p>'; return; }
  const total = rows.reduce((a, r) => a + r.revenue, 0) || 1;
  $('byMp').innerHTML = rows.map(r => `
    <div class="bar-row">
      <div class="meta"><span>${escapeHtml(r.name)}</span><span>${rupiah(r.revenue)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(r.revenue / total * 100).toFixed(1)}%;background:${mpColor(r.name)}"></div></div>
      <div class="sub">${(r.revenue / total * 100).toFixed(1)}% omzet · ${r.orders} pesanan · profit kotor ${rupiah(r.gross)} (sebelum modal) · profit ${rupiah(r.profit)} (setelah modal & pajak)</div>
    </div>`).join('');
}

function renderTopProducts(list) {
  const map = new Map();
  const net = netProfitMap(list, settings);
  const gross = grossProfitMap(list, settings);
  for (const s of list) {
    const c = calc(s);
    if (!c.counted) continue;
    const key = s.product.trim().toLowerCase();
    const cur = map.get(key) || { name: s.product, qty: 0, revenue: 0, profit: 0, gross: 0 };
    cur.qty += c.qty; cur.revenue += c.revenue; cur.profit += net.get(s) || 0; cur.gross += gross.get(s) || 0;
    map.set(key, cur);
  }
  const top = [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  if (!top.length) { $('topProducts').innerHTML = '<p class="empty">Belum ada data.</p>'; return; }
  const max = top[0].revenue || 1;
  $('topProducts').innerHTML = top.map(p => `
    <div class="bar-row">
      <div class="meta"><span>${escapeHtml(p.name)}</span><span>${rupiah(p.revenue)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(p.revenue / max * 100).toFixed(1)}%;background:var(--accent)"></div></div>
      <div class="sub">${num(p.qty)} unit · profit kotor ${rupiah(p.gross)} (sebelum modal) · profit ${rupiah(p.profit)} (setelah modal & pajak)</div>
    </div>`).join('');
}

// Urutan & halaman tabel transaksi. Bawaan: tanggal terbaru dulu.
const PAGE_SIZES = [50, 100, 250, 500];
const PRINT_MAX = 2000;
let sortKey = 'date', sortDir = 'desc', pageNo = 1, pageSize = 100, printing = false;
const selected = new Set();   // id transaksi yang dicentang
let filteredIds = [];         // id semua transaksi pada filter saat ini (untuk "pilih semua hasil filter")

function renderTable(list) {
  const net = netProfitMap(list, settings); // profit per baris sama dengan Profit bersih (sebelum iklan)
  const val = {
    date: s => s.date, marketplace: s => String(s.marketplace || '').toLowerCase(), product: s => String(s.product || '').toLowerCase(),
    orderNo: s => String(s.orderNo || '').toLowerCase(), qty: s => Number(s.qty) || 0, status: s => s.status,
    revenue: s => calc(s).revenue, fee: s => calc(s).fee, profit: s => (calc(s).counted ? (net.get(s) || 0) : 0)
  }[sortKey] || (s => s.date);
  const dir = sortDir === 'asc' ? 1 : -1;
  // Urutan sama: yang dicatat paling akhir tampil lebih dulu (untuk tanggal terbaru) / lebih akhir (untuk urutan naik).
  const sorted = list.map((s, i) => ({ s, i, v: val(s) })).sort((a, b) => {
    const c = typeof a.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'id');
    return c * dir || (b.i - a.i) * (sortKey === 'date' ? dir : 1);
  }).map(x => x.s);
  { const ms = $('mSort'), v = `${sortKey}:${sortDir}`; if ([...ms.options].some(o => o.value === v)) ms.value = v; }
  $('count').textContent = `(${sorted.length})`;
  $('empty').hidden = sorted.length > 0;
  filteredIds = sorted.map(s => s.id);
  { const alive = new Set(filteredIds); for (const id of [...selected]) if (!alive.has(id)) selected.delete(id); } // pilihan hanya untuk yang tampil di filter

  const total = sorted.length;
  const size = printing ? PRINT_MAX : pageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  if (pageNo > pages) pageNo = pages;
  if (pageNo < 1) pageNo = 1;
  const start = (pageNo - 1) * size;
  const shown = sorted.slice(start, start + size);

  document.querySelectorAll('#rows')[0].closest('table').querySelectorAll('th[data-sort]').forEach(th => {
    const on = th.dataset.sort === sortKey;
    th.classList.toggle('sorted', on);
    if (on) th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
  });

  $('rows').innerHTML = shown.map(s => {
    const c = calc(s);
    const profit = net.get(s) || 0;
    const off = s.status !== 'selesai';
    const badge = s.status === 'selesai' ? 'ok' : s.status === 'dikembalikan' ? 'warn' : 'bad';
    return `<tr class="${selected.has(s.id) ? 'selected' : ''}">
      <td class="sel"><input type="checkbox" data-sel="${escapeHtml(s.id)}" ${selected.has(s.id) ? 'checked' : ''} aria-label="Pilih transaksi ${escapeHtml(s.product)}"></td>
      <td data-label="Tanggal">${fmtDate(s.date)}</td>
      <td data-label="Marketplace">${escapeHtml(s.marketplace)}</td>
      <td class="prod" data-label="Produk">${escapeHtml(s.product)}</td>
      <td class="resi" data-label="Resi" title="${escapeHtml(s.orderNo || '')}">${s.orderNo ? escapeHtml(s.orderNo) : '<span class="muted">–</span>'}</td>
      <td class="r" data-label="Qty">${num(s.qty)}</td>
      <td class="r" data-label="Omzet">${off ? '–' : rupiah(c.revenue)}</td>
      <td class="r" data-label="Biaya admin">${off ? '–' : rupiah(c.fee)}</td>
      <td class="r ${profit < 0 ? 'neg' : ''}" data-label="Profit"><strong>${off ? '–' : rupiah(profit)}</strong></td>
      <td data-label="Status"><span class="badge ${badge}">${escapeHtml(s.status)}</span></td>
      <td class="nowrap act"><button type="button" class="edit" data-edit="${escapeHtml(s.id)}">Edit</button> <button type="button" data-del="${escapeHtml(s.id)}">Hapus</button></td>
    </tr>`;
  }).join('');
  const t = summarize(list); let tp = 0; net.forEach((v, k) => { if (calc(k).counted) tp += v; });
  $('foot').innerHTML = sorted.length ? `<tr class="tot"><td colspan="5" class="tot-label">Total ${num(sorted.length)} transaksi (${num(t.orders)} pesanan selesai)</td><td class="r" data-label="Qty">${num(t.qty)}</td><td class="r" data-label="Omzet">${rupiah(t.revenue)}</td><td class="r" data-label="Biaya admin">${rupiah(t.fee)}</td><td class="r ${tp < 0 ? 'neg' : ''}" data-label="Profit">${rupiah(tp)}</td><td colspan="2" class="tot-end"></td></tr>` : '';
  renderBulkBar(total, shown);
  renderPager(total, pages, start, shown.length);
}


// ---------- pilih banyak baris ----------
let pageIds = [];
function renderBulkBar(total, shown) {
  pageIds = shown.map(s => s.id);
  const n = selected.size;
  $('bulkBar').hidden = n === 0;
  const allPage = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const some = pageIds.some(id => selected.has(id));
  for (const sa of [$('selAll'), $('mSelAll')]) { sa.checked = allPage; sa.indeterminate = !allPage && some; }
  if (!n) return;
  $('bulkInfo').textContent = `${num(n)} transaksi dipilih`;
  const more = $('bulkAllFiltered');
  more.hidden = !(total > n && allPage);
  if (!more.hidden) more.textContent = `Pilih semua ${num(total)} hasil filter`;
  $('bulkStatusSel').value = '';
}
async function bulkEdit(mutate) {
  // Baca ulang dari penyimpanan di bawah kunci tulis, supaya tidak menimpa data baru dari popup.
  return store.withLock(async () => {
    const all = await store.getSales();
    const res = mutate(all);
    await store.setSales(res.next);
    return res;
  });
}
async function bulkDelete() {
  const ids = new Set(selected);
  if (!ids.size) return;
  if (!confirm(`Hapus ${num(ids.size)} transaksi terpilih?\n\nAnda masih bisa membatalkannya sesaat setelah dihapus.`)) return;
  let res;
  try { res = await bulkEdit(all => ({ next: all.filter(s => !ids.has(s.id)), removed: all.filter(s => ids.has(s.id)) })); }
  catch (err) { return notice('Gagal menghapus: ' + err.message); }
  selected.clear(); await load();
  notice(`${num(res.removed.length)} transaksi dihapus.`, { label: 'Batalkan', run: async () => {
    await bulkEdit(all => { const have = new Set(all.map(s => s.id)); return { next: all.concat(res.removed.filter(s => !have.has(s.id))) }; });
    await load(); notice('Penghapusan dibatalkan ✓');
  } });
}
async function bulkSetStatus(status) {
  const ids = new Set(selected);
  if (!ids.size || !STATUSES.includes(status)) return;
  let res;
  try {
    res = await bulkEdit(all => {
      const before = new Map();
      const next = all.map(s => { if (!ids.has(s.id) || s.status === status) return s; before.set(s.id, s.status); return { ...s, status }; });
      return { next, before };
    });
  } catch (err) { return notice('Gagal mengubah status: ' + err.message); }
  await load();
  if (!res.before.size) return notice(`Semua transaksi terpilih sudah berstatus ${status}.`);
  notice(`${num(res.before.size)} transaksi diubah menjadi ${status}.`, { label: 'Batalkan', run: async () => {
    await bulkEdit(all => ({ next: all.map(s => (res.before.has(s.id) ? { ...s, status: res.before.get(s.id) } : s)) }));
    await load(); notice('Perubahan status dibatalkan ✓');
  } });
}

function renderPager(total, pages, start, n) {
  const el = $('pager');
  if (!el) return;
  if (total <= PAGE_SIZES[0]) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="pg-info">${num(start + 1)}–${num(start + n)} dari ${num(total)}</span>
    <span class="pg-nav">
      <button type="button" data-pg="first" ${pageNo <= 1 ? 'disabled' : ''} aria-label="Halaman pertama">«</button>
      <button type="button" data-pg="prev" ${pageNo <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">‹</button>
      <span class="pg-cur">Hal. ${pageNo} / ${pages}</span>
      <button type="button" data-pg="next" ${pageNo >= pages ? 'disabled' : ''} aria-label="Halaman berikutnya">›</button>
      <button type="button" data-pg="last" ${pageNo >= pages ? 'disabled' : ''} aria-label="Halaman terakhir">»</button>
    </span>
    <label class="pg-size">Baris per halaman
      <select id="pgSize">${PAGE_SIZES.map(n2 => `<option value="${n2}" ${n2 === pageSize ? 'selected' : ''}>${n2}</option>`).join('')}</select>
    </label>`;
}

// ---------- aksi ----------
let noticeTimer;
// Pesan singkat di atas dashboard. Bila "aksi" diberikan ({label, run}), muncul tombol (mis. Batalkan) dan pesan bertahan lebih lama.
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
  if (text) noticeTimer = setTimeout(() => { el.hidden = true; }, aksi ? 9000 : 6000);
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
  [allSales, allAds, settings] = await Promise.all([store.getSales(), store.getAds(), store.getSettings()]);
  const names = new Set(MARKETPLACES);
  allSales.forEach(s => names.add(s.marketplace));
  allAds.forEach(a => a.marketplace && names.add(a.marketplace));
  const cur = $('mp').value;
  $('mp').innerHTML = '<option value="">Semua</option>' + [...names].map(n => `<option>${escapeHtml(n)}</option>`).join('');
  $('mp').value = cur;
  render();
  renderBackupBar();
  autoBackupIfDue();
}

// ---------- edit transaksi ----------
let editingId = null;

function readEdit() {
  return {
    date: $('eDate').value,
    marketplace: $('eMp').value.trim(),
    product: $('eProduct').value.trim(),
    qty: Number($('eQty').value),
    price: Number($('ePrice').value),
    cogs: Number($('eCogs').value) || 0,
    feePct: Number($('eFee').value) || 0,
    otherCost: Number($('eOther').value) || 0,
    status: $('eStatus').value,
    orderNo: $('eOrder').value.trim(),
    omzetMp: Number($('eOmzet').value) || 0
  };
}

function updateEditPreview() {
  const f = readEdit(), c = calc(f);
  $('ePreview').textContent = c.counted
    ? `Omzet ${rupiah(c.revenue)} · Biaya admin ${rupiah(c.fee)} · Profit ${rupiah(c.profit)}`
    : 'Pesanan tidak dihitung sebagai omzet';
  $('ePreview').className = 'preview wide' + (c.counted && c.profit < 0 ? ' warn' : '');
}

function openEdit(id) {
  const s = allSales.find(x => x.id === id);
  if (!s) return;
  editingId = id;
  $('eMpList').innerHTML = [...$('mp').options].filter(o => o.value).map(o => `<option value="${escapeHtml(o.value)}">`).join('');
  $('eDate').value = s.date; $('eMp').value = s.marketplace || ''; $('eProduct').value = s.product;
  $('eQty').value = s.qty; $('ePrice').value = s.price; $('eCogs').value = s.cogs || 0;
  $('eFee').value = s.feePct || 0; $('eOther').value = s.otherCost || 0; $('eStatus').value = STATUSES.includes(s.status) ? s.status : 'selesai';
  $('eOrder').value = s.orderNo || '';
  $('eOmzet').value = s.omzetMp || '';
  $('eMsg').textContent = '';
  updateEditPreview();
  $('editDlg').showModal();
}

async function saveEdit(e) {
  e.preventDefault();
  const f = readEdit();
  if (!(f.price > 0) && f.omzetMp > 0 && f.qty > 0) f.price = f.omzetMp / f.qty; // harga / unit dihitung dari omzet marketplace
  if (!validYMD(...f.date.split('-')) ) return ($('eMsg').textContent = 'Tanggal tidak valid.');
  if (!f.marketplace || !f.product) return ($('eMsg').textContent = 'Marketplace dan produk wajib diisi.');
  if (!(f.qty > 0)) return ($('eMsg').textContent = 'Qty harus lebih dari 0.');
  if (!(f.price > 0)) return ($('eMsg').textContent = 'Isi harga jual atau omzet marketplace (lebih dari 0).');
  if (f.cogs < 0 || f.otherCost < 0 || f.feePct < 0 || f.feePct > 100) return ($('eMsg').textContent = 'Modal, biaya lain tidak boleh negatif; biaya admin 0–100%.');
  try {
    const list = await store.updateSale(editingId, f);
    if (!list) { $('editDlg').close(); await load(); return notice('Transaksi sudah tidak ada (mungkin dihapus dari tab lain).'); }
    allSales = list;
  } catch (err) {
    return ($('eMsg').textContent = 'Gagal menyimpan: ' + err.message);
  }
  $('editDlg').close();
  await load();
  notice('Transaksi diperbarui ✓');
}


// ---------- impor Laporan Penghasilan Shopee ----------
const rp0 = n => rupiah(Math.round(n));
function askShopeeImport(p, products, settings) {
  const dlg = $('shopeeDlg');
  $('spSummary').innerHTML = `<b>${num(p.orders)}</b> pesanan · <b>${num(p.lines.length)}</b> baris produk · ${fmtDate(p.from)} – ${fmtDate(p.to)}<br>Omzet ${rp0(p.revenue)} · Biaya admin &amp; layanan ${rp0(p.fee)} · Total penghasilan ${rp0(p.total)}`;
  $('spRows').innerHTML = p.groups.map(g => {
    const c = costFromMenu(products, g.name);
    return `<tr><td class="prod" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</td><td class="r">${num(g.lines)}</td><td class="r">${num(g.units)}</td>
      <td class="r"><input type="number" min="0" step="any" data-key="${escapeHtml(g.key)}" value="${c || ''}" placeholder="0" aria-label="Modal per unit: ${escapeHtml(g.name)}"></td></tr>`;
  }).join('');
  const cur = Number(((settings || {}).procFee || {}).Shopee) || 0;
  const showProc = p.procPerOrder > 0 && cur !== p.procPerOrder;
  $('spProcWrap').hidden = !showProc;
  $('spProcOk').hidden = !(p.procPerOrder > 0 && cur === p.procPerOrder);
  $('spProcOk').textContent = `✓ Biaya proses pesanan Shopee di menu Biaya Admin sudah ${rp0(p.procPerOrder)} per pesanan, sesuai laporan.`;
  $('spProc').checked = showProc && cur === 0;
  $('spProcText').textContent = `Atur Biaya proses pesanan Shopee = ${rp0(p.procPerOrder)} per pesanan di menu Biaya Admin${cur ? ` (sekarang ${rp0(cur)})` : ''}. Laporan ini memotongnya ${rp0(p.proc)}; biaya itu dihitung dari pengaturan, bukan dari transaksi.`;
  $('spTopupWrap').hidden = !(p.topup > 0);
  $('spTopup').checked = false;
  $('spTopupText').textContent = `Hitung Biaya Isi Saldo Otomatis (${rp0(p.topup)}) sebagai biaya lain. Jangan dicentang bila iklan Shopee sudah Anda catat di menu Iklan, agar tidak terhitung dua kali.`;
  $('spSaveMenu').checked = true;
  $('spAll').value = '';
  $('spApplyAll').onclick = () => { const v = Number($('spAll').value); if (!(v > 0)) return $('spAll').focus(); dlg.querySelectorAll('#spRows input').forEach(i => { if (!(Number(i.value) > 0)) i.value = v; }); };
  return new Promise(resolve => {
    let result = null;
    $('spForm').onsubmit = e => {
      e.preventDefault();
      const costs = {};
      dlg.querySelectorAll('#spRows input').forEach(i => { const v = Number(i.value); if (v > 0) costs[i.dataset.key] = v; });
      result = { costs, includeTopup: $('spTopup').checked, saveMenu: $('spSaveMenu').checked, setProc: showProc && $('spProc').checked };
      dlg.close();
    };
    $('spCancel').onclick = () => dlg.close();
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
  });
}

async function importShopee(p) {
  if (!p.lines.length) return notice('Laporan Shopee ini tidak berisi pesanan yang bisa diimpor.');
  const [products, cur] = await Promise.all([store.getProducts(), store.getSettings()]);
  const ans = await askShopeeImport(p, products, cur);
  if (!ans) return notice('Impor dibatalkan.');
  const sales = shopeeToSales(p, ans);
  let res;
  try {
    res = await store.withLock(async () => {
      const existing = await store.getSales();
      const { fresh, dup } = dropKnownShopee(existing, sales);
      const m = mergeSales(existing, fresh);
      await store.setSales(m.list);
      return { added: m.added, dup: dup + m.duplicates };
    });
    if (ans.setProc) await store.updateSettings(s => ({ ...s, procFee: { ...(s.procFee || {}), Shopee: p.procPerOrder } }));
    if (ans.saveMenu) {
      const rev = new Map(); p.lines.forEach(l => { const r = rev.get(l.key) || { p: 0, q: 0 }; r.p += l.price; r.q += l.qty; rev.set(l.key, r); });
      await store.updateProducts(list => {
        for (const g of p.groups) {
          const cost = ans.costs[g.key];
          if (!(cost > 0)) continue;
          const ada = list.find(x => noSpaceKey(x.name) === g.key);
          if (ada) { if (!(ada.cost > 0)) ada.cost = cost; continue; }
          const r = rev.get(g.key);
          list.push({ id: uid(), name: g.name, sku: '', category: '', cost, price: r && r.q ? Math.round(r.p / r.q) : 0, note: 'Dari laporan Shopee' });
        }
        return list;
      });
    }
  } catch (err) {
    return notice('Gagal menyimpan hasil impor: ' + err.message);
  }
  await load();
  const tanpaModal = p.groups.filter(g => !(ans.costs[g.key] > 0)).length;
  const extra = [];
  if (res.dup) extra.push(`${num(res.dup)} baris dilewati karena pesanan itu sudah tercatat`);
  if (p.skipped) extra.push(`${num(p.skipped)} baris dilewati (tanggal/harga tidak valid)`);
  if (tanpaModal) extra.push(`${num(tanpaModal)} produk belum diisi modalnya (Rp 0)`);
  notice(`Laporan Shopee: ${num(res.added)} baris produk diimpor${extra.length ? ', ' + extra.join(', ') : ''}.`);
}


// ---------- pratinjau impor Excel ----------
function askImportPreview(fileName, fresh, dup, skipped) {
  const dlg = $('importDlg');
  const counted = fresh.filter(s => calc(s).counted);
  const revenue = counted.reduce((a, s) => a + calc(s).revenue, 0);
  const dates = fresh.map(s => s.date).sort();
  const mps = new Map(); fresh.forEach(s => mps.set(s.marketplace, (mps.get(s.marketplace) || 0) + 1));
  $('impTitle').textContent = 'Pratinjau impor';
  $('impSummary').innerHTML = `<b>${escapeHtml(fileName)}</b><br><b>${num(fresh.length)}</b> transaksi akan ditambahkan · ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])} · omzet pesanan selesai ${rupiah(revenue)}<br>`
    + [...mps.entries()].map(([n, c]) => `${escapeHtml(n)}: ${num(c)}`).join(' · ');
  const warns = [];
  if (dup) warns.push(`${num(dup)} baris sudah tercatat dan akan dilewati.`);
  if (skipped) warns.push(`${num(skipped)} baris tidak valid (tanggal atau harga kosong/salah) akan dilewati.`);
  const today = todayISO(), future = fresh.filter(s => s.date > addDaysISO(today, 31)).length;
  if (future) warns.push(`${num(future)} baris bertanggal lebih dari sebulan ke depan — periksa format tanggalnya.`);
  const noCogs = counted.filter(s => !(Number(s.cogs) > 0)).length;
  if (noCogs) warns.push(`${num(noCogs)} baris belum punya modal (Rp 0), sehingga profitnya terlihat terlalu besar.`);
  const loss = counted.filter(s => calc(s).profit < 0).length;
  if (loss) warns.push(`${num(loss)} baris rugi (profit negatif).`);
  $('impWarn').hidden = !warns.length;
  $('impWarn').innerHTML = warns.map(w => `<div>⚠ ${w}</div>`).join('');
  const PREV = 8;
  $('impRows').innerHTML = fresh.slice(0, PREV).map(s => { const c = calc(s); return `<tr><td>${fmtDate(s.date)}</td><td>${escapeHtml(s.marketplace)}</td><td class="prod">${escapeHtml(s.product)}</td><td class="r">${num(s.qty)}</td><td class="r">${c.counted ? rupiah(c.revenue) : '–'}</td><td>${escapeHtml(s.status)}</td></tr>`; }).join('');
  $('impMore').textContent = fresh.length > PREV ? `+ ${num(fresh.length - PREV)} transaksi lainnya.` : '';
  $('impOk').textContent = `Impor ${num(fresh.length)} transaksi`;
  return new Promise(resolve => {
    let ok = false;
    $('impForm').onsubmit = e => { e.preventDefault(); ok = true; dlg.close(); };
    $('impCancel').onclick = () => dlg.close();
    dlg.addEventListener('close', () => resolve(ok), { once: true });
    dlg.showModal();
  });
}
function addDaysISO(iso, n) { return toISODate(addDays(parseISO(iso), n)); }

// ---------- cadangan & pemulihan ----------
const HARI = 24 * 3600 * 1000, BATAS_CADANGAN = 7 * HARI, TUNDA_CADANGAN = 3 * HARI;
async function markBackedUp() {
  try { await chrome.storage.local.set({ lastBackup: Date.now(), backupSnooze: 0 }); } catch (e) { /* abaikan */ }
  renderBackupBar();
}
// Ingatkan bila ada data tetapi belum pernah dicadangkan / sudah lebih dari 7 hari. "Nanti" menunda 3 hari.
async function renderBackupBar() {
  const bar = $('backupBar');
  let m = {};
  try { m = await chrome.storage.local.get(['lastBackup', 'backupSnooze', 'autoBackup']); } catch (e) { /* abaikan */ }
  $('autoBackup').checked = !!m.autoBackup;
  $('lastBackupText').textContent = m.lastBackup ? `Cadangan terakhir: ${fmtDate(toISODate(new Date(Number(m.lastBackup))))}` : 'Belum pernah dicadangkan';
  const sales = await store.getSales();
  const now = Date.now();
  const last = Number(m.lastBackup) || 0;
  const umur = now - last;
  const perlu = !m.autoBackup && sales.length > 0 && (!last || umur > BATAS_CADANGAN) && now > (Number(m.backupSnooze) || 0);
  bar.hidden = !perlu;
  if (perlu) $('backupText').textContent = last
    ? `Terakhir dicadangkan ${Math.floor(umur / HARI)} hari lalu. Data hanya tersimpan di Chrome ini, jadi cadangkan agar aman.`
    : `Data Anda belum pernah dicadangkan. Data hanya tersimpan di Chrome ini; cadangkan agar tidak hilang bila ekstensi terhapus.`;
}

// Cadangan otomatis (bila diaktifkan): saat Dashboard dibuka dan cadangan terakhir > 7 hari, file JSON diunduh sendiri.
let autoBackupTried = false;
async function autoBackupIfDue() {
  if (autoBackupTried) return;
  try {
    const m = await chrome.storage.local.get(['lastBackup', 'autoBackup']);
    if (!m.autoBackup) return;
    if (Date.now() - (Number(m.lastBackup) || 0) <= BATAS_CADANGAN) return;
    autoBackupTried = true;
    const [sales, ads, products, st] = await Promise.all([store.getSales(), store.getAds(), store.getProducts(), store.getSettings()]);
    if (!sales.length && !ads.length && !products.length) return;
    download(`cadangan-laporan-${todayISO()}.json`, JSON.stringify(buildBackup({ sales, ads, products, settings: st }), null, 2), 'application/json');
    await markBackedUp();
    notice(`Cadangan otomatis diunduh: ${num(sales.length)} transaksi, ${num(ads.length)} iklan, ${num(products.length)} produk.`);
  } catch (e) { /* gagal diam-diam; pengingat biasa tetap berlaku */ }
}

async function backupAll() {
  const [sales, ads, products, settings] = await Promise.all([store.getSales(), store.getAds(), store.getProducts(), store.getSettings()]);
  if (!sales.length && !ads.length && !products.length) return notice('Belum ada data untuk dicadangkan.');
  download(`cadangan-laporan-${todayISO()}.json`, JSON.stringify(buildBackup({ sales, ads, products, settings }), null, 2), 'application/json');
  await markBackedUp();
  notice(`Cadangan diunduh: ${num(sales.length)} transaksi, ${num(ads.length)} iklan, ${num(products.length)} produk + pengaturan.`);
}

async function restoreFrom(file) {
  if (file.size > 50 * 1024 * 1024) return notice('File terlalu besar (maksimal 50 MB).');
  let bk;
  try { bk = parseBackup(await file.text()); } catch (err) { return notice(err.message); }
  if (!bk.sales.length && !bk.ads.length && !bk.products.length) return notice('File cadangan kosong atau tidak berisi data valid.');
  if (!confirm(`Pulihkan dari cadangan?\n\n${num(bk.sales.length)} transaksi, ${num(bk.ads.length)} iklan, ${num(bk.products.length)} produk.\nData yang sudah ada tidak dihapus; yang sama persis dilewati. Pengaturan biaya admin & pajak dari cadangan ikut menimpa.`)) return;
  try {
    // Baca-gabung-tulis dalam satu kunci tulis, supaya tidak bentrok dengan popup/tab lain.
    const m = await store.withLock(async () => {
      const [sales, ads, products, st] = await Promise.all([store.getSales(), store.getAds(), store.getProducts(), store.getSettings()]);
      const merged = mergeBackup({ sales, ads, products, settings: st }, bk);
      await chrome.storage.local.set({ sales: merged.sales, ads: merged.ads, products: merged.products, settings: merged.settings });
      return merged;
    });
    await load();
    const c = m.counts;
    notice(`Dipulihkan: ${c.sales} transaksi baru${c.salesDup ? ` (${c.salesDup} duplikat dilewati)` : ''}, ${c.ads} iklan, ${c.products} produk baru${c.productsUpdated ? `, ${c.productsUpdated} diperbarui` : ''}${bk.skipped ? `. ${bk.skipped} entri rusak dilewati` : ''}.`);
  } catch (err) {
    notice('Gagal memulihkan: ' + err.message);
  }
}

function init() {
  $('period').addEventListener('change', () => {
    const custom = $('period').value === 'custom';
    $('fromWrap').hidden = !custom; $('toWrap').hidden = !custom;
    render();
  });
  // Pencarian ditunda sebentar: tiap ketikan menghitung ulang seluruh dashboard, jadi data besar tidak tersendat.
  let qTimer;
  ['from', 'to', 'mp'].forEach(id => $(id).addEventListener('input', () => { pageNo = 1; render(); }));
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { pageNo = 1; render(); }, 150); });

  // Pop-up saran pesanan: muncul di bawah kolom cari saat mengetik. Klik (atau Enter) pada saran membuka pesanannya.
  const qBox = $('qSuggest');
  let qActive = -1;
  const hlText = (text, q) => {
    const t = String(text || ''), i = t.toLowerCase().indexOf(q);
    return i < 0 ? escapeHtml(t) : escapeHtml(t.slice(0, i)) + '<mark>' + escapeHtml(t.slice(i, i + q.length)) + '</mark>' + escapeHtml(t.slice(i + q.length));
  };
  const hideSuggest = () => { qBox.hidden = true; qActive = -1; $('q').setAttribute('aria-expanded', 'false'); };
  function renderSuggest() {
    const q = $('q').value.trim().toLowerCase();
    if (!q) return hideSuggest();
    const mp = $('mp').value;
    const hits = allSales.filter(s => (!mp || s.marketplace === mp) && matchSale(s, q)).sort((a, b) => b.date.localeCompare(a.date));
    qActive = -1;
    if (!hits.length) {
      qBox.innerHTML = '<li class="qs-empty">Tidak ada pesanan yang cocok.</li>';
    } else {
      const MAX = 8;
      qBox.innerHTML = '<li class="qs-head" aria-hidden="true">' + num(hits.length) + ' pesanan cocok' + (hits.length > MAX ? ' · menampilkan ' + MAX + ' terbaru' : '') + '</li>' +
        hits.slice(0, MAX).map(s => {
          const omzet = Number(s.omzetMp) > 0 ? Number(s.omzetMp) : (Number(s.qty) || 0) * (Number(s.price) || 0);
          const st = s.status && s.status !== 'selesai' ? ` <em class="qs-st">${escapeHtml(s.status)}</em>` : '';
          return `<li role="option" class="qs-item" data-id="${escapeHtml(s.id)}">
            <span class="qs-main">${hlText(s.product, q)}${st}</span><span class="qs-val">${rupiah(omzet)}</span>
            <small>${fmtDate(s.date)} · ${escapeHtml(s.marketplace || '-')}${s.orderNo ? ' · resi ' + hlText(s.orderNo, q) : ''} · ${num(Number(s.qty) || 0)} unit</small></li>`;
        }).join('');
    }
    qBox.hidden = false;
    $('q').setAttribute('aria-expanded', 'true');
  }
  function pickSuggest(li) {
    if (!li || !li.dataset.id) return;
    hideSuggest();
    $('q').blur();   // supaya fokus tidak kembali ke kolom cari (dan membuka saran lagi) saat dialog edit ditutup
    openEdit(li.dataset.id);
  }
  $('q').addEventListener('input', renderSuggest);
  $('q').addEventListener('focus', renderSuggest);
  $('q').addEventListener('keydown', e => {
    if (qBox.hidden) return;
    const items = [...qBox.querySelectorAll('.qs-item')];
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
  qBox.addEventListener('mousedown', e => e.preventDefault());   // jaga fokus di kolom cari agar klik tidak menutup daftar lebih dulu
  qBox.addEventListener('click', e => { e.preventDefault(); pickSuggest(e.target.closest ? e.target.closest('.qs-item') : null); });   // preventDefault: klik di dalam <label> tidak boleh melempar fokus balik ke kolom cari
  document.addEventListener('click', e => { if (!e.target.closest || !e.target.closest('.q-wrap')) hideSuggest(); });
  $('mp').addEventListener('input', () => { if (!qBox.hidden) renderSuggest(); });

  // Urutkan dengan klik judul kolom (klik lagi = balik arah); pindah halaman lewat tombol di bawah tabel.
  document.querySelector('th[data-sort]').closest('thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = k; sortDir = (k === 'date' || k === 'qty' || k === 'revenue' || k === 'fee' || k === 'profit') ? 'desc' : 'asc'; }
    pageNo = 1; render();
  });
  $('pager').addEventListener('click', e => {
    const b = e.target.closest('button[data-pg]');
    if (!b || b.disabled) return;
    const g = b.dataset.pg;
    pageNo = g === 'first' ? 1 : g === 'prev' ? pageNo - 1 : g === 'next' ? pageNo + 1 : 1e9;
    render();
    $('rows').closest('.table-wrap').scrollTop = 0;
  });
  $('pager').addEventListener('change', e => {
    if (e.target.id === 'pgSize') { pageSize = Number(e.target.value) || 100; pageNo = 1; render(); }
  });
  // Saat cetak, tampilkan semua baris (bukan hanya halaman yang sedang dibuka).
  window.addEventListener('beforeprint', () => { printing = true; renderNow(); });
  window.addEventListener('afterprint', () => { printing = false; renderNow(); });

  // Pintasan keyboard: "/" cari · "T" ganti tema · Ctrl+E ekspor Excel. Tidak aktif saat mengetik atau dialog terbuka.
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (e.target && e.target.isContentEditable) || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && selected.size) { selected.clear(); render(); return; }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $('q').focus(); $('q').select(); }
    else if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) { const b = $('themeToggle'); if (b) b.click(); }
    else if ((e.key === 'e' || e.key === 'E') && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); $('btnExport').click(); }
  });

  $('rows').addEventListener('click', async e => {
    const btn = e.target.closest ? e.target.closest('button') : null;
    const editId = btn && btn.dataset.edit;
    if (editId) return openEdit(editId);
    const id = btn && btn.dataset.del;
    if (!id) return;
    const dihapus = allSales.find(x => x.id === id);
    try {
      allSales = await store.removeSale(id);
    } catch (err) {
      return notice('Gagal menghapus: ' + err.message);
    }
    render();
    if (dihapus) notice(`Transaksi "${dihapus.product}" dihapus.`, {
      label: 'Batalkan',
      run: async () => { await store.addSale(dihapus); allSales = await store.getSales(); render(); notice('Penghapusan dibatalkan ✓'); }
    });
  });

  $('btnExport').addEventListener('click', async () => {
    // Baca ulang semua data dari penyimpanan dulu, supaya isi Excel selalu sama dengan data terbaru (popup/tab lain).
    try { await load(); } catch (err) { return notice('Gagal memuat data terbaru: ' + err.message); }
    const list = filtered();
    const adList = filteredAds();
    if (!list.length && !adList.length) return notice('Tidak ada data untuk diekspor pada filter ini.');
    const info = {
      range: $('rangeLabel').textContent,
      marketplace: $('mp').value || 'Semua',
      query: $('q').value.trim(),
      at: new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
    };
    download(`laporan-penjualan-${todayISO()}.xlsx`, xlsx.build(reportWorkbook(list, adList, settings, info)), xlsx.MIME);
    notice('Excel diunduh: Ringkasan, Penjualan, Per Marketplace, Per Produk, Per Tanggal, Per Bulan, Iklan — lengkap dengan grafik.');
  });

  $('btnTemplate').addEventListener('click', () => {
    download('template-penjualan.xlsx', xlsx.build(templateSheets()), xlsx.MIME);
  });

  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return notice('File terlalu besar (maksimal 20 MB).');
    let rows;
    notice('Membaca file…');
    try {
      if (/\.xlsx$/i.test(file.name)) rows = await xlsx.read(await file.arrayBuffer(), /^(penjualan|penghasilan)$/i);
      else if (/\.csv$/i.test(file.name)) rows = parseCSV(await file.text());
      else if (/\.xls$/i.test(file.name)) return notice('Format .xls lama belum didukung. Buka di Excel lalu simpan sebagai .xlsx.');
      else return notice('Format file tidak didukung. Pilih file Excel (.xlsx).');
    } catch (err) {
      return notice('Gagal membaca file: ' + err.message);
    }
    const shopee = parseShopeeIncome(rows);
    if (shopee) return importShopee(shopee);
    const { sales, skipped } = rowsToSales(rows);
    if (!sales.length) return notice('Tidak ada baris valid. Pastikan ada kolom Tanggal dan Harga Satuan (Rp) (lihat Template Excel).');
    // Pratinjau: hitung dulu apa yang akan masuk, tampilkan, baru simpan setelah dikonfirmasi.
    let existing;
    try { existing = await store.getSales(); } catch (err) { return notice('Gagal membaca data: ' + err.message); }
    const plan = mergeSales(existing, sales);
    if (!plan.added) return notice(`Tidak ada yang diimpor: ${num(plan.duplicates)} baris sudah tercatat${skipped ? `, ${num(skipped)} baris tidak valid` : ''}.`);
    notice('');
    if (!(await askImportPreview(file.name, plan.list.slice(existing.length), plan.duplicates, skipped))) return notice('Impor dibatalkan.');
    let res;
    try {
      res = await store.appendSales(sales);
    } catch (err) {
      return notice('Gagal menyimpan hasil impor: ' + err.message);
    }
    await load();
    const extra = [];
    if (res.duplicates) extra.push(`${res.duplicates} duplikat dilewati`);
    if (skipped) extra.push(`${skipped} baris dilewati (tanggal/harga tidak valid)`);
    notice(`${res.added} transaksi diimpor${extra.length ? ', ' + extra.join(', ') : ''}.`);
  });

  $('btnPrint').addEventListener('click', () => window.print());

  // Mode grafik + tooltip yang mengikuti kursor
  document.querySelectorAll('#chartMode button').forEach(b => b.addEventListener('click', () => {
    chartMode = b.dataset.mode;
    document.querySelectorAll('#chartMode button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  const chartEl = $('trend');
  chartEl.addEventListener('mousemove', e => {
    const hit = e.target.closest ? e.target.closest('rect.hit') : null;
    const tip = chartEl.querySelector('.tip');
    if (!tip) return;
    if (!hit || !lastTrend) { tip.hidden = true; return; }
    const d = lastTrend.data[Number(hit.dataset.i)];
    if (!d) { tip.hidden = true; return; }
    const full = lastTrend.byMonth ? label(d.key, true) : fmtDate(d.key);
    tip.innerHTML = `<b>${full}</b><span><i class="sw rev"></i>Omzet <strong>${rupiah(d.revenue)}</strong></span><span><i class="sw pro"></i>Profit <strong>${rupiah(d.profit)}</strong></span><small>sebelum iklan &amp; pajak</small>`;
    tip.hidden = false;
    const box = chartEl.getBoundingClientRect();
    let left = e.clientX - box.left + 14;
    if (left + tip.offsetWidth > box.width) left = e.clientX - box.left - tip.offsetWidth - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, e.clientY - box.top - tip.offsetHeight - 10) + 'px';
  });
  chartEl.addEventListener('mouseleave', () => { const t = chartEl.querySelector('.tip'); if (t) t.hidden = true; });

  // Chip periode cepat (mengatur pilihan Periode di atas)
  document.querySelectorAll('#chips button').forEach(b => b.addEventListener('click', () => {
    $('period').value = b.dataset.p;
    $('period').dispatchEvent(new Event('change'));
  }));

  // Grafik digambar sesuai lebar kontainer; gambar ulang bila jendela berubah ukuran.
  let rzTimer;
  window.addEventListener('resize', () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      const w = Number($('trend').dataset.w) || 0;
      if (w && Math.abs($('trend').clientWidth - w) > 4) render();
    }, 150);
  });

  // Pilih banyak baris: centang per baris / semua di halaman / semua hasil filter.
  $('rows').addEventListener('change', e => {
    const cb = e.target.closest ? e.target.closest('input[data-sel]') : null;
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
    cb.closest('tr').classList.toggle('selected', cb.checked);
    renderBulkBar(filteredIds.length, pageIds.map(id => ({ id })));
  });
  for (const sa of [$('selAll'), $('mSelAll')]) sa.addEventListener('change', e => {
    pageIds.forEach(id => { if (e.target.checked) selected.add(id); else selected.delete(id); });
    render();
  });
  $('bulkAllFiltered').addEventListener('click', () => { filteredIds.forEach(id => selected.add(id)); render(); });
  $('bulkClear').addEventListener('click', () => { selected.clear(); render(); });
  $('bulkDelete').addEventListener('click', bulkDelete);
  $('bulkStatusSel').addEventListener('change', e => { if (e.target.value) bulkSetStatus(e.target.value); });
  $('mSort').addEventListener('change', e => { const [k, d] = e.target.value.split(':'); sortKey = k; sortDir = d; pageNo = 1; render(); });
  document.querySelectorAll('#cmpMode button').forEach(b => b.addEventListener('click', () => {
    cmpMode = b.dataset.mode;
    document.querySelectorAll('#cmpMode button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('btnFixed').addEventListener('click', () => openFixedForm($('fixedForm').hidden));
  $('fxDone').addEventListener('click', () => openFixedForm(false));
  $('fixedForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('fxName').value.trim().slice(0, 60), amount = cleanRp($('fxAmount').value);
    if (!name) return $('fxName').focus();
    if (!(amount > 0)) return $('fxAmount').focus();
    await saveFixed(arr => (arr.length >= 100 ? arr : arr.concat({ id: uid(), name, amount })));
    $('fxName').value = ''; $('fxAmount').value = ''; $('fxName').focus();
  });
  $('fixedList').addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('button[data-fxdel]') : null;
    if (b) saveFixed(arr => arr.filter(x => x.id !== b.dataset.fxdel));
  });
  $('btnTarget').addEventListener('click', () => openTargetForm($('targetForm').hidden));
  $('tgtCancel').addEventListener('click', () => openTargetForm(false));
  $('targetForm').addEventListener('submit', async e => {
    e.preventDefault();
    const revenue = cleanRp($('tgtRevenue').value), profit = cleanRp($('tgtProfit').value);
    try { settings = await store.updateSettings(c => ({ ...c, targets: { revenue, profit } })); }
    catch (err) { return notice('Gagal menyimpan target: ' + err.message); }
    openTargetForm(false); renderTarget();
    notice(revenue || profit ? 'Target bulanan tersimpan ✓' : 'Target dihapus.');
  });
  $('autoBackup').addEventListener('change', async e => {
    try { await chrome.storage.local.set({ autoBackup: e.target.checked }); } catch (err) { /* abaikan */ }
    if (e.target.checked) autoBackupIfDue();
    renderBackupBar();
  });
  $('btnBackup').addEventListener('click', backupAll);
  $('backupNow').addEventListener('click', backupAll);
  $('backupLater').addEventListener('click', async () => { try { await chrome.storage.local.set({ backupSnooze: Date.now() + TUNDA_CADANGAN }); } catch (e) { /* abaikan */ } renderBackupBar(); });
  $('btnRestore').addEventListener('click', () => $('restoreInput').click());
  $('restoreInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await restoreFrom(file);
  });

  ['eQty', 'ePrice', 'eOmzet', 'eCogs', 'eFee', 'eOther', 'eStatus'].forEach(id => $(id).addEventListener('input', updateEditPreview));
  $('editForm').addEventListener('submit', saveEdit);
  $('eCancel').addEventListener('click', () => $('editDlg').close());

  $('btnClear').addEventListener('click', async () => {
    if (!allSales.length) return;
    if (!confirm(`Hapus SEMUA ${allSales.length} transaksi? Tindakan ini tidak bisa dibatalkan. Ekspor Excel dulu bila perlu.`)) return;
    try {
      await store.withLock(() => store.setSales([]));
    } catch (err) {
      notice('Gagal menghapus: ' + err.message);
    }
    await load();
  });

  // Sinkron bila data diubah dari popup saat dashboard terbuka.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.sales || changes.ads || changes.settings)) load();
  });

  // Dashboard dibiarkan terbuka sampai besok: "Hari ini", "7 hari terakhir", "Bulan ini", dst. ikut bergeser.
  onDayChange(() => render());

  load();
}

init();
