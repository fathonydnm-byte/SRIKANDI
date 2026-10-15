// node --test tests/content-search.test.cjs
// Google I/O adapters are local. DOCX ZIP/XML extraction uses the production parser.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const python=process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
const py=(script,input)=>execFileSync(python,['-c',script],{input:JSON.stringify(input),maxBuffer:24*1024*1024}).toString();
function blob(value,name='word.docx',type='application/zip'){
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value));
  return {getBytes:()=>[...bytes],getName:()=>name,getDataAsString:()=>bytes.toString('utf8'),copyBlob:()=>blob(bytes,name,type),setContentType(){return this}};
}
function element(node){return {getName:()=>node.name,getNamespace:()=>({getURI:()=>node.uri}),getText:()=>node.text,getChildren:()=>node.children.map(element)}}
const adapters={
  unzip:b=>JSON.parse(py("import sys,json,zipfile,io,base64\na=json.load(sys.stdin)\nz=zipfile.ZipFile(io.BytesIO(base64.b64decode(a)))\nprint(json.dumps([{'name':n,'data':base64.b64encode(z.read(n)).decode()} for n in z.namelist()]))",Buffer.from(b.getBytes()).toString('base64'))).map(x=>blob(Buffer.from(x.data,'base64'),x.name)),
  parse:s=>{const tree=JSON.parse(py("import sys,json,xml.etree.ElementTree as E\ndef convert(n):\n t=n.tag; u,t=t[1:].split('}',1) if t.startswith('{') else ('',t)\n return {'name':t,'uri':u,'text':n.text or '', 'children':[convert(c) for c in n]}\nprint(json.dumps(convert(E.fromstring(json.load(sys.stdin)))))",s));return {getRootElement:()=>element(tree)}}
};
function zip(parts){return Buffer.from(py("import io,zipfile,json,sys,base64\na=json.load(sys.stdin); b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n for n,v in a.items(): z.writestr(n,v)\nprint(base64.b64encode(b.getvalue()).decode())",parts).trim(),'base64')}
const w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const makeDoc=(body,extra={})=>zip({'[Content_Types].xml':'<Types/>','word/document.xml':`<w:document xmlns:w="${w}"><w:body>${body}</w:body></w:document>`,...extra});
const sample=makeDoc('<w:p><w:r><w:t>Total</w:t></w:r><w:r><w:t xml:space="preserve"> nilai proyek Rp125.000.000</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>NPWP vendor 12.345.678.9-012.345</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Denda keterlambatan mengikuti kontrak.</w:t></w:r></w:p>');
function fixture(){
  const ctx=vm.createContext({console});
  for(const name of ['Config.js','DocxTextService.js','ContentDocumentService.js','ContentSearchService.js','ReliabilityService.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../central-file',name),'utf8'),ctx);
  const tables={DB_BERKAS:[{BERKAS_ID:'b1',JUDUL_BERKAS:'Cloud',DRIVE_FOLDER_ID:'archive'}],DB_ITEM:[{ITEM_ID:'i1',BERKAS_ID:'b1',DRIVE_FILE_ID:'pdf1',DRIVE_FILE_URL:'https://drive.google.com/file/d/pdf1/view',NO_ITEM_DEFINITIF:1,JUMLAH_HALAMAN:160,URAIAN_LENGKAP:'Kontrak'}],DB_SEARCH_DOCUMENTS:[],SYSTEM_MIGRATIONS:[]};
  const properties=new Map(),files=new Map(),sessions=new Map(),triggers=[];
  let seq=0;
  const file=(id,data=sample,type='application/vnd.openxmlformats-officedocument.wordprocessingml.document')=>{
    const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
    const f={getId:()=>id,getBlob:()=>blob(bytes),getSize:()=>bytes.length,getMimeType:()=>type,getParents:()=>({next:()=>folder}),setName(){return this},setTrashed(flag){this.trashed=flag;return this}};
    files.set(id,f);return f;
  };
  const folder={getId:()=> 'texts',getFoldersByName:()=>({hasNext:()=>true,next:()=>folder}),createFolder:()=>folder,createFile:b=>file('index-'+(++seq),Buffer.from(b.getBytes()),'application/json')};
  Object.assign(ctx,{
    Utilities:{unzip:adapters.unzip,newBlob:(value,type,name)=>blob(value,name,type),getUuid:()=> 'uuid-'+(++seq),base64Decode:x=>[...Buffer.from(x,'base64')],base64EncodeWebSafe:x=>Buffer.from(x).toString('base64url'),computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],DigestAlgorithm:{SHA_256:'sha256'}},
    XmlService:{parse:adapters.parse},
    getSpreadsheet_:()=>({getSheetByName:name=>tables[name]?{}:null}),getHeaders_:()=>vm.runInContext('CONTENT_DOCUMENT_HEADERS_',ctx),
    contentReadObjects_:name=>(tables[name]||[]).map((r,i)=>({...r,_rowNumber:i+2})),
    appendObject_:(name,row)=>tables[name].push({...row}),updateObjectAtRow_:(name,row,changes)=>Object.assign(tables[name][row-2],changes),
    readObjects_:name=>tables[name]||[],
    cleanText_:(x,max)=>String(x||'').replace(/\s+/g,' ').trim().slice(0,max),requireValue_:(x,label)=>{if(!x)throw Error(label);return x},
    naturalCompare_:(a,b)=>String(a||'').localeCompare(String(b||''),undefined,{numeric:true}),isDeleted_:row=>row.IS_DELETED===true||row.IS_DELETED==='TRUE',
    getCurrentUser_:()=> 'operator@example.invalid',nowIso_:()=>new Date().toISOString(),assertItemAvailableForEdit_:()=>{},purgeOldUploadSessionsByPrefix_:()=>{},audit_:()=>{},
    LockService:{getScriptLock:()=>({waitLock(){},tryLock:()=>true,releaseLock(){}})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k),setProperties:values=>Object.entries(values).forEach(([k,v])=>properties.set(k,v))})},
    DriveApp:{getFolderById:()=>folder,getFileById:id=>{if(!files.has(id))throw Error('Tidak ada akses file');return files.get(id)}},
    initializeDriveResumableUpload_:(_,size)=>{const id='upload-'+(++seq);sessions.set(id,{size,bytes:Buffer.alloc(0),fileId:''});return id},
    sendDriveResumableChunk_:(url,bytes,start,end,total)=>{const s=sessions.get(url);assert.equal(s.bytes.length,start);s.bytes=Buffer.concat([s.bytes,Buffer.from(bytes)]);if(end===total){s.fileId='word-'+(++seq);file(s.fileId,s.bytes)}return {complete:end===total,uploadedBytes:end,fileId:s.fileId}},
    queryDriveResumableStatus_:url=>{const s=sessions.get(url);return {complete:!!s.fileId,uploadedBytes:s.bytes.length,fileId:s.fileId}},
    ScriptApp:{getProjectTriggers:()=>triggers.map(name=>({getHandlerFunction:()=>name})),newTrigger:name=>({timeBased:()=>({everyMinutes:()=>({create:()=>triggers.push(name)})})})},
    ensureSystemSheet_:(name)=>{tables[name]??=[]},upsertReliabilitySettingsBatch_:()=>{}
  });
  const request={berkasId:'b1',itemId:'i1',pdfId:'pdf1',fileName:'kontrak.docx',fileSize:sample.length,confirmCurrentPdf:true};
  return {ctx,tables,files,properties,triggers,request,file};
}
function upload(f){
  const s=f.ctx.startContentWordUpload_(f.request);
  f.ctx.uploadContentWordChunk_({sessionId:s.sessionId,start:0,end:sample.length,total:sample.length,base64:sample.toString('base64')});
  const result=f.ctx.finalizeContentWordUpload_(s.sessionId);
  return {s,result};
}
function ready(f){const uploaded=upload(f);f.ctx.continueContentDocumentJobs();return uploaded}
const plain=x=>JSON.parse(JSON.stringify(x));

