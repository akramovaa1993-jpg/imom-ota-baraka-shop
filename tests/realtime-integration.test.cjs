const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function website(load){
 const listeners={},ctx={Date,console,setTimeout,clearTimeout,window:{EventSource:true,addEventListener(){}},document:{addEventListener(){}},EventSource:class {addEventListener(k,f){listeners[k]=f}},loadCatalog:load,loadSiteChat(){},lastTrackQuery:null,$:()=>null};
 vm.createContext(ctx);const s=read('script.js');vm.runInContext(s.slice(s.indexOf('let realtimeSource='),s.indexOf("document.addEventListener('keydown',e=>{if(e.key==='Escape')")),ctx);ctx.initRealtime();return {ctx,listeners};
}
test('website reconnect refreshes the catalog and retains an update received while loading',async()=>{
 const releases=[];let calls=0;const f=website(()=>{calls++;return new Promise(r=>releases.push(r))});
 f.listeners.ready();assert.equal(calls,1);f.ctx.refreshRealtimeStore();f.ctx.refreshRealtimeStore();assert.equal(calls,1);
 releases.shift()();await tick();assert.equal(calls,2);releases.shift()();await tick();assert.equal(calls,2);
 f.listeners.ready();assert.equal(calls,3);releases.shift()();await tick();
});
test('admin defers reconnect while editing and retains changes arriving during refresh',async()=>{
 let editing=true,calls=0,release;const timers=[],listeners={};const ctx={console,me:{role:'admin'},document:{hidden:false,activeElement:{tagName:'INPUT'},querySelector:()=>null,getElementById:()=>null,addEventListener(){}},window:{EventSource:true,addEventListener(){}},EventSource:class {addEventListener(k,f){listeners[k]=f}},setTimeout:f=>{timers.push(f);return timers.length},clearTimeout(){},setInterval(){},refresh:()=>{calls++;return new Promise(r=>release=r)},renderLogin(){}};
 vm.createContext(ctx);let s=read('admin.html');vm.runInContext(s.slice(s.indexOf('let adminRealtimeSource='),s.indexOf('async function api(')),ctx);
 ctx.initAdminRealtime();listeners.ready();timers.shift()();assert.equal(calls,0);
 ctx.document.activeElement.tagName='BODY';ctx.realtimeAdminRefresh();assert.equal(calls,1);ctx.realtimeAdminRefresh();release();await tick();assert.equal(timers.length,1);timers.shift()();assert.equal(calls,2);release();await tick();
});
test('slow or malformed catalog responses cannot replace a newer valid catalog',async()=>{
 const pending=[],ctx={console,Date,URLSearchParams,location:{search:''},products:[{id:9}],categories:[],settings:{},logo:'',fetch:()=>new Promise(r=>pending.push(r)),$:()=>null,applySite(){},renderAll(){},initParkentBoundaryMap(){},setTimeout(){},updateCatalogMeta(){}};
 vm.createContext(ctx);const s=read('script.js');vm.runInContext(s.slice(s.indexOf('let catalogLoadGeneration='),s.indexOf('function applySite()')),ctx);
 const a=ctx.loadCatalog(),b=ctx.loadCatalog();pending[1]({ok:true,json:async()=>({products:[{id:2}],categories:[]})});await b;pending[0]({ok:true,json:async()=>({products:[{id:1}],categories:[]})});await a;assert.equal(ctx.products[0].id,2);
 const c=ctx.loadCatalog();pending[2]({ok:true,json:async()=>({error:'bad'})});await c;assert.equal(ctx.products[0].id,2);
});
test('Android reconnect signal also repairs catalogs in previously installed clients',()=>{
 const routes={},ctx={app:{get:(p,...args)=>routes[p]=args.at(-1)},sseLimit(){},appRealtimeRevision:7,appRealtimeClients:new Set(),setInterval(){},clearInterval(){}};vm.createContext(ctx);const s=read('server.js');vm.runInContext(s.slice(s.indexOf("app.get('/api/app-events'"),s.indexOf("app.get('/api/app-realtime/health'")),ctx);
 let message='';routes['/api/app-events']({on(){}},{setHeader(){},write:v=>message+=v});const payload=JSON.parse(message.split('data: ')[1]);assert.equal(payload.reason,'catalog-reconnect');assert.equal(payload.revision,7);
});
