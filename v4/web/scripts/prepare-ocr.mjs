import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const path = (file) => new URL(file, import.meta.url);
const output = '../public/ocr/v1/';
await mkdir(path(output), { recursive: true });
const assets = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt'],
  ...['', '-simd', '-relaxedsimd'].map((kind) => {
    const file = 'tesseract-core' + kind + '-lstm.wasm.js';
    return ['tesseract.js-core/' + file, file];
  }),
  ...['ind', 'eng'].map((lang) => {
    const file = lang + '.traineddata.gz';
    return ['@tesseract.js-data/' + lang + '/4.0.0_best_int/' + file, file];
  }),
];
await Promise.all(assets.map(([from, to]) => copyFile(path('../node_modules/' + from), path(output + to))));
const licenseFiles = [
  'tesseract.js/LICENSE.md', 'tesseract.js-core/LICENSE', 'bmp-js/LICENSE',
  'idb-keyval/LICENCE', 'is-url/LICENSE-MIT', 'regenerator-runtime/LICENSE',
  'wasm-feature-detect/LICENSE', 'zlibjs/LICENSE',
];
const licenses = await Promise.all(licenseFiles.map(async (name) =>
  name + '\n' + await readFile(path('../node_modules/' + name), 'utf8'),
));
const attributions = [
  'Tesseract.js and Tesseract.js Core — Apache License 2.0.',
  'https://github.com/naptha/tesseract.js and https://github.com/naptha/tesseract.js-core',
  'Training data: Tesseract contributors (Apache License 2.0); repackaged by the Tesseract.js project.',
  'https://github.com/tesseract-ocr/tessdata_best and https://github.com/naptha/tessdata',
  '',
];
await writeFile(path(output + 'LICENSE.txt'), [...attributions, ...licenses].join('\n'));
