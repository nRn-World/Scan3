// Pure TypeScript OOXML (.xlsx) Workbook Builder (Zero external dependencies)
// Produces 100% standard Excel workbooks offline in any browser!

export interface ClientExcelRow {
  customer: string;
  category: "Delivery" | "Removal";
  number: string;
  count: number;
}

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoreZip(files: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.content);
    const crc = crc32(dataBytes);
    return { nameBytes, dataBytes, crc, offset: 0 };
  });

  let localSize = 0;
  for (const e of entries) {
    e.offset = localSize;
    localSize += 30 + e.nameBytes.length + e.dataBytes.length;
  }

  let centralSize = 0;
  for (const e of entries) {
    centralSize += 46 + e.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let p = 0;

  // Local file headers + data (STORE method 0)
  for (const e of entries) {
    view.setUint32(p, 0x04034b50, true);
    view.setUint16(p + 4, 20, true); // version needed
    view.setUint16(p + 6, 0x0800, true); // UTF-8 flag
    view.setUint16(p + 8, 0, true); // method 0 = STORE
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, 0x21, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, e.dataBytes.length, true);
    view.setUint32(p + 22, e.dataBytes.length, true);
    view.setUint16(p + 26, e.nameBytes.length, true);
    view.setUint16(p + 28, 0, true);
    p += 30;
    out.set(e.nameBytes, p);
    p += e.nameBytes.length;
    out.set(e.dataBytes, p);
    p += e.dataBytes.length;
  }

  const centralOffset = p;
  for (const e of entries) {
    view.setUint32(p, 0x02014b50, true);
    view.setUint16(p + 4, 20, true);
    view.setUint16(p + 6, 20, true);
    view.setUint16(p + 8, 0x0800, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, 0, true);
    view.setUint16(p + 14, 0x21, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, e.dataBytes.length, true);
    view.setUint32(p + 24, e.dataBytes.length, true);
    view.setUint16(p + 28, e.nameBytes.length, true);
    view.setUint16(p + 30, 0, true);
    view.setUint16(p + 32, 0, true);
    view.setUint16(p + 34, 0, true);
    view.setUint16(p + 36, 0, true);
    view.setUint32(p + 38, 0, true);
    view.setUint32(p + 42, e.offset, true);
    p += 46;
    out.set(e.nameBytes, p);
    p += e.nameBytes.length;
  }

  // End of Central Directory
  view.setUint32(p, 0x06054b50, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, centralSize, true);
  view.setUint32(p + 16, centralOffset, true);
  view.setUint16(p + 20, 0, true);

  return out;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetter(colIdx1Based: number): string {
  let n = colIdx1Based;
  let res = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    res = String.fromCharCode(65 + rem) + res;
    n = Math.floor((n - 1) / 26);
  }
  return res;
}

