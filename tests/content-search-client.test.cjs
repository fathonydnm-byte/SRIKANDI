// State/render tests with a small DOM adapter; visual/browser UAT remains separate.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,dataset:{},files:[],checked:false,
      classList:{contains:()=>true,add(){},remove(){}},addEventListener(){},replaceChildren(...children){this.innerHTML='';this.children=children;this.value=children[0]?.value||''},
      add(option){(this.children??=[]).push(option)},focus(){},insertAdjacentHTML(_,html){this.innerHTML+=html},appendChild(child){this.innerHTML+=child.textContent}});
    return nodes.get(id);
  };
  const ctx=vm.createContext({console,setTimeout,clearTimeout,Option:function(text,value){this.text=text;this.value=value},
    document:{addEventListener(){},activeElement:null,createElement:()=>({})},$:node,toast(){},
    escapeHtml:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
  const html=fs.readFileSync(path.join(__dirname,'../central-file/ContentSearch.html'),'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);
  const state=vm.runInContext('contentSearchState',ctx);
  return {ctx,state,node};
}
test('search highlighting escapes OCR HTML and treats regex metacharacters literally',()=>{
  const {ctx}=fixture();
  const html=ctx.contentHighlight_('<img src=x onerror=alert(1)> Total (Rp) 1.000','(Rp)');
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/<mark>\(Rp\)<\/mark>/);
  assert.match(ctx.contentHighlight_('TOTAL\n  NILAI','total nilai'),/<mark>TOTAL\n  NILAI<\/mark>/);
});
test('result rendering keeps context and disallows unsafe source links',()=>{
  const {ctx}=fixture();
  const html=ctx.renderContentResult_({itemLabel:'<svg/onload=x>',text:'Total 125',before:'Syarat kontrak',after:'Denda 1%',section:'Isi',paragraph:2,part:1,pdfUrl:'javascript:alert(1)',wordUrl:'https://drive.google.com/file/d/test/view'},'total');
  assert.doesNotMatch(html,/href="javascript/);assert.doesNotMatch(html,/<svg/);
  assert.match(html,/Syarat kontrak/);assert.match(html,/Denda 1%/);assert.match(html,/Paragraf 2/);
});
test('late search callback cannot overwrite a changed query',async()=>{
  const {ctx,state,node}=fixture();
  state.scope={berkasId:'b1'};node('contentBerkas').value='b1';node('contentQuery').value='total';
  let resolve;ctx.runServer=()=>new Promise(r=>resolve=r);
  const pending=ctx.runContentSearch_(false);ctx.clearContentResults_('Changed');
  resolve({results:[{text:'old result'}],errors:[],coverage:{scanned:1,ready:1,total:1},done:true});await pending;
  assert.equal(node('contentResults').innerHTML,'');assert.equal(node('contentSearchStatus').textContent,'Changed');
});
test('late scope load cannot replace the newly selected berkas',async()=>{
  const {ctx,state,node}=fixture();node('contentBerkas').value='b1';
  const pending=[];ctx.runServer=()=>new Promise(r=>pending.push(r));
  const first=ctx.loadContentScope_();node('contentBerkas').value='b2';const second=ctx.loadContentScope_();
  pending[1]({berkasId:'b2',ready:0,total:0,items:[]});await second;
  pending[0]({berkasId:'b1',ready:0,total:0,items:[]});await first;
  assert.equal(state.scope.berkasId,'b2');
});
test('partial scan stays explicit and exposes continuation button',async()=>{
  const {ctx,state,node}=fixture();state.scope={berkasId:'b1'};node('contentBerkas').value='b1';node('contentQuery').value='total';
  ctx.runServer=async()=>({results:[],errors:[],cursor:{document:3,paragraph:0,snapshot:'x'},done:false,coverage:{total:10,ready:8,scanned:3}});
  await ctx.runContentSearch_(false);
  assert.equal(node('contentSearchMore').hidden,false);assert.match(node('contentSearchStatus').textContent,/belum selesai/);assert.match(node('contentSearchStatus').textContent,/belum memiliki teks/);
});

test('fresh upload uses initial confirmed offset; resumed upload reconciles Drive first',async()=>{
  for(const resume of [false,true]){
    const {ctx,state,node}=fixture(),calls=[];
    const file={name:'sample.docx',size:100,slice:()=>({})};
    state.scope={berkasId:'b1',items:[{id:'i1',pdfId:'pdf1'}]};
    node('contentUploadItem').value='i1';node('contentWordFile').files=[file];node('contentWordConfirm').checked=true;
    if(resume)state.upload={file,sessionId:'session'};
    ctx.fileSliceToBase64=async()=> 'bytes';ctx.loadContentScope_=async()=>{};
    ctx.runServer=async(name)=>{
      calls.push(name);
      if(name==='apiStartContentWordUpload'||name==='apiGetContentWordUploadStatus')return {sessionId:'session',uploadedBytes:0,complete:false};
      if(name==='apiUploadContentWordChunk')return {uploadedBytes:100,complete:true};
      return {ok:true};
    };
    await ctx.uploadContentWord_();
    assert.equal(calls.includes('apiGetContentWordUploadStatus'),resume);
    assert.equal(calls.filter(x=>x==='apiFinalizeContentWordUpload').length,1);
    assert.equal(state.upload,null);assert.equal(state.uploadBusy,false);
    assert.equal(vm.runInContext('Object.keys(contentWaits_).length',ctx),0);
  }
});
test('wait timer is disposed on query change and cannot overwrite final status',()=>{
  const {ctx,node}=fixture();let callback,cleared=false;
  ctx.setTimeout=fn=>{callback=fn;return 7};ctx.clearTimeout=id=>{if(id===7)cleared=true};
  ctx.startContentWait_('contentSearchStatus','Mencari');
  assert.match(node('contentSearchStatus').textContent,/detik/);
  ctx.clearContentResults_('Changed');callback();
  assert.equal(node('contentSearchStatus').textContent,'Changed');assert.equal(cleared,true);
});
test('poll is rescheduled during upload instead of silently stopping',()=>{
  const {ctx,state}=fixture();const callbacks=[];
  ctx.setTimeout=fn=>{callbacks.push(fn);return callbacks.length};ctx.clearTimeout=()=>{};
  state.uploadBusy=true;ctx.scheduleContentPoll_();callbacks[0]();assert.equal(callbacks.length,2);
  state.uploadBusy=false;let loads=0;ctx.loadContentScope_=()=>loads++;callbacks[1]();assert.equal(loads,1);
});
