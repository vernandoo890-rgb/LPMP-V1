const $ = id => document.getElementById(id);
let sales = [];
let settings = { fees: {}, affiliate: {}, procFee: {} };
const KUNCI_PERIODE = 'lm_fees_period'; // pilihan periode diingat di halaman ini
let dirty = false; // true bila ada angka yang diketik tetapi belum disimpan; jangan ditimpa saat data lain berubah

function marketplaceNames() {
  const names = new Set(MARKETPLACES);
  sales.forEach(s => s.marketplace && names.add(s.marketplace));
  return [...names];
}

// ---------- periode (sama seperti Dashboard) ----------
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
      return f > t ? { from: t, to: f } : { from: f, to: t };
    }
    default: return { from: '0000-01-01', to: '9999-12-31' };
  }
}
const inRange = (s, r) => s.date >= r.from && s.date <= r.to;
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
function rangeText(r) {
  const p = $('period').value;
  if (p === 'all') return 'semua waktu';
  if (r.from === r.to) return p === 'today' ? `hari ini (${fmtDate(r.from)})` : fmtDate(r.from);
  const a = r.from === '0000-01-01' ? 'awal' : fmtDate(r.from), b = r.to === '9999-12-31' ? 'sekarang' : fmtDate(r.to);
  return `${a} – ${b}`;
}
function savePeriod() {
  try { localStorage.setItem(KUNCI_PERIODE, JSON.stringify({ p: $('period').value, from: $('from').value, to: $('to').value })); } catch (e) { /* abaikan */ }
}
function restorePeriod() {
  try {
    const v = JSON.parse(localStorage.getItem(KUNCI_PERIODE) || 'null');
    if (v && [...$('period').options].some(o => o.value === v.p)) { $('period').value = v.p; $('from').value = v.from || ''; $('to').value = v.to || ''; }
  } catch (e) { /* abaikan */ }
}
function syncPeriodUi() {
  const custom = $('period').value === 'custom';
  $('fromWrap').hidden = !custom; $('toWrap').hidden = !custom;
  document.querySelectorAll('#chips button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === $('period').value)));
}

// Nilai tampil: ketikan yang belum disimpan (draft) didahulukan, lalu nilai tersimpan, lalu 0.
function pick(draftMap, savedMap, name) {
  if (draftMap && draftMap[name] !== undefined) return draftMap[name];
  return savedMap[name] !== undefined ? savedMap[name] : 0;
}

function render() {
  const draft = dirty ? readInputs() : null;
  const fees = settings.fees || {};
  const aff = settings.affiliate || {};
  const proc = settings.procFee || {};
  const tot = { revenue: 0, fee: 0, affiliate: 0, procFee: 0, any: false };
  syncPeriodUi();
  const range = getRange();
  const scope = sales.filter(s => inRange(s, range));
  const allTime = $('period').value === 'all';
  const orders = summarize(scope).orders;
  $('rangeInfo').textContent = `Periode: ${rangeText(range)} · ${scope.length} transaksi, ${orders} pesanan selesai`;

  const rows = marketplaceNames().map(name => {
    const own = scope.filter(s => s.marketplace === name);
    const t = summarize(own);
    const d = deductions(own, [], settings);
    if (t.orders) { tot.any = true; tot.revenue += t.revenue; tot.fee += t.fee; tot.affiliate += d.affiliate; tot.procFee += d.procFee; }
    const avg = t.revenue ? (t.fee / t.revenue * 100).toFixed(1).replace('.', ',') + '%' : '–';
    const n = escapeHtml(name);
    return `<tr>
      <td class="mp" data-label="Marketplace">${n}</td>
      <td class="r sep" data-label="Biaya admin (%)"><input class="num-in" type="number" min="0" max="100" step="any" value="${escapeHtml(pick(draft && draft.fees, fees, name))}" data-mp="${n}" aria-label="Biaya admin ${n} (%)"></td>
      <td class="r" data-label="Affiliate (% omzet)"><input class="num-in" type="number" min="0" max="100" step="any" value="${escapeHtml(pick(draft && draft.affiliate, aff, name))}" data-aff="${n}" aria-label="Affiliate ${n} (%)"></td>
      <td class="r" data-label="Biaya proses (Rp/pesanan)"><input class="num-in" type="number" min="0" step="any" value="${escapeHtml(pick(draft && draft.procFee, proc, name))}" data-proc="${n}" aria-label="Biaya proses pesanan ${n} (Rp per pesanan)"></td>
      <td class="r sep" data-label="Omzet tercatat">${t.orders ? rupiah(t.revenue) : '–'}</td>
      <td class="r" data-label="Biaya admin tercatat">${t.orders ? rupiah(t.fee) : '–'}</td>
      <td class="r" data-label="Affiliate tercatat">${t.orders ? rupiah(d.affiliate) : '–'}</td>
      <td class="r" data-label="Biaya proses tercatat">${t.orders ? rupiah(d.procFee) : '–'}</td>
      <td class="r" data-label="Rata-rata admin">${avg}</td>
      <td class="nowrap act apply-cell"><button type="button" class="apply" data-apply="${n}"${t.orders ? '' : ' disabled title="Belum ada transaksi di marketplace ini pada periode ini"'}>${allTime ? 'Terapkan ke transaksi lama' : 'Terapkan ke periode ini'}</button></td>
    </tr>`;
  });

  if (tot.any) {
    rows.push(`<tr class="tot">
      <td class="mp" data-label="Marketplace">Total</td>
      <td colspan="3" class="tot-gap"></td>
      <td class="r sep" data-label="Omzet tercatat"><strong>${rupiah(tot.revenue)}</strong></td>
      <td class="r" data-label="Biaya admin tercatat"><strong>${rupiah(tot.fee)}</strong></td>
      <td class="r" data-label="Affiliate tercatat"><strong>${rupiah(tot.affiliate)}</strong></td>
      <td class="r" data-label="Biaya proses tercatat"><strong>${rupiah(tot.procFee)}</strong></td>
      <td class="r" data-label="Rata-rata admin"><strong>${tot.revenue ? (tot.fee / tot.revenue * 100).toFixed(1).replace('.', ',') + '%' : '–'}</strong></td>
      <td class="tot-gap"></td>
    </tr>`);
  }
  $('rows').innerHTML = rows.join('');
}

function notice(text) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = !text;
  if (text) setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 5000);
}

