const $ = id => document.getElementById(id);
const ROW_LIMIT = 300;
let sales = [], ads = [], settings = { fees: {} };
let taxDirty = false; // true bila angka pajak diketik tetapi belum disimpan; jangan ditimpa saat data lain berubah

function names() {
  const set = new Set(MARKETPLACES);
  sales.forEach(s => s.marketplace && set.add(s.marketplace));
  ads.forEach(a => a.marketplace && set.add(a.marketplace));
  return [...set];
}

function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function adTaxPct() { return cleanFee(settings.adTax); }

function render() {
  // KPI bulan ini
  const month = todayISO().slice(0, 7);
  const d = deductions(sales.filter(s => s.date.startsWith(month)), ads.filter(a => a.date.startsWith(month)), settings);
  $('kpis').innerHTML = `
    <div class="kpi"><span>Iklan bulan ini</span><strong>${rupiah(d.adSpend)}</strong><small>sebelum PPN</small></div>
    <div class="kpi"><span>PPN iklan</span><strong>${rupiah(d.adTax)}</strong><small>${adTaxPct()}% dari iklan</small></div>
    <div class="kpi"><span>Pajak penjualan</span><strong>${rupiah(d.tax)}</strong><small>dari omzet bulan ini</small></div>
    <div class="kpi"><span>Total iklan &amp; pajak</span><strong>${rupiah(d.adSpend + d.adTax + d.tax)}</strong><small>mengurangi profit bersih</small></div>`;

  // pengaturan pajak
  const taxes = settings.taxes || {};
  if (!taxDirty) $('taxRows').innerHTML = names().map(n => `<tr>
    <td>${escapeHtml(n)}</td>
    <td class="r"><input class="num-in" type="number" min="0" max="100" step="any" value="${escapeHtml(taxes[n] !== undefined ? taxes[n] : 0)}" data-mp="${escapeHtml(n)}" aria-label="Pajak ${escapeHtml(n)} (%)"></td>
  </tr>`).join('');
  if (!taxDirty && document.activeElement !== $('adTax')) $('adTax').value = settings.adTax !== undefined ? settings.adTax : 0;

  // form marketplace (pertahankan pilihan)
  const cur = $('aMp').value;
  $('aMp').innerHTML = names().map(n => `<option>${escapeHtml(n)}</option>`).join('');
  $('aMp').value = cur && names().includes(cur) ? cur : (settings.lastMarketplace && names().includes(settings.lastMarketplace) ? settings.lastMarketplace : MARKETPLACES[0]);

  // riwayat
  const sorted = ads.map((a, i) => ({ a, i })).sort((x, y) => y.a.date.localeCompare(x.a.date) || y.i - x.i).map(x => x.a);
  $('count').textContent = `(${sorted.length})`;
  $('empty').hidden = sorted.length > 0;
  const pct = adTaxPct();
  let html = sorted.slice(0, ROW_LIMIT).map(a => `<tr>
    <td data-label="Tanggal">${fmtDate(a.date)}</td>
    <td data-label="Marketplace">${escapeHtml(a.marketplace)}</td>
    <td class="prod" data-label="Catatan">${escapeHtml(a.note || '–')}</td>
    <td class="r" data-label="Biaya iklan">${rupiah(a.amount)}</td>
    <td class="r" data-label="PPN">${rupiah(Number(a.amount) * pct / 100)}</td>
    <td><button type="button" data-del="${escapeHtml(a.id)}">Hapus</button></td>
  </tr>`).join('');
  if (sorted.length > ROW_LIMIT) html += `<tr><td colspan="6" class="limit">Menampilkan ${ROW_LIMIT} terbaru dari ${sorted.length}.</td></tr>`;
  $('rows').innerHTML = html;
  updatePreview();
}

function updatePreview() {
  const amt = Number($('aAmount').value) || 0;
  const pct = adTaxPct();
  $('aPreview').textContent = `Total dengan PPN iklan (${pct}%): ${rupiah(amt * (1 + pct / 100))}`;
}

function msg(text, isError) {
  const el = $('aMsg');
  el.textContent = text;
  el.className = 'wide pmsg' + (isError ? ' error' : '');
  if (text && !isError) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
}

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

async function load() {
  [sales, ads, settings] = await Promise.all([store.getSales(), store.getAds(), store.getSettings()]);
  render();
}

function init() {
  $('aDate').value = todayISO();
  let aDateTouched = false;
  $('aDate').addEventListener('input', () => { aDateTouched = $('aDate').value !== todayISO(); });
  onDayChange((now, old) => {
    if (!aDateTouched || $('aDate').value === old) { $('aDate').value = now; aDateTouched = false; }
    render(); // KPI "bulan ini" ikut bulan berjalan
  });
  $('aAmount').addEventListener('input', updatePreview);
  $('tform').addEventListener('input', () => { taxDirty = true; });

  $('aform').addEventListener('submit', async e => {
    e.preventDefault();
    const ad = {
      id: uid(),
      date: $('aDate').value,
      marketplace: $('aMp').value,
      amount: Number($('aAmount').value),
      note: $('aNote').value.trim()
    };
    if (!ad.date || !(ad.amount > 0)) return msg('Isi tanggal dan biaya iklan (lebih dari 0).', true);
    try { await store.addAd(ad); } catch (err) { return msg('Gagal menyimpan: ' + err.message, true); }
    $('aAmount').value = '';
    $('aNote').value = '';
    await load();
    msg('Iklan tersimpan ✓');
    $('aAmount').focus();
  });

  $('tform').addEventListener('submit', async e => {
    e.preventDefault();
    const taxes = {};
    document.querySelectorAll('input[data-mp]').forEach(i => { taxes[i.dataset.mp] = cleanFee(i.value); });
    try {
      // Dibaca ulang di bawah kunci tulis agar tidak menimpa pengaturan lain.
      await store.updateSettings(cur => {
        cur.taxes = { ...(cur.taxes || {}), ...taxes };
        cur.adTax = cleanFee($('adTax').value);
      });
    } catch (err) { return notice('Gagal menyimpan: ' + err.message); }
    taxDirty = false;
    await load();
    notice('Pengaturan pajak tersimpan ✓');
  });

  $('rows').addEventListener('click', async e => {
    const btn = e.target.closest ? e.target.closest('button') : null;
    const id = btn && btn.dataset.del;
    if (!id) return;
    const dihapus = ads.find(x => x.id === id);
    try { ads = await store.removeAd(id); } catch (err) { return notice('Gagal menghapus: ' + err.message); }
    render();
    if (dihapus) notice(`Catatan iklan ${fmtDate(dihapus.date)} (${rupiah(dihapus.amount)}) dihapus.`, {
      label: 'Urungkan',
      run: async () => { await store.addAd(dihapus); ads = await store.getAds(); render(); notice('Penghapusan dibatalkan ✓'); }
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.sales || changes.ads || changes.settings)) load();
  });

  load();
}

init();
