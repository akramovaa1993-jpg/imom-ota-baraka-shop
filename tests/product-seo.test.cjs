const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function fixture(p){
 const ctx={readDb:()=>({productReviews:[]}),productBySlug:()=>p,publicProductWithPromotion:(_,p)=>p,productSlug:()=> 'test-1',productCategory:()=>({name:{uz:'Tovar',ru:'Товар'}}),reviewSummary:()=>({count:0,average:0}),htmlEsc:v=>String(v).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),clean:(v,n)=>String(v??'').replace(/[<>]/g,'').trim().slice(0,n),isAdminImageProxy:()=>false};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function productDescription('),source.indexOf("app.get('/robots.txt'")),ctx);
 vm.runInContext(source.slice(source.indexOf('function renderProductSeoPage('),source.indexOf("app.get('/mahsulot/:slug'")),ctx);
 vm.runInContext(source.slice(source.indexOf('function sanitizeCatalogProduct('),source.indexOf('// V13.26.60')),ctx);
 return ctx;
}
const product={id:1,name:{uz:'Perfetto sovun',ru:'Мыло Perfetto'},price:12000,stock:5,image:'https://zarbuloq.uz/test.jpg'};
test('brand is exact, explicit brands win, ambiguous and unknown brands are omitted',()=>{
 const c=fixture(product);assert.equal(c.productBrand(product),'Perfetto');
 assert.equal(c.productBrand({...product,brand:'Other brand'}),'Other brand');
 assert.equal(c.productBrand({name:{uz:'Mol go‘shti'}}),'');
 assert.equal(c.productBrand({name:{uz:'NotPerfetto soap'}}),'');
 assert.equal(c.productBrand({name:{uz:'SANNI Perfetto'}}),'');
});
test('admin catalog merge retains a brand when old clients omit it and permits clearing',()=>{
 const c=fixture(product),old={...product,brand:'SANNI'};
 assert.equal(c.sanitizeCatalogProduct({id:1},old).brand,'SANNI');
 assert.equal(c.sanitizeCatalogProduct({id:1,brand:''},old).brand,'');
 assert.equal(c.sanitizeCatalogProduct({id:1,brand:'<ELMA>'},old).brand,'ELMA');
});
test('UZ and RU pages match price, stock, brand and visible local delivery without invented returns',()=>{
 for(const lang of ['uz','ru'])for(const p of [product,{...product,stock:0,name:{uz:'Mol go‘shti',ru:'Мясо'}}]){
  const c=fixture(p);let html='';c.renderProductSeoPage({params:{slug:'test-1'}},{setHeader(){},send:s=>html=s},lang);
  const schema=JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(schema.offers.price,12000);assert.equal(schema.offers.priceCurrency,'UZS');
  assert.equal(schema.offers.availability.endsWith('InStock'),p.stock>0);
  assert.equal(schema.offers.seller.name,'IMOM OTA BARAKA');assert.equal(schema.brand?.name,c.productBrand(p)||undefined);
  assert.equal(schema.offers.areaServed.name,'Parkent tumani');assert.equal(schema.offers.shippingDetails,undefined);assert.equal(schema.offers.hasMerchantReturnPolicy,undefined);
  assert(html.includes('100 000'));assert(html.includes(lang==='ru'?'в течение 1 дня':'1 kun ichida'));
  if(lang==='ru')assert(schema.description.includes('Цена'));
 }
});
