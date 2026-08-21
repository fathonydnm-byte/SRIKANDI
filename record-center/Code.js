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
    .addToUi();
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
