const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),crypto=require('crypto'),path=require('path');
const root=path.join(__dirname,'../central-file');
const headers=['Bagian','NO','JENIS ARSIP','AKTIF','INAKTIF','KETERANGAN','Retensi dalam sel gabungan Word','Tabel sumber','Baris sumber'];
function server(values){
 let reads=0;
 const ctx=vm.createContext({console,APP_CONFIG:{TIME_ZONE:'Asia/Jakarta'},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>crypto.createHash('sha256').update(s).digest(),base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url'),formatDate:()=> '27/10/2026 09:00:00'},SpreadsheetApp:{openById:()=>({getSheetByName:()=>({getLastRow:()=>values.length,getRange:(r,c,n,w)=>{assert.equal(r,1);assert.equal(c,1);assert.equal(n,values.length);assert.equal(w,9);reads++;return {getDisplayValues:()=>values}}})})}});
 vm.runInContext(fs.readFileSync(root+'/JraLookupService.js','utf8'),ctx);return {ctx,reads:()=>reads};
}
function client(){
 const nodes=new Map(),timers=new Map();let timer=0;
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,disabled:false,textContent:'',innerHTML:'',events:{},classList:{add(){},remove(){}},addEventListener(name,fn){this.events[name]=fn},replaceChildren(){this.innerHTML=''},insertAdjacentHTML(_,html){this.innerHTML+=html}});return nodes.get(id)};
 const ctx=vm.createContext({console,$,document:{addEventListener:(_,fn)=>fn()},setTimeout:fn=>{timers.set(++timer,fn);return timer},clearTimeout:id=>timers.delete(id),escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
 vm.runInContext(fs.readFileSync(root+'/JraLookup.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1],ctx);return {ctx,$,timers};
}
test('case-insensitive keyword finds Keputusan Rektor and preserves conditional retention verbatim',()=>{
 const {ctx,reads}=server([headers,['Fasilitatif','2','Keputusan Rektor\nSurat undangan','1 Tahun setelah\ndiperbarui','4 tahun','Permanen'],['Substantif','','Wisuda Sambutan Rektor','5 tahun','3 tahun','Musnah']]);
 const r=ctx.apiSearchJraReference({query:'REKTOR'});assert.equal(r.total,2);assert.equal(r.results[0].active,'1 Tahun setelah\ndiperbarui');assert.equal(r.results[0].row,2);assert.equal(reads(),1);
 assert.match(r.results[0].sourceUrl,/gid=917043056&range=A2:I2$/);
 assert.equal(ctx.apiSearchJraReference({query:'keputusan rektor'}).total,1);
});
test('blank cells remain blank; merged notes do not get invented active/inactive values',()=>{
 const {ctx}=server([headers,['Fasilitatif','4','Pengurusan kendaraan','','','Musnah','2 tahun']]);
 const r=ctx.apiSearchJraReference({query:'kendaraan'}).results[0];assert.equal(r.active,'');assert.equal(r.inactive,'');assert.equal(r.mergedRetention,'2 tahun');
});
test('pagination covers all matching rows and rejects changed source before continuing',()=>{
 const values=[headers,...Array.from({length:23},(_,i)=>['Fasilitatif',String(i),'Arsip rektor '+i,'1 tahun','4 tahun','Permanen'])];
 const {ctx}=server(values);const a=ctx.apiSearchJraReference({query:'rektor'}),b=ctx.apiSearchJraReference({query:'rektor',offset:a.nextOffset,snapshot:a.snapshot}),c=ctx.apiSearchJraReference({query:'rektor',offset:b.nextOffset,snapshot:b.snapshot});
 assert.equal(a.total,23);assert.equal(a.results.length+b.results.length+c.results.length,23);assert.equal(c.nextOffset,null);
 values[2][3]='2 tahun';assert.throws(()=>ctx.apiSearchJraReference({query:'rektor',offset:a.nextOffset,snapshot:a.snapshot}),/Data JRA berubah/);
});
test('invalid query is rejected before opening the source; changed headers fail explicitly',()=>{
 const {ctx,reads}=server([headers]);assert.throws(()=>ctx.apiSearchJraReference({query:'x'}),/2–120/);assert.equal(reads(),0);
 const other=server([['salah']]);assert.throws(()=>other.ctx.apiSearchJraReference({query:'rektor'}),/Susunan kolom/);
});
test('Enter searches without submitting the enclosing archive form, and reference text is escaped',()=>{
 const {ctx,$}=client();let prevent=0,stop=0,search=0;ctx.runJraLookup_=()=>search++;
 $('jraLookupQuery').events.keydown({key:'Enter',preventDefault:()=>prevent++,stopPropagation:()=>stop++});
 assert.equal(prevent,1);assert.equal(stop,1);assert.equal(search,1);
 const html=ctx.renderJraLookupRow_({description:'<img onerror=x>',row:2,sourceUrl:'javascript:alert(1)',active:'',inactive:'',disposition:'Musnah'});
 assert.doesNotMatch(html,/<img|javascript:/);assert.match(html,/&lt;img/);assert.match(html,/Tidak tercantum/);
});
test('late response cannot overwrite changed query and search timers stop',async()=>{
 const {ctx,$,timers}=client();$('jraLookupQuery').value='rektor';let resolve;ctx.runServer=()=>new Promise(r=>resolve=r);
 const pending=ctx.runJraLookup_(false);assert.equal($('jraLookupRun').disabled,true);ctx.resetJraLookup_();resolve({results:[],total:0,nextOffset:null,snapshot:'x'});await pending;
 assert.equal($('jraLookupResults').innerHTML,'');assert.equal($('jraLookupRun').disabled,false);assert.equal(timers.size,0);
});
