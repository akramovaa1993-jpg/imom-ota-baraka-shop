const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
const DB_FILE = path.join(DATA_DIR,'shop.json');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const DATABASE_SSL = String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false';
const pool = DATABASE_URL ? new Pool({connectionString:DATABASE_URL,ssl:DATABASE_SSL?{rejectUnauthorized:false}:false,max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:10000}) : null;
let dbCache = null;
let persistChain = Promise.resolve();

// V13.15 SEO + REALTIME — Server-Sent Events (SSE)
// Only a tiny change signal is broadcast. Clients fetch fresh data through normal APIs.
const realtimeClients = new Set();
let realtimeRevision = 0;
function broadcastRealtime(reason='data'){
  realtimeRevision += 1;
  const payload = `event: update\ndata: ${JSON.stringify({reason,revision:realtimeRevision,at:new Date().toISOString()})}\n\n`;
  for(const res of [...realtimeClients]){
    try{res.write(payload)}catch{realtimeClients.delete(res)}
  }
}

const USERS = [
  {username:process.env.ADMIN_USERNAME || 'admin', password:process.env.ADMIN_PASSWORD || 'change-me', role:'admin'},
  ...(process.env.OPERATOR_USERNAME && process.env.OPERATOR_PASSWORD ? [{username:process.env.OPERATOR_USERNAME,password:process.env.OPERATOR_PASSWORD,role:'operator'}] : []),
  ...(process.env.STOCK_USERNAME && process.env.STOCK_PASSWORD ? [{username:process.env.STOCK_USERNAME,password:process.env.STOCK_PASSWORD,role:'stock'}] : [])
];

app.use(express.json({limit:'12mb'}));

