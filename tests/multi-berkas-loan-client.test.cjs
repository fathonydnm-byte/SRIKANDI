// node --test tests/multi-berkas-loan-client.test.cjs
// Logika "Daftar Pinjam" di Client.html dan PDF Out Indicator multi-berkas,
// dijalankan pada DOM tiruan minimal.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => {
  const html = fs.readFileSync(path.join(__dirname, '../central-file', file), 'utf8');
  return html.match(/<script>([\s\S]*)<\/script>/)[1];
};

class FakeElement {
  constructor(id) {
    this.id = id; this.value = ''; this.hidden = false; this.textContent = '';
    this.disabled = false; this.files = []; this.options = []; this._html = '';
    this.classList = {add() {}, remove() {}, toggle() {}, contains: () => false};
    this.dataset = {};
  }
  get innerHTML() {return this._html;}
  set innerHTML(value) {this._html = String(value); if (this.id && /Id$|Type$/.test(this.id)) this.options = [];}
  add(option) {this.options.push(option);}
  addEventListener() {}
  focus() {}
  reset() {}
  scrollIntoView() {}
}

function clientFixture() {
  const elements = {};
  const ctx = vm.createContext({
    console,
    document: {
      getElementById: id => elements[id] || (elements[id] = new FakeElement(id)),
      addEventListener() {}, querySelectorAll: () => []
    },
    Option: function (text, value) {this.text = text; this.value = value; this.disabled = false;},
    setTimeout: () => 0, clearTimeout() {},
    FormData: function (form) {this.entries = () => Object.entries(form._fields || {});},
    File: function () {},
    google: {script: {run: {}}},
    window: {crypto: require('node:crypto').webcrypto, open() {}},
    crypto: require('node:crypto').webcrypto
  });
  vm.runInContext(source('Client.html'), ctx);
  ctx.state = vm.runInContext('state', ctx);
  const sent = [];
  ctx.runServer = (name, payload) => {sent.push([name, payload]); return Promise.resolve({ok: true, message: 'ok', loanGroupId: 'LOAN-X'});};
  ctx.toast = message => sent.push(['toast', message]);
  ctx.state.loanOptions = {
    today: '2026-11-11', summary: {}, loans: [], officerDefault: {},
    berkas: [
      {id: 'BRK-1', number: '1', title: 'Berkas Satu', label: '1 – Berkas Satu', pageCount: 7, itemCount: 2, location: 'Kabinet 1', loanStatus: 'TERSEDIA'},
      {id: 'BRK-2', number: '2', title: 'Berkas Dua', label: '2 – Berkas Dua', pageCount: 11, itemCount: 2, location: 'Kabinet 2', loanStatus: 'TERSEDIA'}
    ],
    itemsByBerkas: {
      'BRK-1': [{id: 'ITM-1A', number: '1', description: 'A', pageCount: 3, loanStatus: 'TERSEDIA'},
        {id: 'ITM-1B', number: '2', description: 'B', pageCount: 4, loanStatus: 'TERSEDIA'}],
      'BRK-2': [{id: 'ITM-2A', number: '1', description: 'C', pageCount: 5, loanStatus: 'TERSEDIA'},
        {id: 'ITM-2B', number: '2', description: 'D', pageCount: 6, loanStatus: 'TERSEDIA'}]
    }
  };
  const $ = id => ctx.document.getElementById(id);
  $('loanObjectType').value = 'BERKAS';
  return {ctx, $, sent};
}

test('Tambahkan ke Daftar collects berkas and items from different berkas', () => {
  const {ctx, $} = clientFixture();
  $('loanBerkasId').value = 'BRK-1';
  ctx.addLoanSelectionToCart_();
  assert.equal(ctx.state.loanCart.length, 1);
  assert.equal($('loanBerkasId').value, '', 'pemilih dikosongkan setelah ditambahkan');
  assert.equal($('loanCart').hidden, false);
  $('loanObjectType').value = 'ITEM';
  $('loanBerkasId').value = 'BRK-2';
  ctx.state.selectedLoanItemIds.add('ITM-2B');
  ctx.addLoanSelectionToCart_();
  $('loanBerkasId').value = 'BRK-2';
  ctx.state.selectedLoanItemIds.add('ITM-2A');
  ctx.addLoanSelectionToCart_();
  assert.equal(ctx.state.loanCart.length, 2, 'item dari berkas yang sama digabung');
  assert.deepEqual(Array.from(ctx.state.loanCart[1].itemIds), ['ITM-2B', 'ITM-2A']);
  assert.equal($('loanPageCount').value, 18);
  assert.match($('loanCartSummary').textContent, /2 berkas · 3 objek · 18 lembar/);
});