export function buildInventoryXlsxClientBytes(
  items: ClientExcelRow[],
  columnMode: "standard_4col" | "combined_category" = "standard_4col"
): Uint8Array {
  const sorted = [...items].sort((a, b) => {
    const c = (a.customer || "Okänd kund").localeCompare(
      b.customer || "Okänd kund",
      "sv"
    );
    if (c !== 0) return c;
    if (a.category !== b.category) return a.category === "Delivery" ? -1 : 1;
    return a.number.localeCompare(b.number);
  });

  const headers =
    columnMode === "combined_category"
      ? ["Kategorisering", "Kund", "Typ", "Nummer", "Antal"]
      : ["Kund", "Kategori", "Nummer", "Antal"];
  const countCol = headers.length;
  const countLetter = colLetter(countCol);

  // Style indices:
  // 0 = default
  // 1 = Header (dark slate bg, white bold)
  // 2 = Bold text cell (Customer)
  // 3 = Delivery pill (green tint, dark green bold centered)
  // 4 = Removal pill (amber tint, dark amber bold centered)
  // 5 = Monospace Number text
  // 6 = Centered bold integer (Antal)
  // 7 = Total summary row
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="7">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF065F46"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF9A3412"/><name val="Calibri"/></font>
    <font><sz val="11"/><color rgb="FF1F2937"/><name val="Consolas"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFEDD5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="medium"><color rgb="FF64748B"/></top>
      <bottom style="double"><color rgb="FF475569"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="49" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="1" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="1" fontId="6" fillId="5" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;

  const sheetRowsXml: string[] = [];

  // Header row (r=1)
  const headerCells = headers
    .map(
      (h, idx) =>
        `<c r="${colLetter(idx + 1)}1" s="1" t="inlineStr"><is><t>${escXml(
          h
        )}</t></is></c>`
    )
    .join("");
  sheetRowsXml.push(`<row r="1" ht="25" customHeight="1">${headerCells}</row>`);

  // Data rows
  sorted.forEach((item, i) => {
    const r = i + 2;
    const cust = (item.customer || "Okänd kund").trim();
    const cat = item.category === "Removal" ? "Removal" : "Delivery";
    const catStyle = cat === "Delivery" ? 3 : 4;

    if (columnMode === "combined_category") {
      const comb = `Kund ${cust} ${cat}`;
      sheetRowsXml.push(
        `<row r="${r}" ht="22" customHeight="1">` +
          `<c r="A${r}" s="2" t="inlineStr"><is><t>${escXml(comb)}</t></is></c>` +
          `<c r="B${r}" s="2" t="inlineStr"><is><t>${escXml(cust)}</t></is></c>` +
          `<c r="C${r}" s="${catStyle}" t="inlineStr"><is><t>${cat}</t></is></c>` +
          `<c r="D${r}" s="5" t="inlineStr"><is><t>${escXml(item.number)}</t></is></c>` +
          `<c r="E${r}" s="6"><v>${Math.max(1, Math.round(item.count))}</v></c>` +
          `</row>`
      );
    } else {
      sheetRowsXml.push(
        `<row r="${r}" ht="22" customHeight="1">` +
          `<c r="A${r}" s="2" t="inlineStr"><is><t>${escXml(cust)}</t></is></c>` +
          `<c r="B${r}" s="${catStyle}" t="inlineStr"><is><t>${cat}</t></is></c>` +
          `<c r="C${r}" s="5" t="inlineStr"><is><t>${escXml(item.number)}</t></is></c>` +
          `<c r="D${r}" s="6"><v>${Math.max(1, Math.round(item.count))}</v></c>` +
          `</row>`
      );
    }
  });

  // Total row
  const lastDataRow = sorted.length + 1;
  const totalRow = lastDataRow + 1;
  const totalCells: string[] = [];
  for (let c = 1; c <= headers.length; c++) {
    const ref = `${colLetter(c)}${totalRow}`;
    if (c === 1) {
      totalCells.push(
        `<c r="${ref}" s="7" t="inlineStr"><is><t>${escXml(
          `Totalt (${sorted.length} unika nummer)`
        )}</t></is></c>`
      );
    } else if (c === countCol) {
      if (sorted.length > 0) {
        const sumVal = sorted.reduce((acc, x) => acc + x.count, 0);
        totalCells.push(
          `<c r="${ref}" s="7"><f>SUM(${countLetter}2:${countLetter}${lastDataRow})</f><v>${sumVal}</v></c>`
        );
      } else {
        totalCells.push(`<c r="${ref}" s="7"><v>0</v></c>`);
      }
    } else {
      totalCells.push(`<c r="${ref}" s="7"/>`);
    }
  }
  sheetRowsXml.push(
    `<row r="${totalRow}" ht="24" customHeight="1">${totalCells.join("")}</row>`
  );

  const colsXml =
    columnMode === "combined_category"
      ? `<cols>
          <col min="1" max="1" width="32" customWidth="1"/>
          <col min="2" max="2" width="24" customWidth="1"/>
          <col min="3" max="3" width="16" customWidth="1"/>
          <col min="4" max="4" width="22" customWidth="1"/>
          <col min="5" max="5" width="13" customWidth="1"/>
        </cols>`
      : `<cols>
          <col min="1" max="1" width="25" customWidth="1"/>
          <col min="2" max="2" width="16" customWidth="1"/>
          <col min="3" max="3" width="23" customWidth="1"/>
          <col min="4" max="4" width="13" customWidth="1"/>
        </cols>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0" showGridLines="1">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  ${colsXml}
  <sheetData>
    ${sheetRowsXml.join("\n    ")}
  </sheetData>
  <autoFilter ref="A1:${countLetter}${Math.max(1, lastDataRow)}"/>
</worksheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Inventering" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return buildStoreZip([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelsXml },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml },
    { name: "xl/styles.xml", content: stylesXml },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
  ]);
}