// V13.16 PRODUCT SEO — har bir mahsulot uchun Google indekslaydigan alohida sahifa.
function seoSlug(value=''){
  return String(value||'')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[ʻʼ‘’`´']/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0,90) || 'mahsulot';
}
function productSlug(p,lang='uz'){return `${seoSlug(p?.name?.[lang] || p?.name?.uz || p?.name?.ru || 'mahsulot')}-${Number(p?.id)||0}`;}
function htmlEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function xmlEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function productBySlug(db,slug){
  const idMatch=String(slug||'').match(/-(\d+)$/);
  if(idMatch){
    const p=(db.products||[]).find(x=>Number(x.id)===Number(idMatch[1]));
    if(p)return p;
  }
  return (db.products||[]).find(p=>productSlug(p)===String(slug||''));
}
function productCategory(db,p){return (db.categories||[]).find(c=>String(c.id)===String(p?.cat)) || {name:{uz:'Mahsulot'}};}
function productDescription(db,p){
  const cat=productCategory(db,p)?.name?.uz || 'mahsulot';
  const name=p?.name?.uz || 'Mahsulot';
  const stock=Number(p?.stock||0)>0?'sotuvda mavjud':'hozircha omborda yo‘q';
  return `${name} — ${cat}. Narxi ${Number(p?.price||0).toLocaleString('ru-RU')} so‘m. ${stock}. Parkent tumani bo‘ylab bepul yetkazib berish. ZARBULOQ.UZ internet do‘koni.`;
}
function productImageUrl(p){
  const img=String(p?.image||'');
  if(!img)return 'https://zarbuloq.uz/logo.png';
  if(/^data:image\//i.test(img))return `https://zarbuloq.uz/mahsulot-rasm/${Number(p.id)}`;
  if(/^https?:\/\//i.test(img))return img;
  return `https://zarbuloq.uz/${img.replace(/^\/+/, '')}`;
}

app.get('/sitemap.xml',(req,res)=>{
  const db=readDb();
  const urls=[
    `<url><loc>https://zarbuloq.uz/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...(db.products||[]).flatMap(p=>[`<url><loc>${xmlEsc(`https://zarbuloq.uz/mahsulot/${productSlug(p,'uz')}`)}</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,`<url><loc>${xmlEsc(`https://zarbuloq.uz/ru/mahsulot/${productSlug(p,'ru')}`)}</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`])
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

app.get('/mahsulot-rasm/:id',(req,res)=>{
  const db=readDb();
  const p=(db.products||[]).find(x=>Number(x.id)===Number(req.params.id));
  if(!p)return res.status(404).end();
  const img=String(p.image||'');
  const m=img.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i);
  if(!m)return res.redirect(302,'/logo.png');
  try{
    const mime=m[1].toLowerCase()==='image/jpg'?'image/jpeg':m[1].toLowerCase();
    const buf=Buffer.from(m[2],'base64');
    res.setHeader('Content-Type',mime);
    res.setHeader('Cache-Control','public, max-age=86400');
    res.send(buf);
  }catch{return res.status(404).end();}
});

function renderProductSeoPage(req,res,lang='uz'){
  const db=readDb(),p=productBySlug(db,req.params.slug);if(!p)return res.status(404).send('Mahsulot topilmadi');
  const canonicalSlug=productSlug(p,lang),prefix=lang==='ru'?'/ru/mahsulot/':'/mahsulot/';if(req.params.slug!==canonicalSlug)return res.redirect(301,prefix+canonicalSlug);
  const isRu=lang==='ru',name=p.name?.[lang]||p.name?.uz||'Mahsulot',catObj=productCategory(db,p),cat=catObj?.name?.[lang]||catObj?.name?.uz||(isRu?'Товар':'Mahsulot');
  const customDesc=p.description?.[lang]||p.description?.uz||'',desc=customDesc||productDescription(db,p),img=productImageUrl(p),price=Number(p.price||0),old=Number(p.oldPrice||0),stock=Number(p.stock||0),unit=p.unit?.[lang]||p.unit?.uz||'';
  const url=`https://zarbuloq.uz${prefix}${canonicalSlug}`,altLang=lang==='ru'?'uz':'ru',altPrefix=altLang==='ru'?'/ru/mahsulot/':'/mahsulot/',altUrl=`https://zarbuloq.uz${altPrefix}${productSlug(p,altLang)}`;
  const title=isRu?`${name} — цена | ZARBULOQ.UZ`:`${name} narxi | ZARBULOQ.UZ`,stockText=stock>0?(isRu?`В наличии: ${stock}${unit?' '+unit:''}`:`Omborda: ${stock}${unit?' '+unit:''}`):(isRu?'Нет в наличии':'Omborda yo‘q');
  const schema={'@context':'https://schema.org','@type':'Product',name,alternateName:[p.name?.uz,p.name?.ru].filter(Boolean),description:desc,image:[img],category:cat,brand:{'@type':'Brand',name:'IMOM OTA BARAKA'},offers:{'@type':'Offer',url,priceCurrency:'UZS',price,availability:stock>0?'https://schema.org/InStock':'https://schema.org/OutOfStock',seller:{'@type':'Organization',name:'IMOM OTA BARAKA'}}};
  const oldPrice=old>price?`<span class="old">${old.toLocaleString('ru-RU')} ${isRu?'сум':'so‘m'}</span>`:'';
  res.send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEsc(title)}</title><meta name="description" content="${htmlEsc(desc)}"><meta name="keywords" content="${htmlEsc([p.name?.uz,p.name?.ru,catObj?.name?.uz,catObj?.name?.ru,'ZARBULOQ.UZ','Parkent'].filter(Boolean).join(', '))}"><link rel="canonical" href="${htmlEsc(url)}"><link rel="alternate" hreflang="${altLang}" href="${htmlEsc(altUrl)}"><link rel="alternate" hreflang="${lang}" href="${htmlEsc(url)}"><meta property="og:type" content="product"><meta property="og:title" content="${htmlEsc(name)} — ZARBULOQ.UZ"><meta property="og:description" content="${htmlEsc(desc)}"><meta property="og:url" content="${htmlEsc(url)}"><meta property="og:image" content="${htmlEsc(img)}"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f5faf5;color:#17351f}.wrap{max-width:1100px;margin:auto;padding:22px}.top{display:flex;align-items:center;gap:14px;margin-bottom:24px}.top img{width:58px;height:58px;object-fit:contain}.top a{text-decoration:none;color:#17351f}.card{display:grid;grid-template-columns:minmax(280px,1fr) minmax(300px,1fr);gap:34px;background:#fff;border-radius:24px;padding:28px;box-shadow:0 12px 40px #17351f12}.media{min-height:420px;display:flex;align-items:center;justify-content:center;background:#f3f7f3;border-radius:18px;overflow:hidden}.media img{max-width:100%;max-height:480px;object-fit:contain}.cat{color:#2a7b3f;font-weight:700}.price{font-size:32px;font-weight:800;margin:16px 0}.old{text-decoration:line-through;color:#888;font-size:16px;margin-right:10px}.stock{display:inline-block;padding:8px 12px;border-radius:999px;background:#eaf6ec}.desc{line-height:1.65;color:#48604e}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}.btn{border:0;border-radius:12px;padding:14px 20px;font-weight:700;cursor:pointer;text-decoration:none}.primary{background:#1f6b35;color:white}.secondary{background:#edf5ee;color:#17351f}@media(max-width:760px){.card{grid-template-columns:1fr;padding:18px}.media{min-height:300px}.price{font-size:27px}}</style></head><body><main class="wrap"><header class="top"><a href="/"><img src="/logo.png" alt="IMOM OTA BARAKA"></a><div><a href="/"><b>ZARBULOQ.UZ</b></a><div>${isRu?'Интернет-магазин IMOM OTA BARAKA':'IMOM OTA BARAKA internet do‘koni'}</div></div></header><section class="card"><div class="media"><img src="${htmlEsc(img)}" alt="${htmlEsc(name)}" loading="eager"></div><div><div class="cat">${htmlEsc(cat)}</div><h1>${htmlEsc(name)}</h1><p class="desc">${htmlEsc(desc)}</p><div class="price">${oldPrice}${price.toLocaleString('ru-RU')} ${isRu?'сум':'so‘m'}</div><div class="stock">${htmlEsc(stockText)}</div><div class="actions">${stock>0?`<button class="btn primary" onclick="addToCartAndOpen()">${isRu?'В корзину':'Savatga qo‘shish'}</button>`:''}<a class="btn secondary" href="/#products">${isRu?'Все товары':'Barcha mahsulotlar'}</a></div></div></section></main><script>function addToCartAndOpen(){try{const id=${JSON.stringify(Number(p.id))},stock=${JSON.stringify(stock)};let cart=JSON.parse(localStorage.getItem('iob_cart_v13')||'[]');let x=cart.find(a=>Number(a.id)===id);if(x){if(Number(x.qty)>=stock){alert('${isRu?'Максимальное количество уже в корзине.':'Ombordagi maksimal miqdor savatda.'}');return}x.qty=Number(x.qty||0)+1}else cart.push({id:id,qty:1});localStorage.setItem('iob_cart_v13',JSON.stringify(cart));window.location.href='/#products'}catch(e){window.location.href='/#products'}}</script></body></html>`);
}
app.get('/mahsulot/:slug',(req,res)=>renderProductSeoPage(req,res,'uz'));
app.get('/ru/mahsulot/:slug',(req,res)=>renderProductSeoPage(req,res,'ru'));

app.use(express.static(__dirname));

const defaultCategories=[
 {id:'food',icon:'🍎',name:{uz:'Oziq-ovqat',ru:'Продукты',en:'Food'}},
 {id:'home',icon:'🏠',name:{uz:'Uy uchun',ru:'Для дома',en:'Home'}},
 {id:'care',icon:'🧴',name:{uz:'Shaxsiy parvarish',ru:'Уход',en:'Personal care'}}
];
const defaultProducts=[
 {id:1,cat:'food',emoji:'🍚',name:{uz:'Premium guruch',ru:'Премиальный рис',en:'Premium rice'},price:45000,cost:35000,oldPrice:0,stock:25,image:'',badge:'TOP',featured:true},
 {id:2,cat:'food',emoji:'🍯',name:{uz:'Tabiiy asal',ru:'Натуральный мёд',en:'Natural honey'},price:78000,cost:59000,oldPrice:85000,stock:20,image:'',badge:'AKSIYA',featured:true},
 {id:3,cat:'food',emoji:'🫙',name:{uz:'Sof zaytun yog‘i',ru:'Оливковое масло',en:'Pure olive oil'},price:125000,cost:98000,oldPrice:0,stock:15,image:'',badge:'YANGI',featured:true},
 {id:4,cat:'home',emoji:'🧺',name:{uz:'Uy uchun to‘plam',ru:'Набор для дома',en:'Home essentials set'},price:99000,cost:72000,oldPrice:120000,stock:10,image:'',badge:'-18%',featured:false}
];
const defaultSettings={
 siteName:'IMOM OTA BARAKA',siteDomain:'zarbuloq.uz',theme:'original',
 tagline:{uz:'Sifat, ishonch, baraka!',ru:'Качество, доверие, баракат!',en:'Quality, trust, baraka!'},
 hero:{uz:{eyebrow:'SIFAT • ISHONCH • BARAKA',title:'Har bir xonadonga — sifat va baraka.',text:'Parkent tumani bo‘ylab bepul yetkazib berish, qulay buyurtma va ishonchli xizmat.'},ru:{eyebrow:'КАЧЕСТВО • ДОВЕРИЕ • БАРАКАТ',title:'Качество и баракат — в каждый дом.',text:'Бесплатная доставка по Паркентскому району, удобный заказ и надёжный сервис.'},en:{eyebrow:'QUALITY • TRUST • BARAKA',title:'Quality and baraka for every home.',text:'Free delivery across Parkent district, convenient ordering and reliable service.'}},
 catalog:{uz:'Mashhur mahsulotlar',ru:'Популярные товары',en:'Popular products'},
 about:{uz:{title:'IMOM OTA BARAKA — ishonchli tanlov.',text:'Biz mijozlarimizga sifatli mahsulot, shaffof xizmat, tezkor aloqa va qulay xarid tajribasini taqdim etamiz.'},ru:{title:'IMOM OTA BARAKA — надёжный выбор.',text:'Качественные товары, прозрачный сервис, быстрая связь и удобные покупки.'},en:{title:'IMOM OTA BARAKA — a trusted choice.',text:'Quality products, transparent service, fast communication and convenient shopping.'}},
 contact:{uz:{title:'Biz bilan bog‘laning',text:'Savol, taklif va buyurtmalar uchun Telegram yoki telefon orqali murojaat qiling.'},ru:{title:'Свяжитесь с нами',text:'По вопросам, предложениям и заказам свяжитесь через Telegram или по телефону.'},en:{title:'Contact us',text:'For questions, suggestions and orders, contact us via Telegram or phone.'}},
 company:{name:'“GANIYEV IMOM” OILAVIY KORXONA',taxId:'312669814',mfo:'00482',account:'20208000807368873001'},
 map:{eyebrow:'BEPUL YETKAZIB BERISH HUDUDI',title:'Yetkazib berish bepul hududlar',text:'Xaritada yashil rang va qizil chegara bilan ko‘rsatilgan Parkent tumani hududlarida yetkazib berish bepul. Buyurtma vaqtida manzilingizni tanlang yoki aniq GPS lokatsiyangizni yuboring.',embedUrl:'',openUrl:'https://www.openstreetmap.org/relation/5745823'},
 footer:{service1:'Parkent tumani — bepul',service2:'Naqd / karta / o‘tkazma',copyright:'© 2026 IMOM OTA BARAKA • ZARBULOQ.UZ'},
 ui:{logoSize:68},
 testMode:{active:true,text:'Saytimiz hozirda test rejimida ishlamoqda'},
 heroSlides:[{id:'slide-1',image:'parkent-slide-1.webp',active:true}],
 phone:'+998901361211',telegram:'https://t.me/imomotabaraka',email:'info@imomotamarket.uz',
 delivery:{free:true,district:'Parkent tumani',areas:['Parkent shahri','Chinor','Zarkent','So‘qoq','Kumushkon','Nevich','Boshqizilsoy','Changi','Qoraqalpoq','Nomdanak'],slots:['09:00–12:00','12:00–15:00','15:00–18:00','18:00–21:00']},
 seo:{title:'IMOM OTA BARAKA — ZARBULOQ.UZ',description:'ZARBULOQ.UZ — Parkent tumani bo‘ylab bepul yetkazib beruvchi IMOM OTA BARAKA internet do‘koni.',keywords:'zarbuloq, imom ota baraka, parkent, internet do‘kon, bepul yetkazib berish'}
};
const defaultPromos=[{code:'BARAKA5',type:'percent',value:5,minTotal:150000,active:true,usageLimit:100,used:0,expires:''}];

function initialDb(){return {products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[],productRequests:[],chats:[],promos:defaultPromos,audit:[],inventoryReceipts:[]};}
function normalizeDb(db){
 const merged={...initialDb(),...(db||{}),settings:{...defaultSettings,...(db?.settings||{}),delivery:{...defaultSettings.delivery,...(db?.settings?.delivery||{})},seo:{...defaultSettings.seo,...(db?.settings?.seo||{})},company:{...defaultSettings.company,...(db?.settings?.company||{})},map:{...defaultSettings.map,...(db?.settings?.map||{})},footer:{...defaultSettings.footer,...(db?.settings?.footer||{})},ui:{...defaultSettings.ui,...(db?.settings?.ui||{})},testMode:{...defaultSettings.testMode,...(db?.settings?.testMode||{})}},chats:Array.isArray(db?.chats)?db.chats:[],promos:Array.isArray(db?.promos)?db.promos:defaultPromos,audit:Array.isArray(db?.audit)?db.audit:[],inventoryReceipts:Array.isArray(db?.inventoryReceipts)?db.inventoryReceipts:[]};
 const dom=String(merged.settings.siteDomain||'').toLowerCase();
 if(['velora.uz','barkamarket.uz','barakamarket.uz','imomotamarket.uz'].includes(dom))merged.settings.siteDomain='zarbuloq.uz';
 if(merged.settings.map?.title==='Parkent tumani xaritasi')merged.settings.map.title='Yetkazib berish bepul hududlar';
 if(merged.settings.map?.text?.startsWith('Buyurtmalar Parkent tumani bo‘ylab bepul yetkazib beriladi'))merged.settings.map.text='Xaritada yashil rang va qizil chegara bilan ko‘rsatilgan Parkent tumani hududlarida yetkazib berish bepul. Buyurtma vaqtida manzilingizni tanlang yoki aniq GPS lokatsiyangizni yuboring.';
 merged.settings.map.openUrl='https://www.openstreetmap.org/relation/5745823';
 for(const k of ['title','description','keywords'])if(typeof merged.settings.seo?.[k]==='string')merged.settings.seo[k]=merged.settings.seo[k].replace(/VELORA\.UZ/gi,'ZARBULOQ.UZ').replace(/velora/gi,'zarbuloq').replace(/BarkaMarket\.uz/gi,'ZARBULOQ.UZ').replace(/barkamarket/gi,'zarbuloq').replace(/barakamarket/gi,'zarbuloq').replace(/imomotamarket/gi,'zarbuloq');
 // Legacy ombor migration: old products had only current stock, without receipt history.
 // Reconstruct a stable opening quantity so monthly closing stock does not become 0.
 for(const p of merged.products||[]){
  if(Number.isFinite(Number(p.legacyOpeningQty))&&p.legacyOpeningQty!==''&&p.legacyOpeningQty!==null&&p.legacyOpeningQty!==undefined)continue;
  const hasTrackedInitial=Boolean(String(p.createdAt||'').slice(0,10))&&p.receivedQty!==undefined&&p.receivedQty!==null;
  if(hasTrackedInitial){p.legacyOpeningQty=0;continue;}
  const soldAll=(merged.orders||[]).filter(o=>['delivery','done'].includes(o.status)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(p.id)).reduce((a,i)=>a+Number(i.qty||0),0),0);
  const ledgerReceived=(merged.inventoryReceipts||[]).filter(r=>Number(r.productId)===Number(p.id)).reduce((a,r)=>a+Math.max(0,Number(r.qty)||0),0);
  p.legacyOpeningQty=Math.max(0,Number(p.stock||0)+soldAll-ledgerReceived);
 }
 return merged;
}
function writeLocal(db){
 fs.mkdirSync(DATA_DIR,{recursive:true});
 const tmp=DB_FILE+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(db,null,2));
 fs.renameSync(tmp,DB_FILE);
}
function readLocal(){
 try{return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE,'utf8')))}catch{return normalizeDb(initialDb())}
}
function readDb(){return dbCache || readLocal();}
async function persistRemote(snapshot){
 if(!pool)return;
 await pool.query('INSERT INTO shop_state (id,data,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()',[snapshot]);
}
async function writeDb(db){
 const normalized=normalizeDb(db);
 const snapshot=JSON.stringify(normalized);
 dbCache=normalized;
 writeLocal(normalized);
 if(pool){
  persistChain=persistChain.catch(()=>{}).then(()=>persistRemote(snapshot));
  await persistChain;
 }
 broadcastRealtime('data-changed');
}
async function initStorage(){
 fs.mkdirSync(DATA_DIR,{recursive:true});
 const local=readLocal();
 if(!pool){dbCache=local;writeLocal(dbCache);console.log('Storage: local JSON fallback');return;}
 await pool.query('CREATE TABLE IF NOT EXISTS shop_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
 const r=await pool.query('SELECT data FROM shop_state WHERE id=1');
 if(r.rows.length){dbCache=normalizeDb(r.rows[0].data);writeLocal(dbCache);console.log('Storage: PostgreSQL loaded');}
 else{dbCache=local;await persistRemote(JSON.stringify(dbCache));writeLocal(dbCache);console.log('Storage: PostgreSQL initialized from local data');}
}
function clean(v,max=500){return String(v??'').replace(/[<>]/g,'').trim().slice(0,max)}
const money=n=>new Intl.NumberFormat('ru-RU').format(Number(n)||0)+' so‘m';
function statusLabel(code){return {new:'🕓 Yangi',accepted:'✅ Qabul qilindi',delivery:'🚚 Yetkazilmoqda',done:'📦 Yakunlandi',cancelled:'❌ Bekor qilindi'}[code]||'🕓 Yangi'}
function statusKeyboard(orderId,current='new'){
 const rows=[[{text:'✅ Qabul qilindi',callback_data:`st|accepted|${orderId}`},{text:'🚚 Yetkazilmoqda',callback_data:`st|delivery|${orderId}`}],[{text:'📦 Yakunlandi',callback_data:`st|done|${orderId}`},{text:'❌ Bekor qilindi',callback_data:`st|cancelled|${orderId}`}]];
 return {inline_keyboard:rows.map(row=>row.map(b=>{const active=b.callback_data.includes(`|${current}|`);return {...b,text:active?`${b.text.toUpperCase()} — HOZIRGI STATUS`:b.text}}))};
}
async function tgCall(method,payload){const r=await fetch(`${TG}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));if(!r.ok||!data.ok)throw new Error(data.description||`Telegram ${method} failed`);return data.result}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));}
function signSession(user,role,exp){const raw=`${user}|${role}|${exp}`;const sig=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex');return Buffer.from(`${raw}|${sig}`).toString('base64url');}
function verifySession(token){try{const [user,role,exp,sig]=Buffer.from(token,'base64url').toString().split('|');if(!user||!role||!exp||!sig||Date.now()>Number(exp))return null;const raw=`${user}|${role}|${exp}`;const good=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex');if(sig.length!==good.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(good)))return null;return {user,role};}catch{return null}}
function requireAdmin(req,res,next){const s=verifySession(parseCookies(req).iob_admin||'');if(!s)return res.status(401).json({error:'Unauthorized'});req.adminUser=s.user;req.adminRole=s.role;next();}
function requireRole(...roles){return (req,res,next)=>{if(req.adminRole==='admin'||roles.includes(req.adminRole))return next();return res.status(403).json({error:'Ruxsat yetarli emas'});}}
function audit(db,user,action,details=''){db.audit=db.audit||[];db.audit.unshift({id:Date.now()+Math.random(),at:new Date().toISOString(),user:user||'system',action:clean(action,120),details:clean(details,500)});db.audit=db.audit.slice(0,1500);}
function orderText(order){
 const loc=order.customer?.lat&&order.customer?.lng?`\n📍 Lokatsiya: https://maps.google.com/?q=${order.customer.lat},${order.customer.lng}`:'';
 const items=(order.items||[]).map((x,i)=>`${i+1}. ${x.name} × ${x.qty} — ${money(Number(x.price)*Number(x.qty))}`).join('\n');
 return `🛒 YANGI BUYURTMA #${order.orderId}\n\n👤 Mijoz: ${order.customer?.name||''}\n📞 Telefon: ${order.customer?.phone||''}\n📍 Hudud: ${order.customer?.area||''}\n🏠 Manzil: ${order.customer?.address||''}${loc}\n🚚 Yetkazish: BEPUL • ${order.customer?.deliverySlot||''}\n💳 To‘lov: ${order.customer?.payment||''}\n📝 Izoh: ${order.customer?.comment||'-'}\n\n${items}\n\n🎟 Chegirma: ${money(order.discount||0)}\n💰 JAMI: ${money(order.total)}\n🕒 ${new Date(order.createdAt).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})}\n📌 Holat: ${statusLabel(order.status)}`;
}
function validatePromo(db,code,subtotal){const c=String(code||'').trim().toUpperCase();if(!c)return {ok:true,discount:0,promo:null};const p=(db.promos||[]).find(x=>String(x.code||'').toUpperCase()===c);if(!p||!p.active)return {ok:false,error:'Promo kod topilmadi yoki faol emas'};if(p.expires&&new Date(p.expires+'T23:59:59')<new Date())return {ok:false,error:'Promo kod muddati tugagan'};if(Number(p.usageLimit||0)>0&&Number(p.used||0)>=Number(p.usageLimit))return {ok:false,error:'Promo kod limiti tugagan'};if(Number(subtotal)<Number(p.minTotal||0))return {ok:false,error:`Minimal buyurtma ${money(p.minTotal)}`};let discount=p.type==='fixed'?Number(p.value||0):Math.round(Number(subtotal)*Number(p.value||0)/100);discount=Math.max(0,Math.min(discount,Number(subtotal)));return {ok:true,discount,promo:p};}
function getCustomers(orders){const m=new Map();for(const o of orders){const phone=String(o.customer?.phone||'').replace(/\D/g,'');if(!phone)continue;const c=m.get(phone)||{name:o.customer?.name||'',phone:o.customer?.phone||'',orders:0,total:0,lastOrder:'',areas:{}};c.orders++;if(o.status==='done')c.total+=Number(o.total||0);if(!c.lastOrder||String(o.createdAt)>c.lastOrder)c.lastOrder=o.createdAt;c.areas[o.customer?.area||'Noma’lum']=(c.areas[o.customer?.area||'Noma’lum']||0)+1;m.set(phone,c);}return [...m.values()].sort((a,b)=>b.total-a.total);}

app.get('/health',(req,res)=>res.status(200).send('OK'));
app.get('/api/status',(req,res)=>res.json({ok:true,version:'13.17.0',telegramConfigured:Boolean(BOT_TOKEN&&CHAT_ID),adminOnline:true,storage:pool?'postgresql':'local-json',persistent:Boolean(pool),dataFile:DB_FILE}));
app.get('/api/events',(req,res)=>{
 res.setHeader('Content-Type','text/event-stream; charset=utf-8');
 res.setHeader('Cache-Control','no-cache, no-transform');
 res.setHeader('Connection','keep-alive');
 res.setHeader('X-Accel-Buffering','no');
 res.flushHeaders?.();
 realtimeClients.add(res);
 res.write(`event: ready\ndata: ${JSON.stringify({revision:realtimeRevision,at:new Date().toISOString()})}\n\n`);
 const ping=setInterval(()=>{try{res.write(`: ping ${Date.now()}\n\n`)}catch{}},25000);
 req.on('close',()=>{clearInterval(ping);realtimeClients.delete(res)});
});
app.get('/api/catalog',(req,res)=>{const db=readDb();res.json({products:db.products||[],categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',promos:(db.promos||[]).filter(p=>p.active).map(p=>({code:p.code,minTotal:p.minTotal,type:p.type,value:p.value,expires:p.expires}))});});
app.post('/api/promo/validate',(req,res)=>{const db=readDb();const result=validatePromo(db,req.body?.code,Number(req.body?.subtotal||0));if(!result.ok)return res.status(400).json(result);res.json({ok:true,discount:result.discount,code:result.promo?.code||''});});
app.get('/api/track/:orderId',(req,res)=>{const db=readDb();const order=(db.orders||[]).find(o=>o.orderId===req.params.orderId);if(!order)return res.status(404).json({error:'Buyurtma topilmadi'});const phone=String(req.query.phone||'').replace(/\D/g,'');const stored=String(order.customer?.phone||'').replace(/\D/g,'');if(!phone||phone.slice(-9)!==stored.slice(-9))return res.status(403).json({error:'Telefon raqami mos kelmadi'});res.json({orderId:order.orderId,status:order.status,statusLabel:statusLabel(order.status),createdAt:order.createdAt,total:order.total,area:order.customer?.area||'',deliverySlot:order.customer?.deliverySlot||'',items:(order.items||[]).map(x=>({name:x.name,qty:x.qty}))});});


app.post('/api/product-requests',async(req,res)=>{
 try{
  const db=readDb(), b=req.body||{};
  const name=clean(b.productName,160), phone=clean(b.phone,40), customer=clean(b.customerName,100), comment=clean(b.comment,500), qty=Math.max(1,Math.min(999,Math.floor(Number(b.qty)||1)));
  if(!name||!phone)return res.status(400).json({error:'Mahsulot nomi va telefon raqami majburiy'});
  const image=String(b.image||''); if(image && (!image.startsWith('data:image/')||image.length>3_000_000))return res.status(400).json({error:'Rasm hajmi yoki formati noto‘g‘ri'});
  const requestId='REQ-'+new Date().toISOString().slice(2,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-5);
  const item={requestId,createdAt:new Date().toISOString(),status:'new',productName:name,qty,customerName:customer,phone,comment,image:image.slice(0,3_000_000)};
  db.productRequests=db.productRequests||[]; db.productRequests.unshift(item); db.productRequests=db.productRequests.slice(0,1000); audit(db,'mijoz','Mahsulot so‘rovi',requestId+' '+name); await writeDb(db);
  if(BOT_TOKEN&&CHAT_ID){let text=`🔎 YANGI MAHSULOT SO‘ROVI #${requestId}\n\n📦 Mahsulot: ${name}\n🔢 Miqdor: ${qty}\n👤 Mijoz: ${customer||'—'}\n📞 Telefon: ${phone}\n💬 Izoh: ${comment||'—'}\n🌐 ZARBULOQ.UZ`;try{if(image)text+='\n🖼 Rasm biriktirilgan — Admin panelda ko‘ring.';await tgCall('sendMessage',{chat_id:CHAT_ID,text})}catch(e){console.error('Product request Telegram:',e.message||e)}}
  res.json({ok:true,requestId});
 }catch(e){console.error(e);res.status(500).json({error:'So‘rovni yuborib bo‘lmadi'})}
});

// V13.17 — sayt ichidagi mijoz ↔ admin LIVE chat
function chatId(v=''){return clean(v,90).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,90)}
function publicChatView(c){return {sessionId:c.sessionId,name:c.name||'',phone:c.phone||'',updatedAt:c.updatedAt||c.createdAt,messages:(c.messages||[]).slice(-200).map(m=>({id:m.id,from:m.from,text:m.text,createdAt:m.createdAt}))}}
app.get('/api/chat/:sessionId',(req,res)=>{const id=chatId(req.params.sessionId);if(!id)return res.status(400).json({error:'Chat ID noto‘g‘ri'});const db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);res.json(c?publicChatView(c):{sessionId:id,messages:[]})});
app.post('/api/chat/send',async(req,res)=>{const id=chatId(req.body?.sessionId),text=clean(req.body?.message,1200),name=clean(req.body?.name,80),phone=clean(req.body?.phone,30);if(!id||!text)return res.status(400).json({error:'Xabar yozing'});const db=readDb();db.chats=db.chats||[];let c=db.chats.find(x=>x.sessionId===id);if(!c){c={sessionId:id,name,phone,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),unreadAdmin:0,messages:[]};db.chats.unshift(c)}if(name)c.name=name;if(phone)c.phone=phone;c.updatedAt=new Date().toISOString();c.unreadAdmin=Number(c.unreadAdmin||0)+1;c.messages=c.messages||[];c.messages.push({id:'m-'+Date.now()+'-'+crypto.randomInt(100,999),from:'customer',text,createdAt:new Date().toISOString()});c.messages=c.messages.slice(-300);db.chats=db.chats.slice(0,500);audit(db,'customer','Chat xabari',id);await writeDb(db);res.json({ok:true,chat:publicChatView(c)})});
app.post('/api/admin/chats/:sessionId/send',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId),text=clean(req.body?.message,1200);if(!id||!text)return res.status(400).json({error:'Xabar yozing'});const db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);if(!c)return res.status(404).json({error:'Chat topilmadi'});c.messages=c.messages||[];c.messages.push({id:'m-'+Date.now()+'-'+crypto.randomInt(100,999),from:'admin',text,createdAt:new Date().toISOString(),actor:req.adminUser});c.messages=c.messages.slice(-300);c.updatedAt=new Date().toISOString();c.unreadAdmin=0;audit(db,req.adminUser,'Chat javobi',id);await writeDb(db);res.json({ok:true})});
app.patch('/api/admin/chats/:sessionId/read',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId),db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);if(c){c.unreadAdmin=0;await writeDb(db)}res.json({ok:true})});

