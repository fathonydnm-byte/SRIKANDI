import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CF_PLAYWRIGHT_MODULE);
const workdir = process.env.CF_PWA_WORKDIR;
let revision=0;
const marker = ['dashboard-old', 'dashboard-server-new', 'dashboard-fixed', 'dashboard-next-release'];
const types = { '.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.webmanifest':'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const p=new URL(req.url,'http://127.0.0.1').pathname;
    if (p.startsWith('/api/')) { res.writeHead(200,{'Content-Type':'text/plain'});res.end('api response');return; }
    const dir=join(workdir,revision<=1?'dist-cache-baseline':'web/dist');
    const f=extname(p)?p.slice(1):'index.html';
    let body=await readFile(join(dir,f));
    if (f==='index.html' && (revision===1 || revision===3)) {
      body=Buffer.from(body.toString().replace(/(<meta name="release-test" content=")[^"]+(")/, (_, start, end) => start+marker[revision]+end));
    }
    if (f==='sw.js'&&revision===1) body=Buffer.concat([body,Buffer.from('\n// new deployment using old worker configuration\n')]);
    res.writeHead(200,{'Content-Type':types[extname(f)]??'application/octet-stream','Cache-Control':'no-store'});
    res.end(body);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CF_CHROME_BIN,args:['--no-sandbox']});
try {
  const ctx=await browser.newContext();
  const long=await ctx.newPage();
  const getMarker=p=>p.locator('meta[name="release-test"]').getAttribute('content');
  await long.goto(url+'/dashboard');
  await long.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
  await long.reload();
  await long.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await getMarker(long),'dashboard-old');

  revision=1;
  await long.evaluate(async()=>{ (await navigator.serviceWorker.ready).update().catch(()=>{}); });
  await long.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
  const second=await ctx.newPage();
  await second.goto(url+'/dashboard');
  assert.equal(await getMarker(second),'dashboard-old','old worker still serves preloaded HTML');
  const fresh=await browser.newPage();
  await fresh.goto(url+'/dashboard');
  assert.equal(await getMarker(fresh),'dashboard-server-new');
  await fresh.close();

  await long.evaluate(()=>{ window.reproOldController = navigator.serviceWorker.controller; window.reproFormDraft='still open'; });
  revision=2;
  await long.evaluate(async()=>{ (await navigator.serviceWorker.ready).update().catch(()=>{}); });
  await long.waitForFunction(()=>!!navigator.serviceWorker.controller && navigator.serviceWorker.controller!==window.reproOldController);
  assert.equal(await long.evaluate(()=>window.reproFormDraft),'still open','worker activation must not reload a tab');
  assert.equal(await getMarker(long),'dashboard-old','keep an open page intact');
  for (const route of ['/dashboard','/','/index.html']) {
    await second.goto(url+route);
    assert.equal(await getMarker(second),'dashboard-fixed',route);
  }

  revision=3;
  await second.goto(url+'/dashboard');
  assert.equal(await getMarker(second),'dashboard-next-release','online route ignores cached index');
  const api=await second.goto(url+'/api/example');
  assert.equal(await api.text(),'api response');
  assert.equal(api.fromServiceWorker(),false);
  await ctx.setOffline(true);
  await second.goto(url+'/dashboard', {waitUntil:'domcontentloaded'});
  assert.equal(await getMarker(second),'dashboard-fixed','offline uses precached shell');
  const offlineApi=await second.goto(url+'/api/example').catch(()=>null);
  assert.equal(offlineApi,null,'offline API must not return shell');
  console.log('PASS: old worker reproduced; fixed worker takes control without reloading forms; /dashboard / /index.html use network; offline-only fallback; API bypass.');
} finally { await browser.close();server.close(); }
