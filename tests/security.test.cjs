const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {spawn}=require('node:child_process');
const {publicIp,totp}=require('../security');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zarbuloq-security-')),port=3136,base=`http://127.0.0.1:${port}`;
let child,logs='',adminCookie,clientToken;
const phone='998901234567',proof='test-verified-proof',device='verified-device';
async function request(url,body,headers={},method=body?'POST':'GET'){
 const r=await fetch(base+url,{method,headers:{origin:base,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}return {status:r.status,data,headers:r.headers};
}
async function start(){
 child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(port),DATA_DIR:dir,DATABASE_URL:'',REQUIRE_DATABASE:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',SESSION_SECRET:'a'.repeat(64),ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'safe-test-password',STOCK_USERNAME:'stock',STOCK_PASSWORD:'stock-password',OPERATOR_USERNAME:'operator',OPERATOR_PASSWORD:'operator-password'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 for(let i=0;i<60;i++){try{if((await fetch(base+'/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error(logs);
}
async function stop(){if(child){child.kill();await new Promise(r=>child.once('exit',r));child=null}}
before(async()=>{
 fs.writeFileSync(path.join(dir,'shop.json'),JSON.stringify({orders:[{orderId:'OWNED-LEGACY',status:'delivered',createdAt:new Date().toISOString(),customer:{name:'Test Customer',phone,address:'PRIVATE ADDRESS'},items:[],total:100000}],chats:[{sessionId:'old-chat',phone,name:'Private',messages:[{text:'Private message'}]}],phoneVerifications:[{id:'PV-test',tokenHash:crypto.createHash('sha256').update(proof).digest('hex'),phone,deviceId:device,status:'verified',expiresAt:new Date(Date.now()+86400000).toISOString()}]}));await start();
});
after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true})});

