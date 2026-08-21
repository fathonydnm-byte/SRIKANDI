function doGet() {
  if (!getInstanceSpreadsheetId_(true)) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:Arial,sans-serif;background:#f4f7f9;color:#17344c;padding:40px}' +
      'main{max-width:680px;margin:auto;background:white;border:1px solid #dbe4ea;border-radius:16px;padding:28px}' +
      'h1{color:#143b5d}</style></head><body><main>' +
      '<h1>Record Center belum dikonfigurasi</h1>' +
      '<p>Buka spreadsheet Record Center, lalu pilih menu <strong>Record Center → Instalasi &amp; Reliability</strong>.</p>' +
      '</main></body></html>'
    ).setTitle('Instalasi Record Center');
  }
  const user = getCurrentUser_();
  if (!isRecordCenterAdmin_(user)) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:Arial,sans-serif;background:#f4f7f9;color:#17344c;padding:40px}' +
      'main{max-width:680px;margin:auto;background:white;border:1px solid #dbe4ea;border-radius:16px;padding:28px}' +
      'h1{color:#8a1f2d}</style></head><body><main>' +
      '<h1>Akses ditolak</h1>' +
      '<p>Dashboard Record Center hanya untuk administrator instance. Akun saat ini: ' +
      cleanText_(user, 250) + '</p>' +
      '</main></body></html>'
    ).setTitle('Akses Ditolak — Record Center');
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Record Center — UINSA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Record Center')
    .addItem('0. Otorisasi Awal (jalankan sekali sebelum instalasi)', 'runInitialAuthorization')
    .addItem('Instalasi & Reliability…', 'showRcInstallerDialog')
    .addSeparator()
    .addItem('Pasang Instance (tanpa dialog, jika dialog gagal)', 'installRecordCenterInstanceViaPrompts')
    .addItem('Daftarkan Sumber CF (tanpa dialog, jika dialog gagal)', 'registerSourceViaPrompts')
    .addItem('Cek Status & Backup (tanpa dialog)', 'checkHealthAndBackupViaPrompt')
    .addItem('Lihat Sumber Terdaftar (tanpa dialog)', 'listSourcesViaPrompt')
    .addToUi();
}

function checkHealthAndBackupViaPrompt() {
  const ui = SpreadsheetApp.getUi();
  try {
    const health = runRcHealthCheck_(true);
    const lines = health.checks.map(check => check.code + ': ' + check.status + ' — ' + check.detail);
    const response = ui.alert(
      'Status Kesehatan RC-00: ' + health.overallStatus,
      lines.join('\n') + '\n\nJalankan Backup Sekarang juga?',
      ui.ButtonSet.YES_NO
    );
    if (response === ui.Button.YES) {
      const backup = startRcBackup_();
      ui.alert('Backup selesai',
        backup.fileCount + ' file, ' + backup.folderCount + ' folder tercatat pada manifest.\n' +
        backup.spreadsheetCopyUrl, ui.ButtonSet.OK);
    }
  } catch (error) {
    ui.alert('Gagal', error.message, ui.ButtonSet.OK);
  }
}