function readInputs() {
  const fees = {}, affiliate = {}, procFee = {};
  document.querySelectorAll('input[data-mp]').forEach(i => { fees[i.dataset.mp] = cleanFee(i.value); });
  document.querySelectorAll('input[data-aff]').forEach(i => { affiliate[i.dataset.aff] = cleanFee(i.value); });
  document.querySelectorAll('input[data-proc]').forEach(i => { procFee[i.dataset.proc] = cleanRp(i.value); });
  return { fees, affiliate, procFee };
}

async function load() {
  [sales, settings] = await Promise.all([store.getSales(), store.getSettings()]);
  settings.fees = settings.fees || {};
  settings.affiliate = settings.affiliate || {};
  settings.procFee = settings.procFee || {};
  render();
}

async function saveFees(parts) {
  // Baca ulang pengaturan terbaru (di bawah kunci tulis) agar tidak menimpa perubahan dari popup.
  const cur = await store.updateSettings(c => {
    for (const k of ['fees', 'affiliate', 'procFee']) {
      if (parts[k]) c[k] = { ...(c[k] || {}), ...parts[k] };
    }
  });
  cur.fees = cur.fees || {}; cur.affiliate = cur.affiliate || {}; cur.procFee = cur.procFee || {};
  settings = cur;
}

function init() {
  restorePeriod();
  syncPeriodUi();
  $('period').addEventListener('change', () => { savePeriod(); render(); });
  ['from', 'to'].forEach(id => $(id).addEventListener('input', () => { savePeriod(); render(); }));
  document.querySelectorAll('#chips button').forEach(b => b.addEventListener('click', () => {
    $('period').value = b.dataset.p;
    $('period').dispatchEvent(new Event('change'));
  }));
  onDayChange(() => render()); // "hari ini" ikut berganti saat lewat tengah malam
  $('fform').addEventListener('input', e => { if (e.target.matches && e.target.matches('input.num-in')) dirty = true; });

  $('fform').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await saveFees(readInputs());
    } catch (err) {
      return notice('Gagal menyimpan: ' + err.message);
    }
    dirty = false;
    render();
    notice('Biaya admin, affiliate & biaya proses tersimpan ✓');
  });

  $('rows').addEventListener('click', async e => {
    const btn = e.target.closest ? e.target.closest('button[data-apply]') : null;
    const name = btn && btn.dataset.apply;
    if (!name) return;
    const input = [...document.querySelectorAll('input[data-mp]')].find(i => i.dataset.mp === name);
    const pct = cleanFee(input ? input.value : 0);
    const range = getRange();
    const inScope = s => s.marketplace === name && inRange(s, range);
    const n = sales.filter(inScope).length;
    const when = $('period').value === 'all' ? 'yang sudah tercatat' : `pada periode ${rangeText(range)}`;
    if (!confirm(`Ubah biaya admin ${name} menjadi ${pct}% untuk ${n} transaksi ${when}? Profit transaksi itu ikut berubah.`)) return;
    try {
      await saveFees({ fees: { [name]: pct } });
      // Baca ulang transaksi dari penyimpanan (di bawah kunci tulis) sebelum mengubah.
      sales = await store.withLock(async () => {
        const updated = (await store.getSales()).map(s => (inScope(s) ? { ...s, feePct: pct } : s));
        await store.setSales(updated);
        return updated;
      });
    } catch (err) {
      return notice('Gagal menerapkan: ' + err.message);
    }
    render();
    notice(`Biaya admin ${name} ${pct}% diterapkan ke ${n} transaksi` + ($('period').value === 'all' ? '.' : `, periode ${rangeText(range)}.`));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.sales || changes.settings)) return;
    // Jangan timpa angka yang sedang diketik: bila sebuah kolom sedang difokus, tunda muat ulang sampai fokus lepas.
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches('input.num-in')) {
      if (!ae._tundaMuat) { ae._tundaMuat = true; ae.addEventListener('blur', () => { ae._tundaMuat = false; load(); }, { once: true }); }
    } else load();
  });

  load();
}

init();