app.post('/api/admin/login',(req,res)=>{const u=clean(req.body?.username,80),p=String(req.body?.password||'');const found=USERS.find(x=>x.username===u&&x.password===p);if(!found)return res.status(401).json({error:'Login yoki parol noto‘g‘ri'});const exp=Date.now()+12*60*60*1000;res.setHeader('Set-Cookie',`iob_admin=${signSession(found.username,found.role,exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true,user:found.username,role:found.role});});
app.post('/api/admin/logout',(req,res)=>{res.setHeader('Set-Cookie','iob_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({ok:true,user:req.adminUser,role:req.adminRole}));

app.get('/api/admin/dashboard',requireAdmin,(req,res)=>{
 const db=readDb(),orders=db.orders||[],products=db.products||[];const today=new Date().toISOString().slice(0,10),month=today.slice(0,7),year=today.slice(0,4);const done=orders.filter(o=>o.status==='done');
 const costFor=o=>(o.items||[]).reduce((s,i)=>{const p=products.find(x=>Number(x.id)===Number(i.id));return s+(Number(p?.cost||0)*Number(i.qty||1));},0);
 const revenue=done.reduce((s,o)=>s+Number(o.total||0),0),profit=done.reduce((s,o)=>s+Number(o.total||0)-costFor(o),0);const avg=done.length?Math.round(revenue/done.length):0;
 const topMap={};for(const o of done)for(const i of o.items||[]){topMap[i.name]=(topMap[i.name]||0)+Number(i.qty||1)}
 const areaMap={};for(const o of orders){const a=o.customer?.area||'Noma’lum';areaMap[a]=(areaMap[a]||0)+1}
 const last7=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=d.toISOString().slice(0,10);last7.push({date:key,revenue:done.filter(o=>String(o.createdAt).slice(0,10)===key).reduce((s,o)=>s+Number(o.total||0),0),orders:orders.filter(o=>String(o.createdAt).slice(0,10)===key).length});}
 res.json({role:req.adminRole,productRequests:(db.productRequests||[]).slice(0,500),chats:(db.chats||[]).slice(0,500),stats:{orders:orders.length,today:orders.filter(o=>String(o.createdAt||'').slice(0,10)===today).length,month:orders.filter(o=>String(o.createdAt||'').slice(0,7)===month).length,year:orders.filter(o=>String(o.createdAt||'').slice(0,4)===year).length,revenue,profit,avg,pending:orders.filter(o=>['new','accepted','delivery'].includes(o.status)).length,cancelled:orders.filter(o=>o.status==='cancelled').length,lowStock:products.filter(p=>Number(p.stock||0)<=5).length,customers:getCustomers(orders).length},orders:orders.slice().reverse().slice(0,300),products,categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',customers:getCustomers(orders),promos:db.promos||[],audit:(db.audit||[]).slice(0,500),charts:{last7,topProducts:Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,qty])=>({name,qty})),areas:Object.entries(areaMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}))}});
});
app.put('/api/admin/catalog',requireAdmin,requireRole('stock'),async(req,res)=>{const db=readDb(),b=req.body||{};if(Array.isArray(b.products))db.products=b.products.slice(0,700).map(p=>({id:Number(p.id)||Date.now()+Math.floor(Math.random()*1000),cat:clean(p.cat,50),emoji:clean(p.emoji,10)||'🛍️',name:{uz:clean(p.name?.uz,120),ru:clean(p.name?.ru,120)},description:{uz:clean(p.description?.uz,1200),ru:clean(p.description?.ru,1200)},unit:{uz:clean(p.unit?.uz,30),ru:clean(p.unit?.ru,30)},price:Math.max(0,Number(p.price)||0),cost:Math.max(0,Number(p.cost)||0),oldPrice:Math.max(0,Number(p.oldPrice)||0),stock:Math.max(0,Number(p.stock)||0),receivedQty:Math.max(0,Number(p.receivedQty)||0),legacyOpeningQty:Math.max(0,Number(p.legacyOpeningQty)||0),createdAt:clean(p.createdAt,40),lastReceivedAt:clean(p.lastReceivedAt,40),image:String(p.image||'').slice(0,6_000_000),badge:clean(p.badge,30),featured:Boolean(p.featured)}));if(Array.isArray(b.categories))db.categories=b.categories.slice(0,100);if(b.settings&&typeof b.settings==='object')db.settings=b.settings;if(typeof b.logo==='string')db.logo=b.logo.slice(0,6_000_000);audit(db,req.adminUser,'Katalog/sozlamalar yangilandi');await writeDb(db);res.json({ok:true});});
app.post('/api/admin/inventory-receive',requireAdmin,requireRole('stock'),async(req,res)=>{
 try{
  const db=readDb(),productId=Number(req.body?.productId),qty=Number(req.body?.qty);
  if(!Number.isFinite(productId))return res.status(400).json({error:'Mahsulot noto‘g‘ri'});
  if(!Number.isFinite(qty)||qty<=0)return res.status(400).json({error:'Qabul miqdori 0 dan katta bo‘lishi kerak'});
  const p=(db.products||[]).find(x=>Number(x.id)===productId);if(!p)return res.status(404).json({error:'Mahsulot topilmadi'});
  const now=new Date().toISOString(),receipt={receiptId:`RCV-${Date.now()}-${crypto.randomInt(10,99)}`,productId:p.id,qty,createdAt:now,actor:req.adminUser};
  p.stock=Math.max(0,Number(p.stock||0))+qty;p.lastReceivedAt=now;
  db.inventoryReceipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[];db.inventoryReceipts.push(receipt);
  if(db.inventoryReceipts.length>20000)db.inventoryReceipts=db.inventoryReceipts.slice(-20000);
  audit(db,req.adminUser,'Omborga qabul qilindi',`${p.name?.uz||'Mahsulot'} +${qty}; qoldiq ${p.stock}`);
  await writeDb(db);res.json({ok:true,stock:p.stock,receipt});
 }catch(e){console.error('Inventory receive error:',e);res.status(500).json({error:'Omborga qabul qilishda xatolik'})}
});
app.patch('/api/admin/product-requests/:id',requireAdmin,async(req,res)=>{const db=readDb(),r=(db.productRequests||[]).find(x=>x.requestId===req.params.id);if(!r)return res.status(404).json({error:'So‘rov topilmadi'});const st=clean(req.body?.status,30);if(!['new','working','found','closed'].includes(st))return res.status(400).json({error:'Status noto‘g‘ri'});r.status=st;r.updatedAt=new Date().toISOString();audit(db,req.adminUser,'Mahsulot so‘rovi statusi',`${r.requestId}: ${st}`);await writeDb(db);res.json({ok:true});});
app.put('/api/admin/promos',requireAdmin,async(req,res)=>{const db=readDb();db.promos=Array.isArray(req.body?.promos)?req.body.promos.slice(0,200).map(p=>({code:clean(p.code,30).toUpperCase(),type:p.type==='fixed'?'fixed':'percent',value:Math.max(0,Number(p.value)||0),minTotal:Math.max(0,Number(p.minTotal)||0),active:Boolean(p.active),usageLimit:Math.max(0,Math.floor(Number(p.usageLimit)||0)),used:Math.max(0,Math.floor(Number(p.used)||0)),expires:clean(p.expires,20)})):db.promos;audit(db,req.adminUser,'Promo kodlar yangilandi');await writeDb(db);res.json({ok:true});});
app.get('/api/admin/backup.json',requireAdmin,(req,res)=>{res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-backup-${new Date().toISOString().slice(0,10)}.json"`);res.json(readDb());});
app.post('/api/admin/restore',requireAdmin,async(req,res)=>{const b=req.body;if(!b||!Array.isArray(b.products)||!Array.isArray(b.orders))return res.status(400).json({error:'Backup formati noto‘g‘ri'});const db={...initialDb(),...b};audit(db,req.adminUser,'Backup tiklandi');await writeDb(db);res.json({ok:true});});