function listSourcesViaPrompt() {
  const ui = SpreadsheetApp.getUi();
  try {
    const sources = listSources_();
    if (!sources.length) {
      ui.alert('Sumber Terdaftar', 'Belum ada sumber Central File yang terdaftar.', ui.ButtonSet.OK);
      return;
    }
    const lines = sources.map(source =>
      source.unitName + ' (' + source.sourceId + ') — ' + source.status +
      (source.secretConfigured ? ', secret aktif' : ', secret BELUM diterbitkan'));
    ui.alert('Sumber Terdaftar (' + sources.length + ')', lines.join('\n'), ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Gagal', error.message, ui.ButtonSet.OK);
  }
}

// Jalur cadangan: sebagian lingkungan browser memblokir iframe otorisasi
// yang dipakai google.script.run di dalam dialog HtmlService (network error
// pada docs.google.com/offline/iframeapi, di luar kendali kode ini).
// ui.prompt()/ui.alert() adalah dialog native Google Sheets — dieksekusi
// dalam permintaan menu yang sama, tidak lewat iframe/google.script.run
// sama sekali, sehingga tidak terpengaruh masalah tersebut.
function installRecordCenterInstanceViaPrompts() {
  const ui = SpreadsheetApp.getUi();
  try {
    const setup = getInstanceSetup_();
    let response = ui.prompt('1/3 — Nama Record Center',
      'Nama resmi Record Center (kosongkan untuk default: ' + setup.defaults.rcName + ')',
      ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const rcName = cleanText_(response.getResponseText(), 250) || setup.defaults.rcName;

    response = ui.prompt('2/3 — Administrator', 'Nama administrator instance:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const adminName = response.getResponseText();

    response = ui.prompt('3/3 — Folder Induk',
      'ID folder induk Record Center di Drive (bukan URL lengkap):', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const rootFolderId = response.getResponseText();

    let confirmRebind = false;
    if (setup.rebindRequired) {
      const rebindResponse = ui.alert('Konfirmasi pengikatan ulang',
        'Spreadsheet ini pernah terikat instance Record Center lain. Lanjutkan mengikat ulang ke instance ini?',
        ui.ButtonSet.YES_NO);
      if (rebindResponse !== ui.Button.YES) { ui.alert('Dibatalkan. Tidak ada perubahan.'); return; }
      confirmRebind = true;
    }

    const result = installRecordCenterInstance_({
      rcName: rcName,
      adminName: adminName,
      adminEmail: setup.defaults.adminEmail,
      additionalAdminEmails: setup.defaults.additionalAdminEmails,
      location: setup.defaults.location || 'Surabaya',
      rootFolderId: rootFolderId,
      confirmRebind: confirmRebind
    });
    ui.alert('Instalasi berhasil', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Instalasi gagal', error.message, ui.ButtonSet.OK);
  }
}

function registerSourceViaPrompts() {
  const ui = SpreadsheetApp.getUi();
  try {
    let response = ui.prompt('1/4 — Instance ID Central File',
      'Contoh: INS-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const sourceId = response.getResponseText();

    response = ui.prompt('2/4 — Nama unit', 'Nama unit pemilik Central File:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const unitName = response.getResponseText();

    response = ui.prompt('3/4 — Kode unit (opsional)', 'Boleh dikosongkan:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const unitCode = response.getResponseText();

    response = ui.prompt('4/4 — Email administrator unit',
      'Contoh: bag.umum@uinsa.ac.id', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const adminEmail = response.getResponseText();

    const result = registerSource_({
      sourceId: sourceId,
      unitName: unitName,
      unitCode: unitCode,
      adminEmail: adminEmail,
      notes: '',
      generateNewSecret: true
    });
    ui.alert(
      result.secretIssued ? 'Sumber terdaftar — SALIN SECRET INI SEKARANG' : 'Sumber diperbarui',
      result.secretIssued
        ? 'Shared secret (tidak akan ditampilkan lagi setelah dialog ini ditutup):\n\n' +
          result.secret + '\n\nSalin ke installer Central File pada field shared secret Record Center.'
        : result.message,
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert('Pendaftaran gagal', error.message, ui.ButtonSet.OK);
  }
}

// Apps Script tidak bisa menampilkan layar izin dari DALAM dialog/sidebar,
// dan menjalankan fungsi lewat tombol Run di editor tidak selalu memicu
// izin yang sama dengan konteks UI spreadsheet. Klik menu ini LANGSUNG dari
// spreadsheet (bukan dari editor, bukan dari dalam dialog lain) supaya
// Google menampilkan layar otorisasi native untuk seluruh scope yang
// dibutuhkan (Spreadsheet, Drive, Properties) sebelum instalasi dijalankan.
function runInitialAuthorization() {
  const ui = SpreadsheetApp.getUi();
  try {
    const email = getCurrentUser_();
    SpreadsheetApp.getActiveSpreadsheet().getId();
    DriveApp.getRootFolder().getId();
    PropertiesService.getScriptProperties().getProperty('RC_INSTANCE_ID');
    ui.alert(
      'Otorisasi berhasil',
      'Akses untuk ' + email + ' sudah aktif. Sekarang buka menu ' +
        '"Instalasi & Reliability…".',
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert('Otorisasi gagal', error.message, ui.ButtonSet.OK);
    throw error;
  }
}

function apiGetInstanceSetup() {
  return getInstanceSetup_();
}

function apiInstallRecordCenterInstance(formObject) {
  return installRecordCenterInstance_(formObject);
}

function apiGetRcDashboard() {
  requireRecordCenterAdmin_();
  return getRcDashboard_();
}

function apiRunRcHealthCheck() {
  requireRecordCenterAdmin_();
  return runRcHealthCheck_(true);
}

function apiStartRcBackup() {
  requireRecordCenterAdmin_();
  return startRcBackup_();
}

function apiRegisterSource(formObject) {
  return registerSource_(formObject);
}

function apiListSources() {
  requireRecordCenterAdmin_();
  return listSources_();
}

function apiDeactivateSource(formObject) {
  return deactivateSource_(formObject);
}
