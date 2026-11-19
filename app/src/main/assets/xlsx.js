// Penulis & pembaca .xlsx minimal (tanpa library eksternal, patuh CSP ekstensi MV3).
// build(sheets) -> Blob .xlsx     read(arrayBuffer) -> baris-baris sheet (array of array)
const xlsx = (() => {
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');
  const p2 = n => String(n).padStart(2, '0');

  // Indeks gaya (lihat STYLES_XML): 0 normal, 1 header, 2 tanggal, 3 angka ribuan, 4 teks bungkus (dst., 21-34 = versi bergaris tepi & tambahan)
  const STYLE = { header: 1, date: 2, money: 3, wrap: 4, bold: 5, moneyR: 6, pct: 7, title: 8, totLabel: 9, totMoney: 10, totPct: 11, note: 12, boldMoney: 13, hdrResult: 14, hdrDeduct: 15, hasil: 16, pctNum: 17, totHasil: 18, center: 19, headerL: 20, noteWrap: 32, mult: 33 };

  // ---------- ZIP (tanpa kompresi) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: MIME });
  }

  // ---------- Penulis ----------
  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isoToSerial(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569 : null;
  }

  // Gaya dengan garis tepi tipis untuk sel data tabel (indeks asli -> indeks bergaris).
  const GRID_MAP = { 0: 21, 2: 22, 3: 23, 4: 24, 6: 25, 7: 26, 17: 27, 16: 28, 19: 29, 5: 30, 13: 31, 33: 34 };
  const gridStyle = s => { s = s || 0; return GRID_MAP[s] !== undefined ? GRID_MAP[s] : s; };

  // Sel: nilai biasa (teks/angka) atau { v, s } atau { d: 'YYYY-MM-DD', s }. grid = true -> beri garis tepi.
  function cellXml(ref, c, grid) {
    const blank = () => (grid ? `<c r="${ref}" s="${gridStyle(0)}"/>` : '');
    if (c === null || c === undefined || c === '') return blank();
    if (typeof c !== 'object') c = { v: c };
    const sid = (grid ? gridStyle(c.s) : c.s) || 0;
    const style = sid ? ` s="${sid}"` : '';
    if (c.d) {
      const serial = isoToSerial(c.d);
      if (serial !== null) return `<c r="${ref}" s="${grid ? gridStyle(c.s || STYLE.date) : (c.s || STYLE.date)}"><v>${serial}</v></c>`;
      c = { v: c.d };
    }
    if (c.f) {
      const cached = typeof c.v === 'number' && isFinite(c.v) ? `<v>${c.v}</v>` : '';
      return `<c r="${ref}"${style}><f>${esc(c.f)}</f>${cached}</c>`;
    }
    if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}"${style}><v>${c.v}</v></c>`;
    if (c.v === undefined || c.v === null || (typeof c.v === 'number')) return blank();
    if (c.v === '') return sid ? `<c r="${ref}"${style}/>` : '';
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
  }

  // Opsi sheet (semua opsional):
  //   freeze, freezeCols, filter, filterRows, widths, headerHeight, rowHeights {baris1: tinggi}, merges ['A1:C1'],
  //   gridRows [dari, sampai] (baris 1-based yang diberi garis tepi), tab (warna RGB), landscape, hideGrid,
  //   cf [{ sqref, op: 'lessThan'|'greaterThan', val, dxf: 0 merah | 1 hijau | 2 abu-abu miring } atau { sqref, expr, dxf }], validations [{ sqref, list }],
  //   printTitle (baris judul tabel diulang di tiap halaman cetak), charts [...] (lihat chartXml)
  function sheetXml(sh, selected, hasDrawing) {
    const rows = sh.rows || [];
    const ncols = rows.reduce((m, r) => Math.max(m, r.length), 1);
    const widthsN = (sh.widths || []).length;
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`;
    x += `<sheetPr>${sh.tab ? `<tabColor rgb="${sh.tab}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>`;
    x += `<sheetViews><sheetView workbookViewId="0"${sh.hideGrid ? ' showGridLines="0"' : ''}${selected ? ' tabSelected="1"' : ''}>`;
    if (sh.freeze) {
      const xs = sh.freezeCols | 0; // jumlah kolom paling kiri yang ikut dibekukan
      x += xs
        ? `<pane xSplit="${xs}" ySplit="1" topLeftCell="${colName(xs)}2" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight"/>`
        : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>';
    }
    x += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
    if (sh.widths && sh.widths.length) {
      x += '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    }
    const [g0, g1] = sh.gridRows || [0, 0];
    const heights = Object.assign({}, sh.headerHeight ? { 1: sh.headerHeight } : {}, sh.rowHeights || {});
    x += '<sheetData>';
    rows.forEach((r, ri) => {
      const rn = ri + 1;
      const inGrid = g0 && rn >= g0 && rn <= g1;
      const len = inGrid ? Math.max(r.length, widthsN) : r.length;
      let cells = '';
      for (let ci = 0; ci < len; ci++) cells += cellXml(colName(ci) + rn, r[ci], inGrid);
      const ht = heights[rn] ? ` ht="${heights[rn]}" customHeight="1"` : '';
      x += `<row r="${rn}"${ht}>${cells}</row>`;
    });
    x += '</sheetData>';
    if (sh.filter && rows.length > 1) x += `<autoFilter ref="A1:${colName(ncols - 1)}${sh.filterRows || rows.length}"/>`;
    if (sh.merges && sh.merges.length) x += `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
    // Baris belang-belang (selang-seling) supaya mudah dibaca ke samping; prioritas terakhir, jadi warna merah/abu-abu tetap menang.
    const cfAll = (sh.cf || []).slice();
    if (sh.gridRows && sh.gridRows[0] && sh.zebra !== false) cfAll.push({ sqref: `A${sh.gridRows[0]}:${colName(Math.max(ncols, widthsN) - 1)}${sh.gridRows[1]}`, expr: 'MOD(ROW(),2)=0', dxf: 3 });
    cfAll.forEach((c, i) => {
      x += c.expr
        ? `<conditionalFormatting sqref="${c.sqref}"><cfRule type="expression" dxfId="${c.dxf | 0}" priority="${i + 1}"><formula>${esc(c.expr)}</formula></cfRule></conditionalFormatting>`
        : `<conditionalFormatting sqref="${c.sqref}"><cfRule type="cellIs" dxfId="${c.dxf | 0}" priority="${i + 1}" operator="${c.op}"><formula>${c.val}</formula></cfRule></conditionalFormatting>`;
    });
    if (sh.validations && sh.validations.length) {
      x += `<dataValidations count="${sh.validations.length}">` + sh.validations.map(v =>
        `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Nilai tidak valid" error="Pilih salah satu dari daftar." sqref="${v.sqref}"><formula1>"${esc(v.list)}"</formula1></dataValidation>`).join('') + '</dataValidations>';
    }
    x += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>';
    x += `<pageSetup paperSize="9" orientation="${sh.landscape === false ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="0"/>`;
    x += '<headerFooter><oddFooter>&amp;L&amp;A&amp;RHalaman &amp;P dari &amp;N</oddFooter></headerFooter>';
    if (hasDrawing) x += '<drawing r:id="rId1"/>';
    return x + '</worksheet>';
  }

  // ---------- Grafik (kolom / garis) ----------
  // chart: { type: 'bar' | 'line', title, cat: 'A2:A5', series: [{ name: 'Omzet', ref: 'D2:D5', color: 'FF0F766E' }],
  //          from: [kolom, baris] (0-based), to: [kolom, baris] }
  function rangeVals(sh, ref) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    const out = [];
    if (!m) return out;
    const col = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    for (let r = +m[2]; r <= +m[4]; r++) {
      const cell = (sh.rows[r - 1] || [])[col];
      out.push(cell && typeof cell === 'object' ? (cell.d !== undefined ? cell.d : cell.v) : cell);
    }
    return out;
  }
  const absRef = (sheetName, ref) => `'${String(sheetName).replace(/'/g, "''")}'!` + ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');

  function chartXml(sh, sheetName, ch) {
    const rgb = c => c.replace(/^FF/, '');
    const cats = rangeVals(sh, ch.cat);
    // Kategori berupa tanggal Excel -> numRef berformat tanggal (kalau tidak, sumbu menampilkan nomor seri seperti 46266).
    const isDate = cats.length > 0 && cats.every(v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)));
    const catXml = isDate
      ? `<c:numRef><c:f>${esc(absRef(sheetName, ch.cat))}</c:f><c:numCache><c:formatCode>dd/mm/yyyy</c:formatCode><c:ptCount val="${cats.length}"/>${cats.map((v, i) => `<c:pt idx="${i}"><c:v>${isoToSerial(v)}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`
      : `<c:strRef><c:f>${esc(absRef(sheetName, ch.cat))}</c:f><c:strCache><c:ptCount val="${cats.length}"/>${cats.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v ?? '')}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
    const skip = cats.length > 14 ? Math.ceil(cats.length / 12) : 0;
    const txPr = (sz, bold, color) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="id-ID"/></a:p></c:txPr>`;
    const ser = ch.series.map((s, i) => {
      const vals = rangeVals(sh, s.ref);
      const numCache = `<c:numCache><c:formatCode>#,##0</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, k) => typeof v === 'number' ? `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>` : '').join('')}</c:numCache>`;
      const fill = ch.type === 'line'
        ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${rgb(s.color)}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
        : `<c:spPr><a:solidFill><a:srgbClr val="${rgb(s.color)}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`;
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${esc(absRef(sheetName, s.nameRef))}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>${fill}` +
        `<c:cat>${catXml}</c:cat>` +
        `<c:val><c:numRef><c:f>${esc(absRef(sheetName, s.ref))}</c:f>${numCache}</c:numRef></c:val>${ch.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
    }).join('');
    const plot = ch.type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="111111111"/><c:axId val="222222222"/></c:lineChart>`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="80"/><c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>`;
    const line = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + NS_REL + '">' +
      '<c:roundedCorners val="0"/><c:chart>' +
      `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="id-ID" sz="1200" b="1"><a:solidFill><a:srgbClr val="0F766E"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
      `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}` +
      `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="${isDate ? 'dd/mm/yyyy' : 'General'}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${line}${txPr(900, false, '404040')}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="0"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>${skip ? `<c:tickLblSkip val="${skip}"/><c:tickMarkSkip val="${skip}"/>` : ''}<c:noMultiLvlLbl val="0"/></c:catAx>` +
      `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E5E5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900, false, '404040')}<c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>` +
      '</c:plotArea>' +
      `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(900, false, '404040')}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
      '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:chartSpace>';
  }

  function drawingXml(charts) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="' + NS_REL + '">' +
      charts.map((c, i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${c.from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${c.to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Grafik ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('') +
      '</xdr:wsDr>';
  }

  // Indeks gaya (STYLE): 0-20 asli, 21-31 versi bergaris tepi, 32 catatan bungkus, 33 angka "x", 34 angka "x" bergaris tepi.
  const BORDER_XML = '<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>';
  const bx = (numFmt, font, fill, extra = '') => `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${extra ? ' applyAlignment="1">' + extra + '</xf>' : '/>'}`;

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}">
<numFmts count="5"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="#,##0;[Red]\\-#,##0"/><numFmt numFmtId="167" formatCode="0.0&quot;%&quot;"/><numFmt numFmtId="168" formatCode="0.0&quot;x&quot;"/></numFmts>
<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF0F766E"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font></fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F4F1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF166534"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFB45309"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F6EC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF0F766E"/></top><bottom/><diagonal/></border>${BORDER_XML}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="35">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="166" fontId="2" fillId="6" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="2" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
${bx(0, 0, 0)}
${bx(164, 0, 0, '<alignment horizontal="center" vertical="center"/>')}
${bx(3, 0, 0)}
${bx(0, 0, 0, '<alignment vertical="top" wrapText="1"/>')}
${bx(166, 0, 0)}
${bx(165, 0, 0)}
${bx(167, 0, 0)}
${bx(166, 2, 6)}
${bx(0, 0, 0, '<alignment horizontal="center" vertical="center"/>')}
${bx(0, 2, 0)}
${bx(166, 2, 0)}
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
${bx(168, 0, 0)}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="4"><dxf><font><color rgb="FFB91C1C"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor rgb="FFFEE2E2"/></patternFill></fill></dxf><dxf><font><color rgb="FF166534"/></font></dxf><dxf><font><i/><color rgb="FF9CA3AF"/></font></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFF4F7F8"/><bgColor rgb="FFF4F7F8"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

  function safeSheetName(name, i) {
    const n = String(name || '').replace(/[\\\/?*\[\]:]/g, ' ').trim().slice(0, 31);
    return n || 'Sheet' + (i + 1);
  }

  function build(sheets, meta) {
    meta = meta || {};
    const n = sheets.length;
    const files = [];
    const names = sheets.map((s, i) => safeSheetName(s.name, i));
    // Susun grafik & gambar per sheet.
    let chartNo = 0, drawNo = 0;
    const drawFiles = [], chartFiles = [], sheetRels = [], drawRels = [];
    const sheetDraw = sheets.map((s, i) => {
      const charts = (s.charts || []).filter(c => c.series && c.series.length);
      if (!charts.length) return false;
      drawNo++;
      const rels = [];
      charts.forEach(c => {
        chartNo++;
        chartFiles.push({ name: `xl/charts/chart${chartNo}.xml`, data: chartXml(s, names[i], c) });
        rels.push(`<Relationship Id="rId${rels.length + 1}" Type="${NS_REL}/chart" Target="../charts/chart${chartNo}.xml"/>`);
      });
      drawFiles.push({ name: `xl/drawings/drawing${drawNo}.xml`, data: drawingXml(charts) });
      drawRels.push({ name: `xl/drawings/_rels/drawing${drawNo}.xml.rels`, data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>' });
      sheetRels.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/drawing" Target="../drawings/drawing${drawNo}.xml"/></Relationships>` });
      return true;
    });

    files.push({
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        drawFiles.map((_, i) => `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('') +
        chartFiles.map((_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('') +
        '</Types>'
    });
    files.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        `<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`
    });
    const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files.push({
      name: 'docProps/core.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(meta.title || 'Laporan Penjualan Marketplace')}</dc:title><dc:creator>${esc(meta.author || 'Laporan Penjualan Marketplace')}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`
    });
    files.push({
      name: 'docProps/app.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Laporan Penjualan Marketplace</Application></Properties>'
    });
    // Judul tabel diulang di tiap halaman cetak.
    const defined = sheets.map((s, i) => s.printTitle ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(names[i].replace(/'/g, "''"))}'!$1:$1</definedName>` : '').join('');
    files.push({
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" tabRatio="800"/></bookViews><sheets>` +
        sheets.map((s, i) => `<sheet name="${esc(names[i])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' + (defined ? `<definedNames>${defined}</definedNames>` : '') + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
    });
    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`
    });
    files.push({ name: 'xl/styles.xml', data: STYLES_XML });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0, sheetDraw[i]) }));
    files.push(...sheetRels, ...drawFiles, ...drawRels, ...chartFiles);
    return zip(files);
  }

  // ---------- Pembaca ----------
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('browser ini belum bisa membuka file Excel terkompresi. Perbarui Chrome.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (u8.length < 22) throw new Error('ini bukan file Excel (.xlsx) yang valid.');
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) throw new Error('ini bukan file Excel (.xlsx) yang valid.');
    const total = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const entries = {};
    for (let i = 0; i < total; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      entries[dec.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + xlen + clen;
    }
    return {
      has: name => name in entries,
      async text(name) {
        const en = entries[name];
        if (!en) return null;
        const start = en.off + 30 + dv.getUint16(en.off + 26, true) + dv.getUint16(en.off + 28, true);
        const raw = u8.subarray(start, start + en.csize);
        if (en.method === 0) return dec.decode(raw);
        if (en.method === 8) return dec.decode(await inflateRaw(raw));
        throw new Error('metode kompresi file Excel tidak didukung.');
      }
    };
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('isi file Excel rusak.');
    return doc;
  }

  const els = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
  const childEls = (node, name) => Array.from(node.children).filter(x => x.localName === name);
  const textOf = si => els(si, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('');

  function isDateFmt(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
    if (!code) return false;
    return /[ymdhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  }

  function isPercentFmt(id, code) {
    if (id === 9 || id === 10) return true;
    return !!code && /%/.test(code.replace(/"[^"]*"|\\./g, ''));
  }

  // Per gaya sel: 'date' | 'percent' | '' (angka biasa).
  function readXfKinds(doc) {
    const custom = {};
    els(doc, 'numFmt').forEach(n => { custom[n.getAttribute('numFmtId')] = n.getAttribute('formatCode'); });
    const xfs = els(doc, 'cellXfs')[0];
    if (!xfs) return [];
    return childEls(xfs, 'xf').map(x => {
      const id = Number(x.getAttribute('numFmtId')), code = custom[x.getAttribute('numFmtId')];
      return isDateFmt(id, code) ? 'date' : isPercentFmt(id, code) ? 'percent' : '';
    });
  }

  function serialToISO(n, is1904) {
    const d = new Date(Math.floor(n - 25569 + (is1904 ? 1462 : 0)) * 86400000);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  }

  function colIndex(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // Angka non-tanggal dikembalikan sebagai number (bukan teks) supaya tidak salah tafsir "12.345".
  function readSheet(doc, shared, xfKinds, is1904) {
    const rows = [];
    for (const row of els(doc, 'row')) {
      const arr = [];
      for (const c of childEls(row, 'c')) {
        const m = /^([A-Z]+)/.exec(c.getAttribute('r') || '');
        const col = m ? colIndex(m[1]) : arr.length;
        const t = c.getAttribute('t');
        const v = els(c, 'v')[0];
        let val = '';
        if (t === 's') val = v ? (shared[Number(v.textContent)] ?? '') : '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'd') val = v ? v.textContent : '';
        else if (t === 'e') val = '';
        else if (v && v.textContent !== '') {
          const n = Number(v.textContent);
          if (isFinite(n)) {
            const kind = xfKinds[Number(c.getAttribute('s') || 0)];
            // Sel berformat persen menyimpan 8% sebagai 0.08; kembalikan ke 8 (pembulatan membuang noise floating point).
            val = kind === 'date' ? serialToISO(n, is1904) : kind === 'percent' ? Math.round(n * 1e8) / 1e6 : n;
          }
        }
        arr[col] = val;
      }
      rows.push(Array.from(arr, x => (x === undefined ? '' : x)));
    }
    return rows;
  }

  async function read(buf, preferred = /^penjualan$/i) {
    const z = unzip(buf);
    const wbText = await z.text('xl/workbook.xml');
    if (!wbText) throw new Error('ini bukan file Excel (.xlsx) yang valid.');
    const sheets = els(parseXml(wbText), 'sheet').map(s => ({ name: s.getAttribute('name'), rid: s.getAttributeNS(NS_REL, 'id') }));
    if (!sheets.length) throw new Error('file Excel tidak punya sheet.');
    const relsText = await z.text('xl/_rels/workbook.xml.rels');
    const rels = {};
    if (relsText) els(parseXml(relsText), 'Relationship').forEach(r => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });

    const pick = sheets.find(s => preferred.test(s.name || '')) || sheets[0];
    let target = rels[pick.rid] || 'worksheets/sheet1.xml';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const sheetText = await z.text(target);
    if (!sheetText) throw new Error('sheet tidak ditemukan di dalam file.');

    const ssText = await z.text('xl/sharedStrings.xml');
    const shared = ssText ? els(parseXml(ssText), 'si').map(textOf) : [];
    const stText = await z.text('xl/styles.xml');
    const xfKinds = stText ? readXfKinds(parseXml(stText)) : [];
    const is1904 = els(parseXml(wbText), 'workbookPr').some(w => /^(1|true)$/i.test(w.getAttribute('date1904') || ''));
    // Laporan marketplace sering berisi jutaan sel kosong yang hanya berformat (mis. 1.000 kolom x 2.600 baris = puluhan MB XML).
    // Sel kosong tidak berisi data, jadi dibuang dulu sebelum diurai agar cepat dan hemat memori.
    const slim = sheetText.replace(/<c\b[^>]*\/>/g, '');
    return readSheet(parseXml(slim), shared, xfKinds, is1904);
  }

  return { build, read, STYLE, MIME };
})();

if (typeof module !== 'undefined') module.exports = xlsx;
