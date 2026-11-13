/** Header unduhan yang aman. */

const INLINE_SAFE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/**
 * Content-Type yang dikirim. Selain daftar aman, file dipaksa diunduh sebagai
 * octet-stream supaya HTML/SVG dari Drive tidak pernah dirender di origin aplikasi.
 */
export function safeContentType(mime: string, disposition: 'inline' | 'attachment'): { contentType: string; disposition: 'inline' | 'attachment' } {
  const m = String(mime || '').toLowerCase().trim();
  if (!MIME_RE.test(m)) return { contentType: 'application/octet-stream', disposition: 'attachment' };
  if (INLINE_SAFE.has(m)) return { contentType: m, disposition };
  return { contentType: 'application/octet-stream', disposition: 'attachment' };
}

/** Nama file aman untuk header: tanpa kontrol/separator path, maks 150 karakter. */
export function cleanFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let n = String(name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');
  if (!n) n = 'berkas';
  if (n.length > 150) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    n = n.slice(0, 150 - ext.length) + ext;
  }
  return n;
}

/** RFC 6266 + RFC 5987: fallback ASCII dan filename* UTF-8. */
export function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
  const clean = cleanFileName(name);
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[%;]/g, '_').trim() || 'berkas';
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Satu rentang byte yang sah saja ("bytes=a-b", "bytes=a-", "bytes=-n"); selain itu diabaikan. */
export function sanitizeRange(range: string | null): string | null {
  if (!range) return null;
  const r = range.trim();
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(r);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] !== '' && m[2] !== '' && Number(m[2]) < Number(m[1])) return null;
  return r;
}

export const NO_STORE = 'private, no-store';
