/**
 * Central File v4 — Gerbang token Google Drive (Drive gateway).
 *
 * Fungsi: memberi Cloudflare Pages Function sebuah access token Drive milik
 * akun instansi, HANYA untuk permintaan yang ditandatangani HMAC dengan secret
 * bersama. Token tidak pernah dikirim ke browser pengguna.
 *
 * Cara pasang singkat (lengkap: PASANG.md):
 *   1. Login sebagai akun instansi, buat proyek baru di script.google.com.
 *   2. Tempel Code.gs dan appsscript.json (tampilkan manifest lewat Project Settings).
 *   3. Jalankan setupGateway() sekali, izinkan akses, salin secret dari log.
 *   4. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *   5. Isi DRIVE_GATEWAY_URL dan DRIVE_GATEWAY_SECRET di Cloudflare Pages.
 *   Ganti secret: jalankan setupGateway() lagi, lalu perbarui secret di Cloudflare.
 *
 * Permintaan: POST JSON {action, ts, nonce, sig}
 *   ts    = detik Unix; ditolak bila selisih dengan jam server > 120 detik
 *   nonce = 16–64 karakter [A-Za-z0-9_-], sekali pakai (disimpan 10 menit)
 *   sig   = hex(HMAC-SHA256(secret, "CFGW1\n" + action + "\n" + ts + "\n" + nonce))
 * Jawaban selalu HTTP 200 (batasan Apps Script); periksa field "ok".
 */

var GATEWAY_VERSION = 'CFGW1';
var GATEWAY_SECRET_PROPERTY = 'GATEWAY_SECRET';
var GATEWAY_MAX_SKEW_SECONDS = 120;
var GATEWAY_NONCE_TTL_SECONDS = 600;
var GATEWAY_TOKEN_TTL_HINT_SECONDS = 1800; // token OAuth berlaku ±60 menit; pakai separuhnya
var GATEWAY_ACTIONS = { MINT_DRIVE_TOKEN: true };

// ---------------------------------------------------------------------------
// Logika murni (diuji di Node: v4/gateway-apps-script/gateway.test.cjs)
// ---------------------------------------------------------------------------

function gatewayCanonical_(action, ts, nonce) {
  return GATEWAY_VERSION + '\n' + action + '\n' + ts + '\n' + nonce;
}

function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function gatewayHmacHex_(secret, message) {
  var sig = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(message).getBytes(), Utilities.newBlob(secret).getBytes());
  return bytesToHex_(sig);
}

/** Perbandingan waktu-konstan untuk dua string hex. */
function constantTimeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0;
}

/**
 * Memeriksa permintaan. Mengembalikan {ok:true, action, nonce} atau
 * {ok:false, reason} (reason hanya untuk log, tidak dikirim ke pemanggil).
 */
function verifyGatewayRequest_(body, secret, nowMs) {
  if (!secret || String(secret).length < 32) return { ok: false, reason: 'secret not configured' };
  if (!body || typeof body !== 'object') return { ok: false, reason: 'malformed' };
  var action = body.action;
  var ts = body.ts;
  var nonce = body.nonce;
  var sig = body.sig;
  if (typeof action !== 'string' || !GATEWAY_ACTIONS.hasOwnProperty(action)) return { ok: false, reason: 'action' };
  if (typeof ts !== 'number' || !isFinite(ts) || Math.floor(ts) !== ts) return { ok: false, reason: 'ts' };
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, reason: 'nonce' };
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'sig format' };
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > GATEWAY_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  var expected = gatewayHmacHex_(String(secret), gatewayCanonical_(action, ts, nonce));
  if (!constantTimeEquals_(expected, sig)) return { ok: false, reason: 'signature' };
  return { ok: true, action: action, nonce: nonce };
}

// ---------------------------------------------------------------------------
// Web app
// ---------------------------------------------------------------------------

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function denied_() {
  return jsonOut_({ ok: false, error: 'DITOLAK' });
}

function doGet() {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (parseError) {
      return denied_();
    }
    var secret = PropertiesService.getScriptProperties().getProperty(GATEWAY_SECRET_PROPERTY);
    var check = verifyGatewayRequest_(body, secret, Date.now());
    if (!check.ok) {
      console.warn('gateway: ditolak (' + check.reason + ')');
      return denied_();
    }
    // Nonce sekali pakai: cegah pemutaran ulang dalam jendela waktu.
    var lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      var cache = CacheService.getScriptCache();
      var key = 'nonce:' + check.nonce;
      if (cache.get(key)) {
        console.warn('gateway: ditolak (replay)');
        return denied_();
      }
      cache.put(key, '1', GATEWAY_NONCE_TTL_SECONDS);
    } finally {
      lock.releaseLock();
    }
    if (check.action === 'MINT_DRIVE_TOKEN') {
      return jsonOut_({ ok: true, accessToken: ScriptApp.getOAuthToken(), expiresInHint: GATEWAY_TOKEN_TTL_HINT_SECONDS });
    }
    return denied_();
  } catch (error) {
    console.error('gateway: galat ' + (error && error.message));
    return jsonOut_({ ok: false, error: 'GAGAL' });
  }
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

/**
 * Buat (atau ganti) secret bersama. Jalankan dari editor; secret tampil SEKALI
 * di log eksekusi. Salin ke Cloudflare Pages sebagai DRIVE_GATEWAY_SECRET.
 */
function setupGateway() {
  // 3 UUID acak (SecureRandom) = ±366 bit entropi, 96 karakter hex.
  var secret = '';
  for (var i = 0; i < 3; i++) secret += Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(GATEWAY_SECRET_PROPERTY, secret);
  driveScopeAnchor_();
  var message = 'Secret gerbang baru (salin ke Cloudflare Pages sebagai DRIVE_GATEWAY_SECRET, jangan dibagikan): ' + secret;
  Logger.log(message);
  console.log(message);
  return secret;
}

/**
 * Panggilan Drive dummy: memastikan izin Drive diminta saat otorisasi, dan
 * memeriksa bahwa akun ini memang bisa membaca Drive-nya.
 */
function driveScopeAnchor_() {
  return DriveApp.getRootFolder().getId();
}