app.get('/api/admin/reports.xls',requireAdmin,(req,res)=>{
 const db=readDb(),orders=db.orders||[],products=db.products||[];const period=String(req.query.period||'custom'),value=String(req.query.value||''),from=String(req.query.from||''),to=String(req.query.to||''),status=String(req.query.status||''),area=String(req.query.area||'');
 const filtered=orders.filter(o=>{const d=String(o.createdAt||'').slice(0,10);if(period==='daily'&&value&&d!==value)return false;if(period==='monthly'&&value&&d.slice(0,7)!==value)return false;if(period==='yearly'&&value&&d.slice(0,4)!==value)return false;if(from&&d<from)return false;if(to&&d>to)return false;if(status&&o.status!==status)return false;if(area&&o.customer?.area!==area)return false;return true;});
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const rows=filtered.map(o=>{const cost=(o.items||[]).reduce((s,i)=>s+Number(products.find(p=>Number(p.id)===Number(i.id))?.cost||0)*Number(i.qty||1),0);const profit=o.status==='done'?Number(o.total||0)-cost:0;return `<tr><td>${esc(o.orderId)}</td><td>${esc(new Date(o.createdAt).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'}))}</td><td>${esc(o.customer?.name)}</td><td>${esc(o.customer?.phone)}</td><td>${esc(o.customer?.area)}</td><td>${esc(o.customer?.address)}</td><td>${esc(o.customer?.deliverySlot)}</td><td>${esc((o.items||[]).map(x=>`${x.name} × ${x.qty}`).join('; '))}</td><td>${Number(o.subtotal||0)}</td><td>${Number(o.discount||0)}</td><td>${Number(o.total||0)}</td><td>${cost}</td><td>${profit}</td><td>${esc(statusLabel(o.status))}</td></tr>`}).join('');
 const revenue=filtered.filter(o=>o.status==='done').reduce((s,o)=>s+Number(o.total||0),0);const html=`<html><head><meta charset="UTF-8"></head><body><h2>IMOM OTA BARAKA — Hisobot</h2><p>Buyurtmalar: ${filtered.length} | Yakunlangan tushum: ${revenue}</p><table border="1"><tr><th>Buyurtma</th><th>Sana</th><th>Mijoz</th><th>Telefon</th><th>Hudud</th><th>Manzil</th><th>Vaqt</th><th>Mahsulotlar</th><th>Subtotal</th><th>Chegirma</th><th>Jami</th><th>Tannarx</th><th>Foyda</th><th>Status</th></tr>${rows}</table></body></html>`;
 res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-report-${Date.now()}.xls"`);res.send('\ufeff'+html);
});