test('conflicting additions are refused with a clear message', () => {
  const {ctx, $, sent} = clientFixture();
  $('loanBerkasId').value = 'BRK-1';
  ctx.addLoanSelectionToCart_();
  $('loanObjectType').value = 'ITEM';
  $('loanBerkasId').value = 'BRK-1';
  ctx.state.selectedLoanItemIds.add('ITM-1A');
  ctx.addLoanSelectionToCart_();
  assert.equal(ctx.state.loanCart.length, 1);
  assert.match(sent.filter(entry => entry[0] === 'toast').pop()[1], /sudah ada di daftar pinjam sebagai berkas lengkap/);
});

test('the current, not yet added selection is still included when saving', () => {
  const {ctx, $} = clientFixture();
  $('loanBerkasId').value = 'BRK-1';
  ctx.addLoanSelectionToCart_();
  $('loanBerkasId').value = 'BRK-2';
  const effective = ctx.effectiveLoanSelections_();
  assert.equal(effective.error, '');
  assert.deepEqual(Array.from(effective.selections, row => row.berkasId), ['BRK-1', 'BRK-2']);
});

test('saving sends every selection plus legacy fields of the first one', async () => {
  const {ctx, $, sent} = clientFixture();
  ctx.prepareAndDownloadLoanOutIndicator_ = () => Promise.resolve();
  ctx.prepareAndDownloadLoanBeritaAcara_ = () => Promise.resolve();
  ctx.refreshLoanViewsInBackground_ = () => {};
  $('loanBerkasId').value = 'BRK-2';
  ctx.addLoanSelectionToCart_();
  $('loanObjectType').value = 'ITEM';
  $('loanBerkasId').value = 'BRK-1';
  ctx.state.selectedLoanItemIds.add('ITM-1B');
  $('loanDate').value = '2026-11-11';
  $('loanDueDate').value = '2026-11-18';
  $('loanForm')._fields = {loanPreviewId: 'LOAN-X', loanObjectType: 'ITEM', loanBerkasId: 'BRK-1', borrowerName: 'Budi'};
  await ctx.submitLoan_({preventDefault() {}});
  const [, payload] = sent.find(entry => entry[0] === 'apiCreateLoan');
  assert.deepEqual(JSON.parse(payload.loanSelectionsJson), [
    {objectType: 'BERKAS', berkasId: 'BRK-2', itemIds: []},
    {objectType: 'ITEM', berkasId: 'BRK-1', itemIds: ['ITM-1B']}
  ]);
  assert.equal(payload.loanObjectType, 'BERKAS');
  assert.equal(payload.loanBerkasId, 'BRK-2');
  assert.equal(ctx.state.loanCart.length, 0, 'daftar dikosongkan setelah tersimpan');
});

test('saving with nothing selected is refused', async () => {
  const {ctx, sent} = clientFixture();
  await ctx.submitLoan_({preventDefault() {}});
  assert.equal(sent.some(entry => entry[0] === 'apiCreateLoan'), false);
  assert.match(sent.filter(entry => entry[0] === 'toast').pop()[1], /Pilih minimal satu berkas/);
});

test('Out Indicator PDF prints one sheet per berkas', () => {
  const ctx = vm.createContext({btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'), TextEncoder});
  for (const file of ['LabelLogo.html', 'LabelPrint.html', 'OutIndicatorPrint.html']) {
    vm.runInContext(source(file), ctx);
  }
  const base = {loanGroupId: 'LOAN-X', borrowerName: 'Budi', statusCode: 'ACTIVE', statusLabel: 'DIPINJAM',
    berkasNumber: '1', originalLocation: 'Kabinet 1', items: [{number: 'SELURUH BERKAS', description: 'Satu', pageCount: 7}]};
  assert.equal(ctx.buildLoanOutIndicatorPdf_(base).pageCount, 1);
  const multi = ctx.buildLoanOutIndicatorPdf_(Object.assign({}, base, {sheets: [
    {berkasNumber: '1', originalLocation: 'Kabinet 1', items: base.items},
    {berkasNumber: '2', originalLocation: 'Kabinet 2', items: [{number: '1', description: 'C', pageCount: 5}]},
    {berkasNumber: '3', originalLocation: 'Kabinet 3', items: [{number: '1', description: 'E', pageCount: 7}]}
  ]}));
  assert.equal(multi.pageCount, 3);
  const text = Buffer.from(multi.bytes).toString('latin1');
  assert.match(text, /LEMBAR BERKAS 2 DARI 3/);
  assert.match(text, /Kabinet 3/);
});
