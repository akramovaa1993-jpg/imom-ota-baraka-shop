const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const admin=fs.readFileSync(path.join(__dirname,'../admin.html'),'utf8');
function editor(api){
 const buttons=[{disabled:false}],alerts=[];let closed=0,synced=0;
 const ctx={document:{querySelectorAll:()=>buttons},api,console:{error(){}},alert:m=>alerts.push(m),showAdminToast(){},closeProductEditor(){closed++},syncAdminProducts:async()=>{synced++}};
 vm.createContext(ctx);vm.runInContext(admin.slice(admin.indexOf('let productSaveBusy='),admin.indexOf('function productRow(')),ctx);
 return {ctx,buttons,alerts,closed:()=>closed,synced:()=>synced};
}
test('editor saves only the selected product and does not overwrite inventory stock',async()=>{
 let body;const f=editor(async(u,o)=>body=JSON.parse(o.body));
 await f.ctx.saveProductsDirect({id:2,name:{uz:'A'},stock:7,receivedQty:7,legacyOpeningQty:4,image:'data:image/webp;base64,YQ==',siteImage:'unused'},false);
 assert.equal(body.products.length,1);assert.equal(body.products[0].id,2);
 assert.equal(body.products[0].stock,undefined);assert.equal(body.products[0].receivedQty,undefined);
 assert.equal(body.products[0].siteImage,undefined);assert.equal(body.products[0].image,'data:image/webp;base64,YQ==');assert.equal(f.closed(),1);
 await f.ctx.saveProductsDirect({id:3,stock:9,receivedQty:9},true);assert.equal(body.products[0].stock,9);
});
test('double click has one request; 502 retains editor and allows retry',async()=>{
 let release,calls=0;const f=editor(()=>{calls++;return new Promise((resolve,reject)=>release={resolve,reject})});
 const first=f.ctx.saveProductsDirect({id:1});await f.ctx.saveProductsDirect({id:1});assert.equal(calls,1);assert.equal(f.buttons[0].disabled,true);
 release.reject(Object.assign(new Error('502'),{status:502}));await first;
 assert.equal(f.closed(),0);assert.equal(f.synced(),0);assert.equal(f.buttons[0].disabled,false);assert.match(f.alerts[0],/oynada saqlandi/);
 const retry=f.ctx.saveProductsDirect({id:1});release.resolve({ok:true});await retry;assert.equal(calls,2);assert.equal(f.closed(),1);
});
test('product guard copies nested metadata without JSON serialization of images',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function cloneProductSafe('),source.indexOf('function rememberCommittedProducts(')),ctx);
 const p={id:1,image:'data:image/webp;base64,'+'a'.repeat(2_000_000),name:{uz:'A'},seo:{title:{uz:'Title'}},tags:[{name:'tag'}]};
 vm.runInContext('JSON.stringify=()=>{throw Error("large serialization forbidden")}',ctx);
 const copy=ctx.cloneProductSafe(p);p.name.uz='B';p.seo.title.uz='Other';p.tags[0].name='changed';
 assert.equal(copy.image,p.image);assert.equal(copy.name.uz,'A');assert.equal(copy.seo.title.uz,'Title');assert.equal(copy.tags[0].name,'tag');
});
test('durable write reuses the same serialized snapshot for disk and PostgreSQL',async()=>{
 let remote,disk;const ctx={normalizeDb:x=>x,committedProducts:new Map(),pool:{},persistChain:Promise.resolve(),persistRemote:async s=>remote=s,writeLocal:(db,s)=>disk=s,rememberCommittedProducts(){},broadcastRealtime(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function writeDb('),source.indexOf('async function initStorage(')),ctx);
 await ctx.writeDb({products:[{id:1,image:'large-image'}]});assert.equal(disk,remote);assert.equal(JSON.parse(disk).products[0].id,1);
});
test('all inline admin scripts parse',()=>{
 for(const m of admin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
});