app.get('/api/admin/inventory-report.xls',requireAdmin,(req,res)=>{
 const db=readDb(),month=/^\d{4}-\d{2}$/.test(String(req.query.month||''))?String(req.query.month):new Date().toISOString().slice(0,7),start=month+'-01',end=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).toISOString().slice(0,10),orders=db.orders||[],receipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const soldDate=o=>String(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt||'').slice(0,10);
 const soldQty=(pid,from,to)=>orders.filter(o=>['delivery','done'].includes(o.status)&&(!from||soldDate(o)>=from)&&(!to||soldDate(o)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const applicationQty=(pid,from,to)=>orders.filter(o=>o.status==='new'&&(!from||String(o.createdAt||'').slice(0,10)>=from)&&(!to||String(o.createdAt||'').slice(0,10)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const receiptEvents=p=>{
  const arr=[];const initialQty=Math.max(0,Number(p.receivedQty??0)),initialDate=String(p.createdAt||'').slice(0,10);if(initialQty>0&&initialDate)arr.push({qty:initialQty,date:initialDate,initial:true});
  for(const r of receipts){if(Number(r.productId)!==Number(p.id))continue;const date=String(r.createdAt||'').slice(0,10),qty=Math.max(0,Number(r.qty)||0);if(qty>0&&date)arr.push({qty,date,initial:false});}
  return arr;
 };
 const rows=(db.products||[]).map(p=>{
  const events=receiptEvents(p),legacyOpening=Math.max(0,Number(p.legacyOpeningQty)||0),receivedBefore=events.filter(r=>r.date<start).reduce((a,r)=>a+r.qty,0),receivedMonth=events.filter(r=>r.date>=start&&r.date<=end).reduce((a,r)=>a+r.qty,0),soldBefore=soldQty(p.id,'',new Date(new Date(start+'T00:00:00').getTime()-86400000).toISOString().slice(0,10)),opening=Math.max(0,legacyOpening+receivedBefore-soldBefore),sold=soldQty(p.id,start,end),applications=applicationQty(p.id,start,end),closing=Math.max(0,opening+receivedMonth-sold),dates=[...new Set(events.filter(r=>r.date>=start&&r.date<=end).map(r=>r.date))].join(', ')||'—';
  return `<tr><td>${esc(p.name?.uz)}</td><td>${esc(p.name?.ru)}</td><td>${esc(p.unit?.uz||'dona')}</td><td>${Number(p.cost||0)}</td><td>${Number(p.price||0)}</td><td>${opening}</td><td>${receivedMonth}</td><td>${sold}</td><td>${applications}</td><td>${closing}</td><td>${Number(p.stock||0)}</td><td>${esc(dates)}</td></tr>`
 }).join('');
 const html=`<html><head><meta charset="UTF-8"></head><body><h2>IMOM OTA BARAKA — Ombor hisoboti ${esc(month)}</h2><table border="1"><tr><th>Mahsulot nomi</th><th>Название товара</th><th>Birlik</th><th>Tannarxi</th><th>Sotuv narxi</th><th>Oy boshiga ostatka</th><th>Qabul qilingan</th><th>Sotilgan (Yetkazilmoqda + Yakunlandi)</th><th>Zayavka (Yangi)</th><th>Oy oxiriga qoldiq</th><th>Joriy qoldiq</th><th>Qabul sanasi</th></tr>${rows}</table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-ombor-${month}.xls"`);res.send('\ufeff'+html);
});

function pointInParkentFallback(lat,lng){
 const poly=[[41.447,69.620],[41.455,69.661],[41.446,69.688],[41.461,69.721],[41.471,69.764],[41.457,69.817],[41.421,69.819],[41.395,69.806],[41.365,69.801],[41.342,69.820],[41.309,69.806],[41.287,69.788],[41.255,69.773],[41.225,69.746],[41.197,69.708],[41.176,69.673],[41.194,69.642],[41.224,69.627],[41.249,69.602],[41.279,69.590],[41.300,69.568],[41.331,69.570],[41.358,69.556],[41.386,69.568],[41.411,69.584],[41.429,69.604]];
 let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const yi=poly[i][0],xi=poly[i][1],yj=poly[j][0],xj=poly[j][1];if(((yi>lat)!=(yj>lat))&&(lng<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi))inside=!inside}return inside;
}

function pointInRingGeo(lat,lng,ring){
 let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const xi=Number(ring[i][0]),yi=Number(ring[i][1]),xj=Number(ring[j][0]),yj=Number(ring[j][1]);
  const hit=((yi>lat)!=(yj>lat))&&(lng<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);if(hit)inside=!inside;
 }return inside;
}
function pointInGeoJSON(lat,lng,geom){
 if(!geom)return false;
 const poly=c=>Array.isArray(c)&&c.length&&pointInRingGeo(lat,lng,c[0])&&!c.slice(1).some(h=>pointInRingGeo(lat,lng,h));
 if(geom.type==='Polygon')return poly(geom.coordinates);
 if(geom.type==='MultiPolygon')return (geom.coordinates||[]).some(poly);
 return false;
}
let parkentGeometryCache={geometry:null,expires:0};
async function fetchParkentGeometry(){
 if(parkentGeometryCache.geometry&&Date.now()<parkentGeometryCache.expires)return parkentGeometryCache.geometry;
 const u='https://nominatim.openstreetmap.org/lookup?osm_ids=R5745823&format=geojson&polygon_geojson=1';
 const r=await fetch(u,{headers:{'User-Agent':'Zarbuloq/13.17 (info@imomotamarket.uz)','Accept':'application/geo+json,application/json','Accept-Language':'uz,en;q=0.8'}});
 if(!r.ok)throw new Error('Parkent boundary lookup failed');
 const g=await r.json(),geom=g?.features?.[0]?.geometry;if(!geom)throw new Error('Parkent boundary missing');
 parkentGeometryCache={geometry:geom,expires:Date.now()+6*60*60*1000};return geom;
}
async function checkParkentLocation(lat,lng){
 try{const geom=await fetchParkentGeometry();return pointInGeoJSON(lat,lng,geom)}catch(e){console.error('Parkent geometry check:',e.message||e);return pointInParkentFallback(lat,lng)}
}
app.get('/api/geo/parkent-check',async(req,res)=>{
 const lat=Number(req.query.lat),lng=Number(req.query.lng);
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180)return res.status(400).json({error:'Noto‘g‘ri koordinata'});
 try{const inside=await checkParkentLocation(lat,lng);res.json({ok:true,inside,lat,lng})}catch(e){res.status(503).json({error:'Hududni tekshirib bo‘lmadi'})}
});
app.post('/api/orders',async(req,res)=>{
 const db=readDb(),b=req.body||{},customer=b.customer||{},items=Array.isArray(b.items)?b.items:[];
 if(!clean(customer.name,80)||!clean(customer.phone,30)||!clean(customer.address,300)||!clean(customer.area,100)||!clean(customer.payment,80)||!items.length)return res.status(400).json({error:'Majburiy maydonlarni to‘ldiring'});
 if(!(db.settings?.delivery?.areas||[]).includes(customer.area))return res.status(400).json({error:'Yetkazib berish hududini tanlang'});
 const lat=Number(customer.lat),lng=Number(customer.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Buyurtma uchun GPS lokatsiya majburiy'});if(!(await checkParkentLocation(lat,lng)))return res.status(400).json({error:'Buyurtma faqat Parkent tumani hududida qabul qilinadi'});
 const finalItems=[];let subtotal=0;
 for(const i of items){const p=(db.products||[]).find(x=>Number(x.id)===Number(i.id));if(!p)continue;const qty=Math.max(1,Math.floor(Number(i.qty)||1));if(qty>Number(p.stock||0))return res.status(400).json({error:`${p.name?.uz||'Mahsulot'} omborda yetarli emas`});finalItems.push({id:p.id,name:p.name?.[b.language]||p.name?.uz||'',price:Number(p.price||0),qty});subtotal+=Number(p.price||0)*qty;}
 if(!finalItems.length)return res.status(400).json({error:'Mahsulot topilmadi'});
 const promoResult=validatePromo(db,b.promoCode,subtotal);if(!promoResult.ok)return res.status(400).json({error:promoResult.error});const discount=promoResult.discount,total=subtotal-discount;
 const orderId=`IOB-${String(Date.now()).slice(-8)}-${String(Math.floor(Math.random()*90)+10)}`,createdAt=new Date().toISOString();
 const order={orderId,createdAt,status:'new',customer:{name:clean(customer.name,80),phone:clean(customer.phone,30),address:clean(customer.address,300),area:clean(customer.area,100),deliverySlot:clean(customer.deliverySlot,50),payment:clean(customer.payment,80),comment:clean(customer.comment,500),lat:Number(customer.lat)||null,lng:Number(customer.lng)||null},items:finalItems,subtotal,discount,total,promoCode:promoResult.promo?.code||'',language:clean(b.language,5)||'uz',telegram:null,stockAdjusted:false};
 if(promoResult.promo)promoResult.promo.used=Number(promoResult.promo.used||0)+1;
 db.orders=db.orders||[];db.orders.push(order);audit(db,'customer','Yangi buyurtma',`${orderId} • ${money(total)}`);await writeDb(db);
 if(BOT_TOKEN&&CHAT_ID){try{const msg=await tgCall('sendMessage',{chat_id:CHAT_ID,text:orderText(order),reply_markup:statusKeyboard(orderId,'new')});const db2=readDb(),o=db2.orders.find(x=>x.orderId===orderId);if(o){o.telegram={chatId:String(msg.chat.id),messageId:msg.message_id};await writeDb(db2);}}catch(e){console.error('Telegram send error:',e.message);return res.status(502).json({error:'Buyurtma saqlandi, lekin Telegramga yuborilmadi',orderId,saved:true});}}
 res.json({ok:true,orderId,total,discount});
});

async function updateOrderStatus(orderId,status,actor='admin'){
 const allowed=['new','accepted','delivery','done','cancelled'];if(!allowed.includes(status))throw new Error('Invalid status');const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===orderId);if(!o)throw new Error('Order not found');const prev=o.status,soldStatuses=['delivery','done'],wasSold=soldStatuses.includes(prev)&&o.stockAdjusted===true,willSold=soldStatuses.includes(status);if(willSold&&!wasSold){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p){if(Number(p.stock||0)<Number(it.qty||0))throw new Error(`${p.name?.uz||'Mahsulot'} omborda yetarli emas`);p.stock=Math.max(0,Number(p.stock||0)-Number(it.qty||0));}}o.stockAdjusted=true;o.stockAdjustedAt=new Date().toISOString()}else if(!willSold&&wasSold){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p)p.stock=Number(p.stock||0)+Number(it.qty||0)}o.stockAdjusted=false;o.stockAdjustedAt=''}o.status=status;o.statusUpdatedAt=new Date().toISOString();audit(db,actor,'Buyurtma statusi',`${orderId}: ${prev} → ${status}`);await writeDb(db);
 if(BOT_TOKEN&&o.telegram?.chatId&&o.telegram?.messageId){try{await tgCall('editMessageText',{chat_id:o.telegram.chatId,message_id:o.telegram.messageId,text:orderText(o),reply_markup:['done','cancelled'].includes(status)?{inline_keyboard:[]}:statusKeyboard(o.orderId,status)});}catch(e){console.error('Telegram edit error:',e.message)}}return o;
}
app.patch('/api/admin/orders/:id/status',requireAdmin,requireRole('operator'),async(req,res)=>{try{const o=await updateOrderStatus(req.params.id,String(req.body?.status||''),req.adminUser);res.json({ok:true,order:o});}catch(e){res.status(400).json({error:e.message})}});

