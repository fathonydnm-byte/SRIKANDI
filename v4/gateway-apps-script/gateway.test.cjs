// Node tests for Code.gs (pure signing/verification + doPost/doGet behaviour).
// Run: node --test v4/gateway-apps-script/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const SECRET = 'a'.repeat(32) + 'b'.repeat(32);

function load({ secret = SECRET, now } = {}) {
  const props = new Map(secret ? [['GATEWAY_SECRET', secret]] : []);
  const cache = new Map();
  const logs = [];
  const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const ctx = vm.createContext({
    Math, JSON, String, Number, isFinite,
    Date: now ? { now: () => now } : Date,
    console: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    Logger: { log: (m) => logs.push(m) },
    Utilities: {
      newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      computeHmacSha256Signature: (value, key) =>
        toSigned(crypto.createHmac('sha256', Buffer.from(key.map((b) => b & 0xff))).update(Buffer.from(value.map((b) => b & 0xff))).digest()),
      getUuid: () => crypto.randomUUID(),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json', TEXT: 'text' },
      createTextOutput: (s) => ({ body: s, setMimeType(m) { this.mime = m; return this; } }),
    },
    ScriptApp: { getOAuthToken: () => 'ya29.TOKEN' },
    DriveApp: { getRootFolder: () => ({ getId: () => 'root' }) },
  });
  vm.runInContext(SOURCE, ctx);
  return { ctx, props, cache, logs };
}

function sign(secret, action, ts, nonce) {
  return crypto.createHmac('sha256', secret).update(`CFGW1\n${action}\n${ts}\n${nonce}`).digest('hex');
}
function request(over = {}, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = { action: 'MINT_DRIVE_TOKEN', ts, nonce, ...over };
  body.sig = over.sig ?? sign(secret, body.action, body.ts, body.nonce);
  return body;
}
const post = (g, body) => JSON.parse(g.ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body);

test('HMAC matches Node crypto (cross-implementation)', () => {
  const g = load();
  assert.equal(g.ctx.gatewayHmacHex_(SECRET, 'CFGW1\nMINT_DRIVE_TOKEN\n1\nabc'), sign(SECRET, 'MINT_DRIVE_TOKEN', 1, 'abc'));
});

test('constant-time compare', () => {
  const { ctx } = load();
  assert.equal(ctx.constantTimeEquals_('abcd', 'abcd'), true);
  assert.equal(ctx.constantTimeEquals_('abcd', 'abce'), false);
  assert.equal(ctx.constantTimeEquals_('abcd', 'abc'), false);
  assert.equal(ctx.constantTimeEquals_('', 'a'), false);
  assert.equal(ctx.constantTimeEquals_('', ''), true);
});

test('valid request mints a token', () => {
  const g = load();
  assert.deepEqual(post(g, request()), { ok: true, accessToken: 'ya29.TOKEN', expiresInHint: 1800 });
});

test('rejections are generic: bad signature, wrong secret, stale/future ts, bad nonce, unknown action, junk', () => {
  const g = load();
  const ts = Math.floor(Date.now() / 1000);
  const bad = [
    request({ sig: '0'.repeat(64) }),
    request({}, 'x'.repeat(64)),
    request({ ts: ts - 121 }),
    request({ ts: ts + 121 }),
    request({ ts: String(ts) }),
    request({ nonce: 'short' }),
    request({ nonce: 'has spaces in it!!!!' }),
    request({ action: 'DELETE_EVERYTHING' }),
    request({ sig: 'ABC' }),
  ];
  for (const body of bad) assert.deepEqual(post(g, body), { ok: false, error: 'DITOLAK' }, JSON.stringify(body));
  assert.deepEqual(post(g, 'not json'), { ok: false, error: 'DITOLAK' });
  assert.deepEqual(post(g, 'null'), { ok: false, error: 'DITOLAK' });
  assert.ok(!JSON.stringify(g.logs).includes('ya29'));
});

test('signature within the allowed skew is accepted (±120 s)', () => {
  const g = load();
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(post(g, request({ ts: ts - 115 })).ok, true);
  assert.equal(post(g, request({ ts: ts + 115 })).ok, true);
});

test('replayed nonce is rejected', () => {
  const g = load();
  const body = request();
  assert.equal(post(g, body).ok, true);
  assert.deepEqual(post(g, body), { ok: false, error: 'DITOLAK' });
});

test('missing or short secret: everything is rejected', () => {
  assert.deepEqual(post(load({ secret: null }), request()), { ok: false, error: 'DITOLAK' });
  assert.deepEqual(post(load({ secret: 'pendek' }), request({}, 'pendek')), { ok: false, error: 'DITOLAK' });
});

test('doGet reveals nothing', () => {
  const g = load();
  assert.equal(g.ctx.doGet().body, '');
});

test('setupGateway stores a 96-hex secret, logs it once, and touches Drive', () => {
  const g = load({ secret: null });
  const s = g.ctx.setupGateway();
  assert.match(s, /^[0-9a-f]{96}$/);
  assert.equal(g.props.get('GATEWAY_SECRET'), s);
  assert.equal(g.logs.filter((l) => String(l).includes(s)).length, 2); // Logger + console
  assert.notEqual(g.ctx.setupGateway(), s); // rotation
  assert.match(SOURCE, /DriveApp\.getRootFolder\(\)/);
});

test('manifest: web app runs as deployer, anonymous access, drive scope only', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'appsscript.json'), 'utf8'));
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.deepEqual(m.oauthScopes, ['https://www.googleapis.com/auth/drive.readonly']);
});
