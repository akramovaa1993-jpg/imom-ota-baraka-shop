const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
(async()=>{
 const elements={};
 for(const key of ['name','phone','area','address','payment','lat','lng','accuracy','locationMethod'])elements[key]={value:'',willValidate:!['lat','lng','accuracy','locationMethod'].includes(key),get validity(){return {valid:!!this.value&&!this.error}},setCustomValidity(e){this.error=e}};
 elements[Symbol.iterator]=function*(){yield* Object.values(this)};
 const form={elements},els={'#checkoutForm':form,'#orderSubmit':{style:{}},'#locationStatus':{},'#checkoutPointText':{},'#confirmCheckoutLocation':{},'#nameError':{},'#phoneError':{},'#locationMapBox':{}};
 const ctx={lang:'uz',orderSubmitting:false,$:s=>els[s],window:{},document:{},navigator:{},setTimeout,console,fetch:async()=>({ok:true,json:async()=>({inside:true})}),L:{marker:()=>({addTo(){return this},on(){return this},setLatLng(){return this}})}};
 vm.createContext(ctx);const client=fs.readFileSync(path.join(root,'script.js'),'utf8');vm.runInContext(client.slice(client.indexOf('// Checkout location has'),client.indexOf('function receiptPaymentText')),ctx);
 const run=s=>vm.runInContext(s,ctx);
 assert.equal(run('updateCheckoutValidity()'),false);
 Object.assign(elements.name,{value:'Akbarshoh Akramov'});elements.phone.value='+998 90 123 45 67';elements.area.value='Parkent';elements.address.value='Bog 10';elements.payment.value='Naqd';assert.equal(run('updateCheckoutValidity()'),false);
 run('chooseCheckoutPoint(41.294,69.676)');assert.equal(els['#orderSubmit'].disabled,true);
 await run('confirmCheckoutPoint()');assert.equal(els['#orderSubmit'].disabled,false);
 elements.name.value='Akbarshoh';assert.equal(run('updateCheckoutValidity()'),false);elements.name.value='Akbarshoh Akramov';elements.phone.value='123';assert.equal(run('updateCheckoutValidity()'),false);elements.phone.value='901234567';assert.equal(run('updateCheckoutValidity()'),true);
 elements.payment.value='';assert.equal(run('updateCheckoutValidity()'),false);elements.payment.value='Naqd';
 run('chooseCheckoutPoint(41.3,69.7)');assert.equal(els['#orderSubmit'].disabled,true);
 ctx.fetch=async()=>({ok:true,json:async()=>({inside:false})});await run('confirmCheckoutPoint()');assert.equal(els['#orderSubmit'].disabled,true);
 let finish;ctx.fetch=()=>new Promise(resolve=>finish=()=>resolve({ok:true,json:async()=>({inside:true})}));const pending=run('confirmCheckoutPoint()');run('chooseCheckoutPoint(41.32,69.71)');finish();await pending;assert.equal(els['#orderSubmit'].disabled,true);assert.equal(elements.lat.value,'');
 ctx.fetch=async()=>({ok:true,json:async()=>({inside:true})});await run('confirmCheckoutPoint()');assert.equal(els['#orderSubmit'].disabled,false);run('disposeCheckoutLocation()');assert.equal(run('updateCheckoutValidity()'),false);
 console.log('PASS client state: required fields, full name, phone, explicit confirmation, move resets confirmation, outside Parkent, stale response, close reset.');
 let route;const server=fs.readFileSync(path.join(root,'server.js'),'utf8');const serverContext={app:{post:(path,limiter,handler)=>route=handler},publicWriteLimiter(){},readDb:()=>({settings:{delivery:{areas:['Parkent']}},products:[]}),clean:(s,n)=>String(s??'').trim().slice(0,n),checkParkentLocation:async(lat)=>lat===41.294,console};vm.createContext(serverContext);vm.runInContext(server.slice(server.indexOf("app.post('/api/orders',"),server.indexOf('\nasync function updateOrderStatus')),serverContext);
 const good={source:'web',customer:{name:'Akbarshoh Akramov',phone:'+998 90 123 45 67',address:'Bog 10',area:'Parkent',payment:'Naqd',lat:41.294,lng:69.676,locationMethod:'map',locationConfirmed:true},items:[{id:1,qty:1}]};
 async function check(change,expected){let result,status=200;const b=structuredClone(good);Object.assign(b.customer,change);await route({body:b},{status(n){status=n;return this},json(d){result=d;return this}});assert.equal(status,400);assert(result.error.includes(expected),JSON.stringify(result));}
 await check({name:'Akbarshoh'},'Ism');await check({phone:'123'},'Telefon');await check({payment:'unknown'},'To‘lov');await check({locationConfirmed:false},'tasdiqlang');await check({lat:''},'lokatsiya');await check({lat:0},'tashqarida');await check({},'Mahsulot topilmadi');
 console.log('PASS server: name, phone, payment, confirmation, missing location, outside Parkent, map passes location gate without GPS. Database and map provider mocked.');
})().catch(e=>{console.error(e);process.exit(1)});