test('real DOCX extraction joins runs, reads table cells and preserves amounts and IDs',()=>{
  const {ctx}=fixture(),r=ctx.extractContentDocx_(blob(sample));
  assert.equal(r.paragraphs.length,3);assert.equal(r.pageMapping,'UNAVAILABLE');
  assert.match(r.paragraphs[0].text,/Rp125\.000\.000/);assert.match(r.paragraphs[1].text,/12\.345\.678\.9-012\.345/);
});
test('headers, footnotes, tabs, breaks and entity decoding are searchable; deleted revisions excluded',()=>{
  const {ctx}=fixture();
  const b=makeDoc('<w:p><w:r><w:t>A &amp; B</w:t><w:tab/><w:t>Total</w:t><w:br/><w:t>nilai</w:t></w:r><w:del><w:r><w:t>HAPUS</w:t></w:r></w:del></w:p>',{'word/header1.xml':`<w:hdr xmlns:w="${w}"><w:p><w:r><w:t>HEADER</w:t></w:r></w:p></w:hdr>`,'word/footnotes.xml':`<w:footnotes xmlns:w="${w}"><w:footnote><w:p><w:r><w:t>CATATAN</w:t></w:r></w:p></w:footnote></w:footnotes>`});
  const text=ctx.extractContentDocx_(blob(b)).paragraphs.map(x=>x.text).join('|');
  assert.match(text,/A & B\tTotal\nnilai/);assert.match(text,/HEADER/);assert.match(text,/CATATAN/);assert.doesNotMatch(text,/HAPUS/);
});
test('image-only, corrupt ZIP, oversized expansion and embedded foreign Word content fail explicitly',()=>{
  const {ctx}=fixture();
  assert.throws(()=>ctx.extractContentDocx_(blob(makeDoc('<w:p/>'))),/OCR/);
  assert.throws(()=>ctx.extractContentDocx_(blob(Buffer.from('not a docx'))),/valid/);
  const bad=Buffer.from(sample),central=bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bad.writeUInt32LE(40*1024*1024,central+24);
  assert.throws(()=>ctx.extractContentDocx_(blob(bad)),/terlalu besar/);
  assert.throws(()=>ctx.extractContentDocx_(blob(makeDoc('<w:altChunk/>'))),/tertanam/);
});
test('long paragraphs retain phrases across chunk boundaries',()=>{
  const {ctx}=fixture();
  const r=ctx.extractContentDocx_(blob(makeDoc('<w:p><w:r><w:t>'+('x'.repeat(2395))+' total kontrak '+('z'.repeat(200))+'</w:t></w:r></w:p>')));
  assert.ok(r.paragraphs.some(p=>p.text.includes('total kontrak')));
});
test('160-page item uploads, extracts and searches without a page-count exclusion',()=>{
  const f=fixture();ready(f);
  assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'READY');
  const r=f.ctx.searchContentBerkas_({berkasId:'b1',query:'TOTAL   NILAI'});
  assert.equal(r.results.length,1);assert.match(r.results[0].text,/125\.000\.000/);assert.equal(r.results[0].page,null);
  assert.equal(r.coverage.ready,1);assert.equal(r.done,true);
});
test('scope coverage includes unsearchable items and restricts results to selected berkas/item',()=>{
  const f=fixture();ready(f);
  f.tables.DB_ITEM.push({ITEM_ID:'i2',BERKAS_ID:'b1',DRIVE_FILE_ID:'pdf2'}, {ITEM_ID:'other',BERKAS_ID:'b2',DRIVE_FILE_ID:'pdf3'});
  const r=f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'});
  assert.equal(r.coverage.total,2);assert.equal(r.coverage.ready,1);
  assert.equal(f.ctx.searchContentBerkas_({berkasId:'b1',itemId:'i2',query:'total'}).results.length,0);
  assert.throws(()=>f.ctx.searchContentBerkas_({berkasId:'b1',itemId:'other',query:'total'}),/Item/);
});
test('PDF replacement immediately makes previous text stale; deleted item/parent excluded',()=>{
  const f=fixture();ready(f);f.tables.DB_ITEM[0].DRIVE_FILE_ID='new-pdf';
  assert.equal(f.ctx.getContentBerkas_('b1').items[0].status,'STALE');
  assert.equal(f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'}).results.length,0);
  f.tables.DB_ITEM[0].IS_DELETED=true;assert.equal(f.ctx.getContentBerkas_('b1').total,0);
  f.tables.DB_BERKAS[0].IS_DELETED=true;assert.throws(()=>f.ctx.getContentBerkas_('b1'),/dibatalkan/);
});
test('finalize and duplicate chunk retries are idempotent; committed cancellation preserves Word',()=>{
  const f=fixture(),{s}=upload(f),id=f.tables.DB_SEARCH_DOCUMENTS[0].WORD_FILE_ID;
  f.ctx.uploadContentWordChunk_({sessionId:s.sessionId});
  f.ctx.finalizeContentWordUpload_(s.sessionId);assert.equal(f.tables.DB_SEARCH_DOCUMENTS.length,1);
  assert.equal(f.ctx.cancelContentWordUpload_(s.sessionId).committed,true);assert.ok(!f.files.get(id).trashed);
});
test('lost finalize response is recovered from document ID even if session save failed',()=>{
  const f=fixture(),original=f.ctx.saveContentUploadSession_;
  f.ctx.saveContentUploadSession_=s=>{if(s.committed)throw Error('connection lost');original(s)};
  assert.throws(()=>upload(f),/connection lost/);assert.equal(f.tables.DB_SEARCH_DOCUMENTS.length,1);
  f.ctx.saveContentUploadSession_=original;
  const id=f.tables.DB_SEARCH_DOCUMENTS[0].DOCUMENT_ID;
  assert.equal(f.ctx.finalizeContentWordUpload_(id).ok,true);assert.equal(f.tables.DB_SEARCH_DOCUMENTS.length,1);
});
test('wrong user, absent PDF, absent confirmation, bad size/type rejected before upload',()=>{
  const f=fixture();
  for(const changes of [{confirmCurrentPdf:false},{confirmCurrentPdf:'false'},{fileName:'kontrak.doc'},{fileSize:11*1024*1024}])assert.throws(()=>f.ctx.startContentWordUpload_({...f.request,...changes}));
  const s=f.ctx.startContentWordUpload_(f.request);f.ctx.getCurrentUser_=()=> 'other@example.invalid';
  assert.throws(()=>f.ctx.getContentWordUploadStatus_(s.sessionId),/pengguna lain/);
  f.ctx.getCurrentUser_=()=> 'operator@example.invalid';f.tables.DB_ITEM[0].DRIVE_FILE_ID='';
  assert.throws(()=>f.ctx.startContentWordUpload_(f.request),/PDF/);
});
test('PDF change during upload prevents association, preserving existing document',()=>{
  const f=fixture();ready(f);
  const s=f.ctx.startContentWordUpload_(f.request);
  f.ctx.uploadContentWordChunk_({sessionId:s.sessionId,start:0,end:sample.length,total:sample.length,base64:sample.toString('base64')});
  f.tables.DB_ITEM[0].DRIVE_FILE_ID='changed';
  assert.throws(()=>f.ctx.finalizeContentWordUpload_(s.sessionId),/berubah/);assert.equal(f.tables.DB_SEARCH_DOCUMENTS.length,1);
});
test('worker failure is visible and retryable; expired lease recovers and duplicate worker is harmless',()=>{
  const f=fixture();upload(f);
  const extract=f.ctx.extractContentDocx_;f.ctx.extractContentDocx_=()=>{throw Error('temporary error')};
  f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'FAILED');
  f.ctx.retryContentDocument_(f.tables.DB_SEARCH_DOCUMENTS[0].DOCUMENT_ID);f.ctx.extractContentDocx_=extract;
  f.tables.DB_SEARCH_DOCUMENTS[0].STATUS='PROCESSING';f.tables.DB_SEARCH_DOCUMENTS[0].LEASE_AT='2000-01-01T00:00:00Z';
  f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'READY');
  const id=f.tables.DB_SEARCH_DOCUMENTS[0].INDEX_FILE_ID;f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].INDEX_FILE_ID,id);
});
test('repeated hard-stop recovery has a finite limit and becomes a visible failure',()=>{
  const f=fixture();upload(f);Object.assign(f.tables.DB_SEARCH_DOCUMENTS[0],{STATUS:'PROCESSING',LEASE_AT:'2000-01-01T00:00:00Z',ATTEMPT_COUNT:3});
  f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'FAILED');
  f.ctx.retryContentDocument_(f.tables.DB_SEARCH_DOCUMENTS[0].DOCUMENT_ID);assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].ATTEMPT_COUNT,0);
});
test('latest Word version supersedes previous index while queued, without deleting history',()=>{
  const f=fixture();ready(f);upload(f);
  assert.equal(f.ctx.getContentBerkas_('b1').items[0].status,'QUEUED');
  assert.equal(f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'}).results.length,0);
  f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS.length,2);assert.equal(f.ctx.getContentBerkas_('b1').ready,1);
});
test('worker cannot publish content if PDF or active Word changes during extraction',()=>{
  const f=fixture();upload(f);const parse=f.ctx.extractContentDocx_;
  f.ctx.extractContentDocx_=b=>{const result=parse(b);f.tables.DB_ITEM[0].DRIVE_FILE_ID='changed';return result};
  f.ctx.continueContentDocumentJobs();assert.equal(f.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'STALE');
  assert.equal(f.ctx.getContentBerkas_('b1').ready,0);
  const g=fixture();upload(g);const parseG=g.ctx.extractContentDocx_;
  g.ctx.extractContentDocx_=b=>{const result=parseG(b);upload(g);return result};
  g.ctx.continueContentDocumentJobs();assert.equal(g.tables.DB_SEARCH_DOCUMENTS[0].STATUS,'SUPERSEDED');
  assert.equal(g.tables.DB_SEARCH_DOCUMENTS[1].STATUS,'QUEUED');
});
test('chunk offset recovery resumes upload after a lost response without resending committed bytes',()=>{
  const f=fixture(),data=Buffer.alloc(600000,1);
  const session=f.ctx.startContentWordUpload_({...f.request,fileSize:data.length});
  f.ctx.uploadContentWordChunk_({sessionId:session.sessionId,start:0,end:524288,total:data.length,base64:data.subarray(0,524288).toString('base64')});
  const recovered=f.ctx.getContentWordUploadStatus_(session.sessionId);assert.equal(recovered.uploadedBytes,524288);
  assert.equal(f.ctx.uploadContentWordChunk_({sessionId:session.sessionId,start:0,end:524288,total:data.length}).uploadedBytes,524288);
  f.ctx.uploadContentWordChunk_({sessionId:session.sessionId,start:524288,end:data.length,total:data.length,base64:data.subarray(524288).toString('base64')});
  assert.equal(f.ctx.finalizeContentWordUpload_(session.sessionId).ok,true);
});
test('pagination covers all 160 matching paragraphs and rejects snapshot changes',()=>{
  const f=fixture();ready(f);const row=f.tables.DB_SEARCH_DOCUMENTS[0];
  const index={version:1,documentId:row.DOCUMENT_ID,pdfId:row.SOURCE_PDF_ID,paragraphs:Array.from({length:160},(_,i)=>({text:'Total nilai '+i,paragraph:i+1,part:1,section:'Isi dokumen'}))};
  f.file(row.INDEX_FILE_ID,JSON.stringify(index),'application/json');
  let cursor=null,results=[];
  do{const r=f.ctx.searchContentBerkas_({berkasId:'b1',query:'total',cursor});results.push(...r.results);cursor=r.cursor}while(cursor);
  assert.equal(results.length,160);assert.equal(new Set(results.map(r=>r.key)).size,160);
  cursor=f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'}).cursor;f.tables.DB_ITEM[0].DRIVE_FILE_ID='replaced';
  assert.throws(()=>f.ctx.searchContentBerkas_({berkasId:'b1',query:'total',cursor}),/berubah/);
});
test('Drive read failure is reported; concurrent PDF replacement cannot return stale content',()=>{
  const f=fixture();ready(f);const row=f.tables.DB_SEARCH_DOCUMENTS[0],indexFile=f.files.get(row.INDEX_FILE_ID);
  f.files.delete(row.INDEX_FILE_ID);const r=f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'});
  assert.equal(r.errors.length,1);assert.equal(r.results.length,0);
  f.files.set(row.INDEX_FILE_ID,indexFile);const read=f.ctx.readContentTextIndex_;
  f.ctx.readContentTextIndex_=document=>{const index=read(document);f.tables.DB_ITEM[0].DRIVE_FILE_ID='replaced';return index};
  assert.throws(()=>f.ctx.searchContentBerkas_({berkasId:'b1',query:'total'}),/berubah/);
});
test('REL-013 schema and trigger installation are idempotent and preserve archive data',()=>{
  const f=fixture();f.tables.SYSTEM_MIGRATIONS=Array.from({length:12},(_,i)=>({MIGRATION_ID:'REL-'+String(i+1).padStart(3,'0'),STATUS:'SUCCESS'}));
  const before=JSON.stringify(f.tables.DB_ITEM);
  f.ctx.applyReliabilityMigrations_();f.ctx.applyReliabilityMigrations_();
  assert.equal(f.tables.SYSTEM_MIGRATIONS.filter(x=>x.MIGRATION_ID==='REL-013').length,1);
  assert.equal(f.triggers.length,1);assert.equal(JSON.stringify(f.tables.DB_ITEM),before);
  assert.equal(f.properties.get('INSTANCE_SCHEMA_VERSION'),'11');
});
test('new reader preserves physical row numbers with blank spreadsheet rows',()=>{
  const f=fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../central-file/ContentDocumentService.js'),'utf8'),f.ctx);
  f.ctx.getSheetOrThrow_=()=>({getLastRow:()=>4,getRange:()=>({getValues:()=>[['doc1'],[''],['doc3']]})});
  f.ctx.getHeaders_=()=>['DOCUMENT_ID'];
  assert.deepEqual(plain(f.ctx.contentReadObjects_('x').map(r=>r._rowNumber)),[2,4]);
});
if(process.env.CONTENT_SEARCH_SAMPLE_DOCX)test('actual Nitro OCR attachment extracts through production ZIP/XML parser',()=>{
  const {ctx}=fixture(),data=fs.readFileSync(process.env.CONTENT_SEARCH_SAMPLE_DOCX);
  const r=ctx.extractContentDocx_(blob(data));
  assert.ok(r.characters>3000);assert.match(r.paragraphs.map(x=>x.text).join('\n'),/Denda/i);
  console.log('Nitro sample:',r.characters,'characters;',r.paragraphs.length,'paragraphs; no page numbers inferred.');
});
