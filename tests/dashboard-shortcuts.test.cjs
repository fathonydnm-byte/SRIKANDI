const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../central-file/Client.html'),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
function fixture(){
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id)){const classes=new Set(id==='dashboardPage'?['active']:[]);nodes.set(id,{id,value:'old search',hidden:true,textContent:'',dataset:{},scrolls:0,focuses:0,
      classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){on?classes.add(x):classes.delete(x)}},
      scrollIntoView(){this.scrolls++},focus(){this.focuses++}})}return nodes.get(id);
  };
  const pages=['dashboard','loans','retention','search'].map(x=>node(x+'Page'));
  const ctx=vm.createContext({console,Number,Set,document:{addEventListener(){},getElementById:node,querySelectorAll:s=>s==='.page'?pages:[]}});
  vm.runInContext(source,ctx);
  ctx.normalizeFolderLabelFilter_=s=>String(s||'').trim().toLowerCase();
  return {ctx,node,state:vm.runInContext('state',ctx)};
}
test('retention dashboard scopes include proposed records and exact day boundaries, excluding transferred',()=>{
  const {ctx}=fixture();
  const row=(days,status='PROPOSED')=>({activeLimit:'2026-10-26',daysToActiveLimit:days,statusCode:status});
  for(const days of [0,1,7])assert.equal(ctx.matchesRetentionFilter_(row(days),'DASHBOARD_DUE'),true);
  for(const days of [-1,8])assert.equal(ctx.matchesRetentionFilter_(row(days),'DASHBOARD_DUE'),false);
  assert.equal(ctx.matchesRetentionFilter_(row(-1),'DASHBOARD_EXPIRED'),true);
  assert.equal(ctx.matchesRetentionFilter_(row(0),'DASHBOARD_EXPIRED'),false);
  assert.equal(ctx.matchesRetentionFilter_(row(-2,'TRANSFERRED'),'DASHBOARD_EXPIRED'),false);
  assert.equal(ctx.matchesRetentionFilter_(row(2,'TRANSFERRED'),'DASHBOARD_DUE'),false);
  assert.equal(ctx.matchesRetentionFilter_(row(null),'DASHBOARD_DUE'),false);
  assert.equal(ctx.matchesRetentionFilter_({...row(0),activeLimit:''},'DASHBOARD_DUE'),false);
  assert.equal(ctx.matchesRetentionFilter_(row(-1),'EXPIRED'),false); // Existing business-status filter still exact.
});
test('retention visible list uses date scope while retaining query and ordinary status filters',()=>{
  const {ctx,state,node}=fixture();
  state.retentionOptions={berkas:[{id:'a',title:'Kontrak',activeLimit:'2026-10-20',daysToActiveLimit:-6,statusCode:'PROPOSED'},
    {id:'b',title:'Kontrak lain',activeLimit:'2026-10-20',daysToActiveLimit:-6,statusCode:'EXPIRED'}]};
  node('retentionSearch').value='kontrak';node('retentionStatusFilter').value='DASHBOARD_EXPIRED';
  assert.deepEqual(Array.from(ctx.visibleRetentionRows_(),r=>r.id),['a','b']);
  node('retentionStatusFilter').value='EXPIRED';assert.deepEqual(Array.from(ctx.visibleRetentionRows_(),r=>r.id),['b']);
});
test('loan card clears stale search, chooses active loans, forces one refresh and focuses list',async()=>{
  const {ctx,node}=fixture();const loads=[];
  ctx.loadLoanOptions=async force=>loads.push(force);
  await ctx.openDashboardDetail_('loans');
  assert.equal(node('loansPage').classList.contains('active'),true);
  assert.equal(node('loanSearch').value,'');assert.equal(node('loanStatusFilter').value,'ACTIVE');
  assert.deepEqual(loads,[true]);assert.ok(node('loanTrackingSection').focuses>0);
});
test('retention cards select their date scope and focus the monitoring list even with zero results',async()=>{
  for(const [kind,scope] of [['due','DASHBOARD_DUE'],['expired','DASHBOARD_EXPIRED']]){
    const {ctx,node}=fixture();let calls=0;ctx.loadRetentionOptions=async force=>{calls++;assert.equal(force,true)};
    await ctx.openDashboardDetail_(kind);
    assert.equal(node('retentionStatusFilter').value,scope);assert.equal(node('retentionSearch').value,'');
    assert.equal(node('retentionPage').classList.contains('active'),true);assert.equal(calls,1);
    assert.ok(node('retentionMonitoringSection').focuses>0);
  }
});
test('late data response cannot move focus after operator navigates elsewhere',async()=>{
  const {ctx,node}=fixture();let resolve;ctx.loadLoanOptions=()=>new Promise(r=>resolve=r);
  const pending=ctx.openDashboardDetail_('loans');const focused=node('loanTrackingSection').focuses;
  ctx.showPage('dashboard');resolve();await pending;
  assert.equal(node('dashboardPage').classList.contains('active'),true);
  assert.equal(node('loanTrackingSection').focuses,focused);
});
