// Minimal ZIP reader (stored + deflate, no ZIP64, no encryption), enough to read a zipped backup folder
// without any dependency. Entries are returned in memory; nothing is ever extracted to disk, so a crafted
// name ("../../x") cannot write outside anything.
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Bukan berkas ZIP yang valid (akhir berkas tidak ditemukan).');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64 tidak didukung.');
  const entries = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN) throw new Error('ZIP rusak (direktori pusat).');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('ZIP terenkripsi tidak didukung.');
    total += usize;
    if (total > MAX_TOTAL) throw new Error('Isi ZIP terlalu besar.');
    if (buf.readUInt32LE(lho) !== LOC) throw new Error('ZIP rusak (header lokal).');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1 });
    else throw new Error(`Metode kompresi ZIP ${method} tidak didukung.`);
    if (data.length !== usize) throw new Error(`ZIP rusak: ukuran ${name} tidak sesuai.`);
    entries.set(name, data);
  }
  return entries;
}
