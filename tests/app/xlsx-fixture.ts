// 試験用に xlsx（ZIP）を組み立てる。展開する側の試験なので、CRC は 0 のまま（読む側は検査しない）。

export type ZipInput = Record<string, string | Uint8Array>;

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** files を ZIP にする。deflate: true なら圧縮（method 8）、false なら無圧縮（method 0） */
export async function makeZip(files: ZipInput, opts: { deflate?: boolean } = {}): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const method = opts.deflate === false ? 0 : 8;
    const data = method === 8 ? await deflateRaw(raw) : raw;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const NS_MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface FixtureSheet {
  name: string;
  /** sheetData の中身 */
  rows: string;
  state?: "hidden";
}

/** 最小の xlsx。sharedStrings は si の中身の配列、numFmts は [id, formatCode]、cellXfs は numFmtId の配列 */
export async function makeXlsx(opts: {
  sheets: FixtureSheet[];
  shared?: string[];
  numFmts?: Array<[number, string]>;
  cellXfs?: number[];
  date1904?: boolean;
  deflate?: boolean;
}): Promise<Uint8Array> {
  const files: ZipInput = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  };
  const sheetTags = opts.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`)
    .join("");
  files["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS_MAIN} ${NS_R}>${opts.date1904 ? '<workbookPr date1904="1"/>' : "<workbookPr/>"}<sheets>${sheetTags}</sheets></workbook>`;
  const n = opts.sheets.length;
  const rels = opts.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  rels.push(`<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
  rels.push(`<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="/xl/styles.xml"/>`);
  files["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  const shared = opts.shared ?? [];
  files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8"?><sst ${NS_MAIN} count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si>${s}</si>`).join("")}</sst>`;
  const numFmts = opts.numFmts ?? [];
  const xfs = opts.cellXfs ?? [0];
  files["xl/styles.xml"] =
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS_MAIN}>` +
    (numFmts.length > 0 ? `<numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join("")}</numFmts>` : "") +
    `<cellXfs count="${xfs.length}">${xfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`).join("")}</cellXfs></styleSheet>`;
  opts.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS_MAIN} ${NS_R}><sheetData>${s.rows}</sheetData></worksheet>`;
  });
  return makeZip(files, opts.deflate === undefined ? {} : { deflate: opts.deflate });
}
