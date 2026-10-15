// DOCX is a ZIP of XML parts. This parser never executes Office content or runs OCR.
var CONTENT_TEXT_LIMITS_ = Object.freeze({
  fileBytes: 10 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  xmlBytes: 6 * 1024 * 1024,
  textCharacters: 750000,
  paragraphs: 12000,
  paragraphCharacters: 2400,
  zipEntries: 1500
});
var CONTENT_WORD_NS_ = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
var CONTENT_WORD_STRICT_NS_ = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
var CONTENT_DOCX_MIME_ = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function inspectContentDocxZip_(bytes) {
  // Inspect declared expansion BEFORE Utilities.unzip, including unused images.
  const u8 = i => bytes[i] & 255;
  const u16 = i => u8(i) + u8(i + 1) * 256;
  const u32 = i => u16(i) + u16(i + 2) * 65536;
  if (bytes.length < 22 || bytes.length > CONTENT_TEXT_LIMITS_.fileBytes || u32(0) !== 0x04034b50) {
    throw new Error('Word harus berupa DOCX yang valid, maksimal 10 MiB. Format DOC lama tidak didukung.');
  }
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {end = i; break;}
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) {
    throw new Error('Struktur ZIP DOCX tidak didukung atau rusak. Simpan ulang sebagai DOCX.');
  }
  const count = u16(end + 10), directorySize = u32(end + 12), offset = u32(end + 16);
  if (!count || count > CONTENT_TEXT_LIMITS_.zipEntries || offset + directorySize !== end) {
    throw new Error('Struktur DOCX terlalu besar atau menggunakan ZIP64 yang belum didukung.');
  }
  let position = offset, expanded = 0;
  const names = {};
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || u32(position) !== 0x02014b50) throw new Error('Direktori DOCX rusak.');
    const flags = u16(position + 8), method = u16(position + 10);
    const packed = u32(position + 20), size = u32(position + 24);
    const nameSize = u16(position + 28), extra = u16(position + 30), comment = u16(position + 32);
    const next = position + 46 + nameSize + extra + comment, local = u32(position + 42);
    if (next > end || flags & 1 || (method !== 0 && method !== 8) ||
        size === 0xffffffff || packed === 0xffffffff || local + 30 > offset || u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags || u16(local + 8) !== method) {
      throw new Error('DOCX terenkripsi atau struktur kompresinya tidak didukung.');
    }
    const name = bytes.slice(position + 46, position + 46 + nameSize).map(x => String.fromCharCode(x & 255)).join('');
    if (!name || names[name] || /(^\/|\\|(^|\/)\.\.(\/|$)|vbaProject\.bin$)/i.test(name)) {
      throw new Error('Nama bagian DOCX tidak valid atau mengandung makro.');
    }
    const localNameSize = u16(local + 26), localExtra = u16(local + 28);
    const localName = bytes.slice(local + 30, local + 30 + localNameSize).map(x => String.fromCharCode(x & 255)).join('');
    if (localName !== name || local + 30 + localNameSize + localExtra + packed > offset) {
      throw new Error('Bagian DOCX tidak konsisten.');
    }
    expanded += size;
    if (expanded > CONTENT_TEXT_LIMITS_.expandedBytes || (/\.xml$/i.test(name) && size > CONTENT_TEXT_LIMITS_.xmlBytes)) {
      throw new Error('Isi DOCX setelah dibuka terlalu besar untuk tahap pertama (32 MiB total / 6 MiB per XML).');
    }
    names[name] = {size: size};
    position = next;
  }
  if (position !== end || !names['word/document.xml'] || !names['[Content_Types].xml']) {
    throw new Error('File bukan dokumen Word DOCX yang lengkap.');
  }
  return names;
}

function extractContentDocx_(blob) {
  const directory = inspectContentDocxZip_(blob.getBytes());
  const parts = Utilities.unzip(blob.copyBlob().setContentType('application/zip'));
  const byName = {};
  parts.forEach(part => {
    const name = part.getName();
    if (!directory[name] || part.getBytes().length !== directory[name].size) throw new Error('Ukuran bagian DOCX tidak cocok.');
    byName[name] = part;
  });
  const paragraphs = [];
  let characters = 0;
  const add = (text, section, number) => {
    text = String(text).replace(/\u0000/g, '').trim();
    if (!text) return;
    characters += text.length;
    if (characters > CONTENT_TEXT_LIMITS_.textCharacters) throw new Error('Teks melebihi batas tahap pertama: 750.000 karakter. Tidak ada teks yang diindeks sebagian.');
    // Overlap preserves every query (max 120 characters) at a long paragraph boundary.
    const step = CONTENT_TEXT_LIMITS_.paragraphCharacters - 200;
    for (let start = 0; start < text.length; start += step) {
      paragraphs.push({text: text.substring(start, start + CONTENT_TEXT_LIMITS_.paragraphCharacters),
        section: section, paragraph: number, part: 1 + Math.floor(start / step)});
      if (paragraphs.length > CONTENT_TEXT_LIMITS_.paragraphs) throw new Error('Terlalu banyak paragraf untuk tahap pertama.');
      if (start + CONTENT_TEXT_LIMITS_.paragraphCharacters >= text.length) break;
    }
  };
  const names = ['word/document.xml'].concat(Object.keys(byName).filter(name =>
    /^word\/(footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(name)).sort());
  names.forEach(name => {
    if (!byName[name]) throw new Error('Bagian utama Word tidak ditemukan.');
    const xml = byName[name].getDataAsString('UTF-8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Deklarasi entitas XML tidak didukung.');
    let root;
    try {root = XmlService.parse(xml).getRootElement();}
    catch (error) {throw new Error('XML Word tidak dapat dibaca. Simpan ulang DOCX hasil OCR.');}
    const section = name === 'word/document.xml' ? 'Isi dokumen' :
      /footnotes/.test(name) ? 'Catatan kaki' : /endnotes/.test(name) ? 'Catatan akhir' :
        /header/.test(name) ? 'Header' : 'Footer';
    let number = 0;
    const walk = element => {
      const uri = element.getNamespace().getURI(), word = uri === CONTENT_WORD_NS_ || uri === CONTENT_WORD_STRICT_NS_;
      const tag = element.getName();
      if (word && ['del', 'moveFrom', 'instrText'].indexOf(tag) !== -1) return;
      if (word && tag === 'altChunk') throw new Error('Word memuat konten tertanam yang tidak dapat diekstrak. Simpan ulang sebagai DOCX biasa.');
      if (word && tag === 'p') {
        const text = contentDocxParagraphText_(element);
        if (text.trim()) add(text, section, ++number);
        return;
      }
      element.getChildren().forEach(walk);
    };
    walk(root);
  });
  if (!paragraphs.length) throw new Error('Word tidak memiliki teks terbaca. Jalankan OCR dahulu; gambar saja belum dapat dicari.');
  return {version: 1, characters: characters, paragraphs: paragraphs, pageMapping: 'UNAVAILABLE'};
}

function contentDocxParagraphText_(element) {
  const word = [CONTENT_WORD_NS_, CONTENT_WORD_STRICT_NS_].indexOf(element.getNamespace().getURI()) !== -1;
  const tag = element.getName();
  if (word && ['del', 'moveFrom', 'instrText'].indexOf(tag) !== -1) return '';
  if (word && tag === 't') return element.getText();
  if (word && tag === 'tab') return '\t';
  if (word && ['br', 'cr'].indexOf(tag) !== -1) return '\n';
  return element.getChildren().map(contentDocxParagraphText_).join('');
}