let polling=false,offset=0;
async function pollTelegram(){if(!BOT_TOKEN||polling)return;polling=true;try{try{await tgCall('deleteWebhook',{drop_pending_updates:false});}catch{}console.log('Telegram order-status buttons: polling started');while(true){try{const updates=await tgCall('getUpdates',{offset,timeout:25,allowed_updates:['callback_query']});for(const u of updates){offset=Math.max(offset,u.update_id+1);const q=u.callback_query;if(!q)continue;const [kind,status,orderId]=String(q.data||'').split('|');if(kind!=='st')continue;try{await updateOrderStatus(orderId,status,'telegram');await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:statusLabel(status)});}catch(e){await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik'}).catch(()=>{});console.error('Callback error:',e.message)}}}catch(e){console.error('Telegram polling error:',e.message);await new Promise(r=>setTimeout(r,4000));}}}finally{polling=false}}

async function start(){
 try{
  await initStorage();
  app.listen(PORT,()=>{
   console.log(`IMOM OTA BARAKA v13.18 OMBOR KIRIM + PRODUCT SEO + LIVE CHAT ZARBULOQ / zarbuloq.uz: http://localhost:${PORT}`);
   console.log(`Storage: ${pool?'PostgreSQL persistent':'local JSON fallback'}`);
   console.log(`Telegram CHAT_ID: ${CHAT_ID?'configured':'MISSING'}`);
   console.log(`Telegram BOT_TOKEN: ${BOT_TOKEN?'configured':'MISSING'}`);
   console.log(`Online admin: /admin.html | DATA_DIR=${DATA_DIR}`);
   pollTelegram();
  });
 }catch(e){
  console.error('Startup/storage error:',e);
  process.exit(1);
 }
}
start();
