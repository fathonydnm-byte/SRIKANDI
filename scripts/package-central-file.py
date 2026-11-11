#!/usr/bin/env python3
"""Build a deterministic Central File source ZIP (no project binding/credentials)."""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
source = root / 'central-file'
config = (source / 'Config.js').read_text(encoding='utf-8')
version = re.search(r"VERSION: '([^']+)'", config)[1]
schema = int(re.search(r'SCHEMA_VERSION: (\d+)', config)[1])
files = {p.name: p.read_bytes() for p in sorted(source.iterdir())
         if p.is_file() and (p.suffix in ('.js', '.html') or p.name == 'appsscript.json')}
manifest = {'release': version, 'schema': schema, 'channel': 'PILOT',
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
            'canonicalFiles': {name: hashlib.sha256((data.decode('utf-8').lstrip('\ufeff').replace('\r\n', '\n').rstrip('\n') + '\n').encode('utf-8')).hexdigest()
                               for name, data in files.items()}}
manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
buffer = io.BytesIO()
with ZipFile(buffer, 'w', compression=ZIP_DEFLATED, compresslevel=9) as z:
    for name, data in sorted({**files, 'SOURCE_MANIFEST.json': manifest_bytes}.items()):
        info = ZipInfo(name, date_time=(2026, 10, 15, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        z.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
args.output_dir.mkdir(parents=True, exist_ok=True)
archive = args.output_dir / f'central-file-{version}-pilot.zip'
archive.write_bytes(buffer.getvalue())
checksum = hashlib.sha256(buffer.getvalue()).hexdigest()
(args.output_dir / (archive.name + '.sha256')).write_text(checksum + '  ' + archive.name + '\n')
(args.output_dir / 'SOURCE_MANIFEST.json').write_bytes(manifest_bytes)
print(json.dumps({'archive': str(archive), 'sha256': checksum, 'sourceFiles': len(files)}, indent=2))