test('all sensitive static paths and encoded aliases are blocked; assets and headers work',async()=>{
 for(const p of ['/server.js','/security.js','/public-assets.json','/package.json','/package-lock.json','/.env','/data/shop.json','/security-state.json','/tests/security.test.cjs','/%73erver.js','/scripts/order-idempotency-test.js'])assert.equal((await request(p)).status,404,p);
 const home=await request('/');assert.equal(home.status,200);assert.equal(home.headers.get('x-powered-by'),null);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);

 assert.match(home.data,/data-server-catalog="true"/);
 assert.match(home.data,/href="\/mahsulot\/premium-guruch-1"/);
 assert.match(home.data,/Premium guruch/);
 assert.ok(!home.data.includes('Mahsulotlar yuklanmoqda...'));
 const sitemap=await request('/sitemap.xml');assert.equal(sitemap.status,200);assert.match(sitemap.headers.get('content-type'),/application\/xml/);assert.match(sitemap.data,/https:\/\/zarbuloq.uz\/mahsulot\/premium-guruch-1/);
 const detail=await request('/mahsulot/premium-guruch-1');assert.equal(detail.status,200);assert.match(detail.data,/Premium guruch/);
 assert.equal((await request('/api/image-proxy')).headers.get('x-frame-options'),'DENY');
 assert.equal((await request('/api/status')).data.dataFile,undefined);
});
test('every order alias and both completion routes require ownership',async()=>{
 for(const p of ['/api/orders/OWNED-LEGACY','/api/order/OWNED-LEGACY','/api/order-status/OWNED-LEGACY','/api/orders/status?orderId=OWNED-LEGACY'])assert.equal((await request(p)).status,403,p);
 for(const p of ['complete','confirm-delivery','complaints'])assert.equal((await request('/api/orders/OWNED-LEGACY/'+p,{phone,deviceId:device,message:'forged'})).status,403);
 const headers={'X-Phone-Verification':proof,'X-Device-Id':device};assert.equal((await request('/api/orders/OWNED-LEGACY',null,headers)).status,200);
 assert.equal((await request('/api/orders/OWNED-LEGACY/confirm-delivery',{},headers)).status,200);
 const track=await request('/api/track/OWNED-LEGACY?phone='+phone);assert.equal(track.data.limited,true);assert.equal(track.data.address,undefined);assert.deepEqual(track.data.items,[]);
});
test('legacy chat cannot be claimed, new chat requires signed owner credential',async()=>{
 assert.equal((await request('/api/chat/old-chat')).status,403);
 assert.equal((await request('/api/chat/send',{sessionId:'old-chat',name:'Test user',phone,message:'forged'})).status,403);
 const c=await request('/api/client-session',{});clientToken=c.data.clientToken;assert.ok(clientToken);
 const headers={'X-Client-Token':clientToken};assert.equal((await request('/api/chat/send',{sessionId:'new-chat',name:'Test user',phone,message:'hello'},headers)).status,200);
 assert.equal((await request('/api/chat/new-chat')).status,403);
 assert.equal((await request('/api/chat/new-chat',null,headers)).status,200);
 assert.equal((await request('/api/chat/new-chat',null,{'X-Client-Token':clientToken+'x'})).status,403);
});
test('admin role isolation and strict cross-origin requests',async()=>{
 assert.equal((await request('/api/admin/products')).status,401);
 assert.equal((await request('/api/admin/login',{username:'owner',password:'safe-test-password'},{origin:'https://evil.example','sec-fetch-site':'same-site'})).status,403);
 const r=await request('/api/admin/login',{username:'stock',password:'stock-password'});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
 assert.equal((await request('/api/admin/products',null,{cookie})).status,200);
 const dash=await request('/api/admin/dashboard',null,{cookie});assert.equal(dash.status,200);assert.deepEqual(dash.data.orders,[]);assert.equal(dash.data.financeQuick,undefined);assert.equal(dash.data.visits,undefined);
 for(const p of ['/api/admin/backup.json','/api/admin/finance','/api/admin/security'])assert.equal((await request(p,null,{cookie})).status,403,p);
 assert.equal((await request('/api/admin/restore',{products:[],orders:[]},{cookie})).status,403);
 const owner=await request('/api/admin/login',{username:'owner',password:'safe-test-password'});adminCookie=owner.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/admin/me',null,{cookie:adminCookie})).status,200);
});
test('upgraded spreadsheet library round-trips the real import template',async()=>{
 const r=await fetch(base+'/api/admin/products-import-template',{headers:{cookie:adminCookie}});assert.equal(r.status,200);
 const b=Buffer.from(await r.arrayBuffer()),XLSX=require('xlsx'),wb=XLSX.read(b,{type:'buffer'});assert.equal(wb.SheetNames.length,2);
 const preview=await fetch(base+'/api/admin/products-import-preview',{method:'POST',headers:{cookie:adminCookie,origin:base,'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},body:b});assert.equal(preview.status,200);const data=await preview.json();assert.equal(data.count,2);assert.equal(data.errors,0);
});
test('sessions and client ownership survive restart; logout revokes copied cookie',async()=>{
 await stop();await start();assert.equal((await request('/api/admin/me',null,{cookie:adminCookie})).status,200);
 assert.equal((await request('/api/chat/new-chat',null,{'X-Client-Token':clientToken})).status,200);
 assert.equal((await request('/api/admin/logout',{}, {cookie:adminCookie})).status,200);
 assert.equal((await request('/api/admin/me',null,{cookie:adminCookie})).status,401);
});
test('MFA activates only after correct code; replay and wrong code are rejected',async()=>{
 const owner=await request('/api/admin/login',{username:'owner',password:'safe-test-password'});adminCookie=owner.headers.get('set-cookie').split(';')[0];const headers={cookie:adminCookie};
 const setup=await request('/api/admin/security/mfa/setup',{password:'safe-test-password'},headers);assert.equal(setup.status,200);
 assert.equal((await request('/api/admin/security/mfa/confirm',{otp:'wrong'},headers)).status,400);
 const activated=await request('/api/admin/security/mfa/confirm',{otp:totp(setup.data.secret)},headers);assert.equal(activated.status,200);assert.equal(activated.data.recoveryCodes.length,8);
 assert.equal((await request('/api/admin/login',{username:'owner',password:'safe-test-password'})).status,401);
 const first=await request('/api/admin/login',{username:'owner',password:'safe-test-password',otp:totp(setup.data.secret)});assert.equal(first.status,200);
 assert.equal((await request('/api/admin/login',{username:'owner',password:'safe-test-password',otp:totp(setup.data.secret)})).status,401);
});
test('chunked JSON cannot bypass actual-byte body limit',async()=>{
 const status=await new Promise((resolve,reject)=>{const r=http.request(base+'/api/visit',{method:'POST',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked',Origin:base}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',reject);r.write(JSON.stringify({x:'a'.repeat(70000)}));r.end()});assert.equal(status,413);
});
test('SSRF validator covers mapped IPv6, loopback, private and public IPs',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','::1','::ffff:7f00:1','::ffff:ac10:1','fc00::1','fe80::1','0.0.0.0','224.0.0.1'])assert.equal(publicIp(ip),false,ip);
 assert.equal(publicIp('8.8.8.8'),true);assert.equal(publicIp('2606:4700:4700::1111'),true);
});
