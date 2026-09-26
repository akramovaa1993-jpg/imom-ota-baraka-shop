const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');

function assert(ok,msg){if(!ok)throw new Error(msg)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(url,tries=80){
 let last='';
 for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.ok)return r}catch(e){last=String(e)}await sleep(400)}
 throw new Error('Server start timeout: '+last);
}

async function main(){
 const dataDir='/tmp/zarbuloq-order-idempotency';
 fs.rmSync(dataDir,{recursive:true,force:true});fs.mkdirSync(dataDir,{recursive:true});
 const token='audit-token',deviceId='android-audit-device',phone='998901234567';
 const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
 fs.writeFileSync(path.join(dataDir,'shop.json'),JSON.stringify({
   orders:[],
   phoneVerifications:[{
     id:'PV-AUDIT',tokenHash,phone,deviceId,status:'verified',
     createdAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),
     expiresAt:new Date(Date.now()+60*60*1000).toISOString()
   }]
 },null,2));
 const child=spawn(process.execPath,['server.js'],{
   cwd:path.join(__dirname,'..'),
   env:{...process.env,PORT:'3124',DATA_DIR:dataDir,REQUIRE_DATABASE:'false',DATABASE_URL:'',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',SESSION_SECRET:'audit-secret',ADMIN_PASSWORD:'audit-admin-pass'},
   stdio:['ignore','pipe','pipe']
 });
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
   await waitFor('http://127.0.0.1:3124/api/status');
   let r=await fetch('http://127.0.0.1:3124/api/catalog');const catalog=await r.json();
   assert(r.ok&&catalog.ok===true,'Catalog metadata missing');
   assert(catalog.catalogMeta&&catalog.catalogMeta.schema===1,'Catalog schema marker missing');
   assert(catalog.catalogMeta.productCount===catalog.products.length,'Catalog count mismatch');

   const body={
     source:'app',deviceId,clientRequestId:'audit-request-0001',phoneVerificationToken:token,language:'uz',
     customer:{name:'Audit User',phone:'+998 90 123 45 67',address:'Parkent test',area:'Parkent shahri',payment:'Naqd',comment:'',lat:41.2946,lng:69.6764,accuracy:10,locationMethod:'manual'},
     items:[{id:3,qty:1,price:125000}],promoCode:''
   };
   const post=()=>fetch('http://127.0.0.1:3124/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   r=await post();const first=await r.json();
   assert(r.ok,'First order failed '+r.status+' '+JSON.stringify(first));
   assert(first.orderId,'First order id missing');

   r=await post();const second=await r.json();
   assert(r.ok,'Replay order failed '+r.status+' '+JSON.stringify(second));
   assert(second.replayed===true,'Second response was not marked replayed');
   assert(second.orderId===first.orderId,'Replay created a different order id');

   const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'shop.json'),'utf8'));
   const rows=(saved.orders||[]).filter(o=>o.clientRequestId==='audit-request-0001'&&o.customerDeviceId===deviceId);
   assert(rows.length===1,'Expected exactly one persisted order, got '+rows.length);
   console.log('ORDER IDEMPOTENCY TEST: PASS',first.orderId);
 }finally{
   child.kill('SIGTERM');
   await Promise.race([new Promise(r=>child.once('exit',r)),sleep(2000)]);
   if(child.exitCode===null)child.kill('SIGKILL');
   if(process.exitCode)console.error(logs);
 }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
