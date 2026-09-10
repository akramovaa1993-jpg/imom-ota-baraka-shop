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
  const db=readDb(),today=new Date().toISOString().slice(0,10);
  const productUrls=(db.products||[]).flatMap(p=>{const last=String(p.updatedAt||p.lastReceivedAt||p.createdAt||today).slice(0,10)||today,uz=`https://zarbuloq.uz/mahsulot/${productSlug(p,'uz')}`,ru=`https://zarbuloq.uz/ru/mahsulot/${productSlug(p,'ru')}`;return [`<url><loc>${xmlEsc(uz)}</loc><lastmod>${xmlEsc(last)}</lastmod><changefreq>daily</changefreq><priority>0.9</priority><xhtml:link rel="alternate" hreflang="uz" href="${xmlEsc(uz)}"/><xhtml:link rel="alternate" hreflang="ru" href="${xmlEsc(ru)}"/></url>`,`<url><loc>${xmlEsc(ru)}</loc><lastmod>${xmlEsc(last)}</lastmod><changefreq>daily</changefreq><priority>0.9</priority><xhtml:link rel="alternate" hreflang="ru" href="${xmlEsc(ru)}"/><xhtml:link rel="alternate" hreflang="uz" href="${xmlEsc(uz)}"/></url>`]});
  const urls=[`<url><loc>https://zarbuloq.uz/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,...productUrls];
  res.setHeader('Cache-Control','public, max-age=900');res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>`);
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
  const customDesc=p.seo?.description?.[lang]||p.description?.[lang]||p.description?.uz||'',desc=customDesc||productDescription(db,p),img=productImageUrl(p),price=Number(p.price||0),old=Number(p.oldPrice||0),stock=Number(p.stock||0),unit=p.unit?.[lang]||p.unit?.uz||'';
  const url=`https://zarbuloq.uz${prefix}${canonicalSlug}`,altLang=lang==='ru'?'uz':'ru',altPrefix=altLang==='ru'?'/ru/mahsulot/':'/mahsulot/',altUrl=`https://zarbuloq.uz${altPrefix}${productSlug(p,altLang)}`;
  const autoTitle=isRu?`${name} — цена | ZARBULOQ.UZ`:`${name} narxi | ZARBULOQ.UZ`,title=p.seo?.title?.[lang]||autoTitle,stockText=stock>0?(isRu?`В наличии: ${stock}${unit?' '+unit:''}`:`Omborda: ${stock}${unit?' '+unit:''}`):(isRu?'Нет в наличии':'Omborda yo‘q'),keywords=p.seo?.keywords||[p.name?.uz,p.name?.ru,catObj?.name?.uz,catObj?.name?.ru,'ZARBULOQ.UZ','Parkent'].filter(Boolean).join(', ');
  const schema={'@context':'https://schema.org','@type':'Product',name,alternateName:[p.name?.uz,p.name?.ru].filter(Boolean),description:desc,image:[img],sku:String(p.id),category:cat,brand:{'@type':'Brand',name:'IMOM OTA BARAKA'},offers:{'@type':'Offer',url,priceCurrency:'UZS',price,availability:stock>0?'https://schema.org/InStock':'https://schema.org/OutOfStock',itemCondition:'https://schema.org/NewCondition',seller:{'@type':'Organization',name:'IMOM OTA BARAKA',url:'https://zarbuloq.uz/'}}};
  const oldPrice=old>price?`<span class="old">${old.toLocaleString('ru-RU')} ${isRu?'сум':'so‘m'}</span>`:'';
  res.setHeader('X-Robots-Tag','index, follow, max-image-preview:large');
  res.send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEsc(title)}</title><meta name="description" content="${htmlEsc(desc)}"><meta name="keywords" content="${htmlEsc(keywords)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="${htmlEsc(url)}"><link rel="alternate" hreflang="${altLang}" href="${htmlEsc(altUrl)}"><link rel="alternate" hreflang="${lang}" href="${htmlEsc(url)}"><link rel="alternate" hreflang="x-default" href="${htmlEsc(`https://zarbuloq.uz/mahsulot/${productSlug(p,'uz')}`)}"><meta property="og:type" content="product"><meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}"><meta property="og:url" content="${htmlEsc(url)}"><meta property="og:image" content="${htmlEsc(img)}"><meta property="product:price:amount" content="${price}"><meta property="product:price:currency" content="UZS"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"><meta name="twitter:image" content="${htmlEsc(img)}"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>
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
 homePromos:{
  left:{title:{uz:'Tabiiy tozalik — har kuni siz bilan!',ru:'Естественная чистота — каждый день с вами!'},text:{uz:'Sifatli mahsulotlar va qulay xarid.',ru:'Качественные товары и удобные покупки.'},button:{uz:'Mahsulotlarni ko‘rish',ru:'Смотреть товары'},image:''},
  center:{title:{uz:'Parkent tabiati — toza hayot manbai!',ru:'Природа Паркента — источник чистой жизни!'},text:{uz:'Sof tabiat, sog‘lom hayot, siz uchun!',ru:'Чистая природа и здоровая жизнь — для вас!'}},
  right:{title:{uz:'Sifat. Ishonch. Baraka!',ru:'Качество. Доверие. Баракат!'},text:{uz:'IMOM OTA BARAKA — har doim siz bilan.',ru:'IMOM OTA BARAKA — всегда рядом.'},button:{uz:'Batafsil',ru:'Подробнее'},image:''}
 },
 benefits:[
  {title:{uz:'Bepul yetkazib berish',ru:'Бесплатная доставка'},text:{uz:'Parkent tumani hududida',ru:'По Паркентскому району'}},
  {title:{uz:'Ishonchli to‘lov',ru:'Надёжная оплата'},text:{uz:'Xavfsiz va qulay',ru:'Безопасно и удобно'}},
  {title:{uz:'24/7 qo‘llab-quvvatlash',ru:'Поддержка 24/7'},text:{uz:'Telegram orqali',ru:'Через Telegram'}},
  {title:{uz:'Tabiiy va sifatli mahsulotlar',ru:'Натуральные и качественные товары'},text:{uz:'Sog‘lig‘ingiz uchun',ru:'Для вашего здоровья'}}
 ],
 heroSlides:[{id:'slide-1',image:'parkent-slide-1.webp',active:true}],
 phone:'+998901361211',telegram:'https://t.me/imomotabaraka',email:'info@imomotamarket.uz',
 delivery:{free:true,district:'Parkent tumani',areas:['Parkent shahri','Chinor','Zarkent','So‘qoq','Kumushkon','Nevich','Boshqizilsoy','Changi','Qoraqalpoq','Nomdanak'],slots:['09:00–12:00','12:00–15:00','15:00–18:00','18:00–21:00']},
 seo:{title:'IMOM OTA BARAKA — ZARBULOQ.UZ',description:'ZARBULOQ.UZ — Parkent tumani bo‘ylab bepul yetkazib beruvchi IMOM OTA BARAKA internet do‘koni.',keywords:'zarbuloq, imom ota baraka, parkent, internet do‘kon, bepul yetkazib berish'}
};
const defaultPromos=[{code:'BARAKA5',type:'percent',value:5,minTotal:150000,active:true,usageLimit:100,used:0,expires:''}];

function initialDb(){return {products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[],productRequests:[],chats:[],promos:defaultPromos,audit:[],inventoryReceipts:[],financeCompanies:[],financePurchases:[],financeCompanyPayments:[],financeEmployees:[],financePayroll:[],financeExpenses:[],financeTaxPayments:[],receiptHistory:[],financeSettings:{turnoverTaxRate:4,payrollIncomeTaxRate:12,payrollPensionRate:0.1,payrollBudgetShareRate:11.9,employerSocialTaxRate:0,payrollTaxRate:12,landTaxMonthly:0,propertyTaxRate:0,propertyTaxBase:0,otherTaxRate:0,otherTaxBase:'revenue',otherTaxMonthly:0,cashOpening:0,bankOpening:0,defaultSalesAccount:'bank',defaultMarkupRate:30}};}
function normalizeDb(db){
 const merged={...initialDb(),...(db||{}),settings:{...defaultSettings,...(db?.settings||{}),delivery:{...defaultSettings.delivery,...(db?.settings?.delivery||{})},seo:{...defaultSettings.seo,...(db?.settings?.seo||{})},company:{...defaultSettings.company,...(db?.settings?.company||{})},map:{...defaultSettings.map,...(db?.settings?.map||{})},footer:{...defaultSettings.footer,...(db?.settings?.footer||{})},ui:{...defaultSettings.ui,...(db?.settings?.ui||{})},testMode:{...defaultSettings.testMode,...(db?.settings?.testMode||{})},homePromos:{left:{...defaultSettings.homePromos.left,...(db?.settings?.homePromos?.left||{})},center:{...defaultSettings.homePromos.center,...(db?.settings?.homePromos?.center||{})},right:{...defaultSettings.homePromos.right,...(db?.settings?.homePromos?.right||{})}},benefits:Array.isArray(db?.settings?.benefits)?db.settings.benefits:defaultSettings.benefits},chats:Array.isArray(db?.chats)?db.chats:[],promos:Array.isArray(db?.promos)?db.promos:defaultPromos,audit:Array.isArray(db?.audit)?db.audit:[],inventoryReceipts:Array.isArray(db?.inventoryReceipts)?db.inventoryReceipts:[],financeCompanies:Array.isArray(db?.financeCompanies)?db.financeCompanies:[],financePurchases:Array.isArray(db?.financePurchases)?db.financePurchases:[],financeCompanyPayments:Array.isArray(db?.financeCompanyPayments)?db.financeCompanyPayments:[],financeEmployees:Array.isArray(db?.financeEmployees)?db.financeEmployees:[],financePayroll:Array.isArray(db?.financePayroll)?db.financePayroll:[],financeExpenses:Array.isArray(db?.financeExpenses)?db.financeExpenses:[],financeTaxPayments:Array.isArray(db?.financeTaxPayments)?db.financeTaxPayments:[],receiptHistory:[],financeSettings:{...initialDb().financeSettings,...(db?.financeSettings||{})}};
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

function receiptHistoryRows(db){
 const saved=Array.isArray(db.receiptHistory)?db.receiptHistory:[];
 const byId=new Map(saved.map(r=>[String(r.orderId),r]));
 for(const o of (db.orders||[])){
  if(!byId.has(String(o.orderId))) byId.set(String(o.orderId),{orderId:o.orderId,createdAt:o.createdAt,status:o.status,customer:o.customer||{},items:o.items||[],subtotal:Number(o.subtotal||0),discount:Number(o.discount||0),deliveryFee:Number(o.deliveryFee||0),total:Number(o.total||0),payment:o.customer?.payment||o.payment||'Naqd',source:'order'});
  else {const r=byId.get(String(o.orderId)); r.status=o.status; r.statusUpdatedAt=o.statusUpdatedAt||r.statusUpdatedAt;}
 }
 return [...byId.values()].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
}

function getCustomers(orders){const m=new Map();for(const o of orders){const phone=String(o.customer?.phone||'').replace(/\D/g,'');if(!phone)continue;const c=m.get(phone)||{name:o.customer?.name||'',phone:o.customer?.phone||'',orders:0,total:0,lastOrder:'',areas:{}};c.orders++;if(o.status==='done')c.total+=Number(o.total||0);if(!c.lastOrder||String(o.createdAt)>c.lastOrder)c.lastOrder=o.createdAt;c.areas[o.customer?.area||'Noma’lum']=(c.areas[o.customer?.area||'Noma’lum']||0)+1;m.set(phone,c);}return [...m.values()].sort((a,b)=>b.total-a.total);}


// V13.23 FINANS — yagona moliyaviy modul
const finNum=v=>Math.max(0,Number(v)||0);
const finDate=v=>String(v||'').slice(0,10);
function finPeriodMatch(date,{period='monthly',value='',from='',to=''}={}){
 const d=finDate(date);if(!d)return false;
 if(period==='daily'&&value)return d===value;
 if(period==='monthly'&&value)return d.slice(0,7)===value;
 if(period==='yearly'&&value)return d.slice(0,4)===String(value);
 if(from&&d<from)return false;if(to&&d>to)return false;return true;
}
function finMonthCount(opts={}){
 if(opts.period==='daily')return 1/30;
 if(opts.period==='monthly')return 1;
 if(opts.period==='yearly')return 12;
 if(opts.from&&opts.to){const a=new Date(opts.from+'T00:00:00'),b=new Date(opts.to+'T00:00:00');return Math.max(1,((b.getFullYear()-a.getFullYear())*12+b.getMonth()-a.getMonth()+1));}
 return 1;
}
function financeSummary(db,opts={}){
 const products=db.products||[], orders=db.orders||[], fsx=db.financeSettings||{}, purchases=db.financePurchases||[], payments=db.financeCompanyPayments||[], payroll=db.financePayroll||[], expenses=db.financeExpenses||[], taxPayments=db.financeTaxPayments||[];
 const done=orders.filter(o=>o.status==='done'&&finPeriodMatch(o.statusUpdatedAt||o.createdAt,opts));
 const revenue=done.reduce((a,o)=>a+finNum(o.total),0);
 const cogs=done.reduce((a,o)=>a+(o.items||[]).reduce((x,i)=>{const pr=products.find(p=>Number(p.id)===Number(i.id));return x+finNum(pr?.cost)*finNum(i.qty)},0),0);
 const purchaseTotal=purchases.filter(x=>finPeriodMatch(x.date||x.createdAt,opts)).reduce((a,x)=>a+finNum(x.total),0);
 const supplierPaid=payments.filter(x=>finPeriodMatch(x.date||x.createdAt,opts)).reduce((a,x)=>a+finNum(x.amount),0);
 const periodPayroll=payroll.filter(x=>finPeriodMatch((x.month||'')+'-01',opts));
 const payrollGross=periodPayroll.reduce((a,x)=>a+finNum(x.gross),0),payrollPaid=periodPayroll.reduce((a,x)=>a+finNum(x.paid),0);
 const otherExpenses=expenses.filter(x=>finPeriodMatch(x.date||x.createdAt,opts)).reduce((a,x)=>a+finNum(x.amount),0);
 const turnoverTax=revenue*finNum(fsx.turnoverTaxRate)/100;
 const payrollIncomeTaxRate=finNum(fsx.payrollIncomeTaxRate ?? fsx.payrollTaxRate ?? 12);
 const payrollPensionRate=finNum(fsx.payrollPensionRate ?? 0.1);
 const payrollBudgetShareRate=finNum(fsx.payrollBudgetShareRate ?? Math.max(0,payrollIncomeTaxRate-payrollPensionRate));
 const employerSocialTaxRate=finNum(fsx.employerSocialTaxRate ?? 0);
 const payrollTax=payrollGross*payrollIncomeTaxRate/100;
 const payrollPensionShare=payrollGross*payrollPensionRate/100;
 const payrollBudgetShare=payrollGross*payrollBudgetShareRate/100;
 const employerSocialTax=payrollGross*employerSocialTaxRate/100;
 const months=finMonthCount(opts);
 const landTax=finNum(fsx.landTaxMonthly)*months;
 const propertyTax=finNum(fsx.propertyTaxBase)*finNum(fsx.propertyTaxRate)/100/12*months;
 const otherTax=fsx.otherTaxBase==='fixed'?finNum(fsx.otherTaxMonthly)*months:(fsx.otherTaxBase==='payroll'?payrollGross:revenue)*finNum(fsx.otherTaxRate)/100;
 // 0.1% and 11.9% are displayed as the internal split of the payroll income tax rate and are NOT added a second time.
 const taxAccrued=turnoverTax+payrollTax+employerSocialTax+landTax+propertyTax+otherTax;
 const taxPaid=taxPayments.filter(x=>finPeriodMatch(x.date||x.createdAt,opts)).reduce((a,x)=>a+finNum(x.amount),0);
 const grossProfit=revenue-cogs, netProfit=grossProfit-payrollGross-otherExpenses-taxAccrued;
 return {revenue,cogs,grossProfit,purchaseTotal,supplierPaid,payrollGross,payrollPaid,otherExpenses,turnoverTax,payrollTax,payrollIncomeTaxRate,payrollPensionRate,payrollBudgetShareRate,payrollPensionShare,payrollBudgetShare,employerSocialTax,employerSocialTaxRate,landTax,propertyTax,otherTax,taxAccrued,taxPaid,taxDebt:Math.max(0,taxAccrued-taxPaid),netProfit,orders:done.length};
}
function financeCurrentBalance(db){
 const fsx=db.financeSettings||{}, products=db.products||[];
 const purchases=db.financePurchases||[], companyPayments=db.financeCompanyPayments||[], payroll=db.financePayroll||[], taxPayments=db.financeTaxPayments||[];
 const companyIds=new Set([...(db.financeCompanies||[]).map(x=>String(x.id)),...purchases.map(x=>String(x.companyId||'')),...companyPayments.map(x=>String(x.companyId||''))]);
 let supplierDebt=0,supplierAdvances=0;
 for(const id of companyIds){if(!id)continue;const bought=purchases.filter(x=>String(x.companyId||'')===id).reduce((a,x)=>a+finNum(x.total),0),paid=companyPayments.filter(x=>String(x.companyId||'')===id).reduce((a,x)=>a+finNum(x.amount),0),net=bought-paid;if(net>=0)supplierDebt+=net;else supplierAdvances+=-net;}
 const inventoryValue=products.reduce((a,p)=>a+finNum(p.stock)*finNum(p.cost),0);
 let payrollDebt=0,payrollAdvances=0;for(const x of payroll){const net=finNum(x.payable)-finNum(x.paid);if(net>=0)payrollDebt+=net;else payrollAdvances+=-net;}
 const year=String(new Date().getFullYear()),y=financeSummary(db,{period:'yearly',value:year}),taxPaidYear=taxPayments.filter(x=>finDate(x.date||x.createdAt).slice(0,4)===year).reduce((a,x)=>a+finNum(x.amount),0),taxNet=y.taxAccrued-taxPaidYear,taxDebt=Math.max(0,taxNet),taxAdvances=Math.max(0,-taxNet);
 const revenueAll=(db.orders||[]).filter(o=>o.status==='done').reduce((a,o)=>a+finNum(o.total),0);
 let cash=finNum(fsx.cashOpening),bank=finNum(fsx.bankOpening);if(fsx.defaultSalesAccount==='cash')cash+=revenueAll;else bank+=revenueAll;
 const subtract=(rows)=>{for(const r of rows){const amt=finNum(r.amount??r.paid),acc=r.account==='cash'?'cash':'bank';if(acc==='cash')cash-=amt;else bank-=amt;}};
 subtract(companyPayments);subtract(db.financeExpenses||[]);subtract(taxPayments);subtract(payroll.map(x=>({amount:x.paid,account:x.account})));
 const receivables=0,otherCurrentAssets=0,otherLiabilities=0;
 const assets=cash+bank+inventoryValue+receivables+supplierAdvances+payrollAdvances+taxAdvances+otherCurrentAssets;
 const liabilities=supplierDebt+payrollDebt+taxDebt+otherLiabilities;
 const equity=assets-liabilities,passiveTotal=liabilities+equity,balanceDifference=assets-passiveTotal;
 return {inventoryValue,supplierDebt,payrollDebt,taxDebt,cash,bank,liquid:cash+bank,receivables,supplierAdvances,payrollAdvances,taxAdvances,otherCurrentAssets,otherLiabilities,assets,liabilities,equity,passiveTotal,balanceDifference,balanced:Math.abs(balanceDifference)<0.01};
}
function financeSeries(db,year){
 const y=String(year||new Date().getFullYear());return Array.from({length:12},(_,i)=>{const month=`${y}-${String(i+1).padStart(2,'0')}`;return {month,...financeSummary(db,{period:'monthly',value:month})}});
}
function financeCompanyBalances(db){
 const out=[];for(const c of db.financeCompanies||[]){const purchases=(db.financePurchases||[]).filter(x=>String(x.companyId)===String(c.id)).reduce((a,x)=>a+finNum(x.total),0),paid=(db.financeCompanyPayments||[]).filter(x=>String(x.companyId)===String(c.id)).reduce((a,x)=>a+finNum(x.amount),0);out.push({...c,purchases,paid,debt:Math.max(0,purchases-paid)})}return out.sort((a,b)=>b.debt-a.debt);
}

app.get('/health',(req,res)=>res.status(200).send('OK'));
app.get('/api/status',(req,res)=>res.json({ok:true,version:'13.26.8',telegramConfigured:Boolean(BOT_TOKEN&&CHAT_ID),adminOnline:true,storage:pool?'postgresql':'local-json',persistent:Boolean(pool),dataFile:DB_FILE}));
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
  const name=clean(b.productName,160), phone=clean(b.phone,40), customer=clean(b.customerName,100), size=clean(b.size,80), comment=clean(b.comment,500), qty=Math.max(1,Math.min(999,Math.floor(Number(b.qty)||1)));
  if(!name||!phone)return res.status(400).json({error:'Mahsulot nomi va telefon raqami majburiy'});
  const image=String(b.image||''); if(image && (!image.startsWith('data:image/')||image.length>3_000_000))return res.status(400).json({error:'Rasm hajmi yoki formati noto‘g‘ri'});
  const requestId='REQ-'+new Date().toISOString().slice(2,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-5);
  const item={requestId,createdAt:new Date().toISOString(),status:'new',productName:name,qty,size,customerName:customer,phone,comment,image:image.slice(0,3_000_000)};
  db.productRequests=db.productRequests||[]; db.productRequests.unshift(item); db.productRequests=db.productRequests.slice(0,1000); audit(db,'mijoz','Mahsulot so‘rovi',requestId+' '+name); await writeDb(db);
  if(BOT_TOKEN&&CHAT_ID){let text=`🔎 YANGI MAHSULOT SO‘ROVI #${requestId}\n\n📦 Mahsulot: ${name}\n🔢 Miqdor: ${qty}\n📐 O‘lcham/Hajm: ${size||'—'}\n👤 Mijoz: ${customer||'—'}\n📞 Telefon: ${phone}\n💬 Izoh: ${comment||'—'}\n🌐 ZARBULOQ.UZ`;try{if(image)text+='\n🖼 Rasm biriktirilgan — Admin panelda ko‘ring.';await tgCall('sendMessage',{chat_id:CHAT_ID,text})}catch(e){console.error('Product request Telegram:',e.message||e)}}
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
app.delete('/api/admin/chats/:sessionId',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId);if(!id)return res.status(400).json({error:'Chat ID noto‘g‘ri'});const db=readDb();const before=(db.chats||[]).length;db.chats=(db.chats||[]).filter(x=>x.sessionId!==id);if(db.chats.length===before)return res.status(404).json({error:'Chat topilmadi'});audit(db,req.adminUser,'Chat o‘chirildi',id);await writeDb(db);res.json({ok:true})});
app.delete('/api/admin/chats',requireAdmin,async(req,res)=>{const db=readDb();const count=(db.chats||[]).length;db.chats=[];audit(db,req.adminUser,'Barcha chatlar o‘chirildi',String(count));await writeDb(db);res.json({ok:true,count})});

app.post('/api/admin/login',(req,res)=>{const u=clean(req.body?.username,80),p=String(req.body?.password||'');const found=USERS.find(x=>x.username===u&&x.password===p);if(!found)return res.status(401).json({error:'Login yoki parol noto‘g‘ri'});const exp=Date.now()+12*60*60*1000;res.setHeader('Set-Cookie',`iob_admin=${signSession(found.username,found.role,exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true,user:found.username,role:found.role});});
app.post('/api/admin/logout',(req,res)=>{res.setHeader('Set-Cookie','iob_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({ok:true,user:req.adminUser,role:req.adminRole}));

app.get('/api/admin/dashboard',requireAdmin,(req,res)=>{
 const db=readDb(),orders=db.orders||[],products=db.products||[],receipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[];const today=new Date().toISOString().slice(0,10),month=today.slice(0,7),year=today.slice(0,4);const done=orders.filter(o=>o.status==='done');
 const costFor=o=>(o.items||[]).reduce((s,i)=>{const p=products.find(x=>Number(x.id)===Number(i.id));return s+(Number(p?.cost||0)*Number(i.qty||1));},0);
 const revenue=done.reduce((s,o)=>s+Number(o.total||0),0),profit=done.reduce((s,o)=>s+Number(o.total||0)-costFor(o),0);const avg=done.length?Math.round(revenue/done.length):0;
 const topMap={};for(const o of done)for(const i of o.items||[]){topMap[i.name]=(topMap[i.name]||0)+Number(i.qty||1)}
 const areaMap={};for(const o of orders){const a=o.customer?.area||'Noma’lum';areaMap[a]=(areaMap[a]||0)+1}
 const last7=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=d.toISOString().slice(0,10);last7.push({date:key,revenue:done.filter(o=>String(o.createdAt).slice(0,10)===key).reduce((s,o)=>s+Number(o.total||0),0),orders:orders.filter(o=>String(o.createdAt||'').slice(0,10)===key).length});}
 // V13.22 dashboard analytics: all history aggregated by month/product/status.
 const monthlyMap=new Map();
 const ensure=(m,p)=>{const k=`${m}|${p.id}`;if(!monthlyMap.has(k))monthlyMap.set(k,{month:m,productId:Number(p.id),receivedQty:0,soldQty:0,soldAmount:0,applicationQty:0,applicationAmount:0,deliveryQty:0,deliveryAmount:0,doneQty:0,doneAmount:0,acceptedQty:0,acceptedAmount:0,cancelledQty:0,cancelledAmount:0});return monthlyMap.get(k)};
 for(const o of orders){const eventDate=['delivery','done','accepted','cancelled'].includes(o.status)?String(o.statusUpdatedAt||o.stockAdjustedAt||o.createdAt||''):String(o.createdAt||'');const om=eventDate.slice(0,7);if(!/^\d{4}-\d{2}$/.test(om))continue;for(const it of o.items||[]){const p=products.find(x=>Number(x.id)===Number(it.id));if(!p)continue;const r=ensure(om,p),qty=Math.max(0,Number(it.qty||0)),unitPrice=Math.max(0,Number(it.price??p.price??0)),amount=qty*unitPrice;if(o.status==='new'){r.applicationQty+=qty;r.applicationAmount+=amount}else if(o.status==='accepted'){r.acceptedQty+=qty;r.acceptedAmount+=amount}else if(o.status==='delivery'){r.deliveryQty+=qty;r.deliveryAmount+=amount;r.soldQty+=qty;r.soldAmount+=amount}else if(o.status==='done'){r.doneQty+=qty;r.doneAmount+=amount;r.soldQty+=qty;r.soldAmount+=amount}else if(o.status==='cancelled'){r.cancelledQty+=qty;r.cancelledAmount+=amount}}}
 for(const rc of receipts){const rm=String(rc.createdAt||'').slice(0,7),p=products.find(x=>Number(x.id)===Number(rc.productId));if(!p||!/^\d{4}-\d{2}$/.test(rm))continue;ensure(rm,p).receivedQty+=Math.max(0,Number(rc.qty)||0)}
 for(const p of products){const cm=String(p.createdAt||'').slice(0,7),initial=Math.max(0,Number(p.receivedQty)||0);if(initial>0&&/^\d{4}-\d{2}$/.test(cm))ensure(cm,p).receivedQty+=initial}
 const years=[...new Set([...monthlyMap.values()].map(r=>Number(String(r.month).slice(0,4))).filter(Boolean))].sort((a,b)=>b-a);if(!years.includes(Number(year)))years.unshift(Number(year));
 const analytics={products:products.map(p=>({id:Number(p.id),name:p.name?.uz||'',nameRu:p.name?.ru||'',unit:p.unit?.uz||'dona',stock:Number(p.stock||0),cost:Number(p.cost||0),price:Number(p.price||0)})),years,monthly:[...monthlyMap.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.productId-b.productId)};
 res.json({role:req.adminRole,financeQuick:{summary:financeSummary(db,{period:'monthly',value:month}),balance:financeCurrentBalance(db)},warehousePurchases:(db.financePurchases||[]).slice().reverse().slice(0,1500).map(x=>{const c=(db.financeCompanies||[]).find(z=>String(z.id)===String(x.companyId)),p=(db.products||[]).find(z=>Number(z.id)===Number(x.productId));return {id:x.id,productId:Number(x.productId),productName:p?.name?.uz||x.productName||'',unit:p?.unit?.uz||x.unit||'',companyId:x.companyId,companyName:c?.name||'',companyInn:c?.inn||'',date:x.date||'',invoice:x.invoice||'',qty:finNum(x.qty),unitCost:finNum(x.unitCost),salePrice:finNum(x.salePrice||x.suggestedSalePrice),total:finNum(x.total)}}),productRequests:(db.productRequests||[]).slice(0,500),chats:(db.chats||[]).slice(0,500),stats:{orders:orders.length,today:orders.filter(o=>String(o.createdAt||'').slice(0,10)===today).length,month:orders.filter(o=>String(o.createdAt||'').slice(0,7)===month).length,year:orders.filter(o=>String(o.createdAt||'').slice(0,4)===year).length,revenue,profit,avg,pending:orders.filter(o=>['new','accepted','delivery'].includes(o.status)).length,cancelled:orders.filter(o=>o.status==='cancelled').length,lowStock:products.filter(p=>Number(p.stock||0)<=5).length,customers:getCustomers(orders).length},orders:orders.slice().reverse().slice(0,300),products,categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',customers:getCustomers(orders),promos:db.promos||[],audit:(db.audit||[]).slice(0,500),analytics,charts:{last7,topProducts:Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,qty])=>({name,qty})),areas:Object.entries(areaMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}))}});
});
app.put('/api/admin/catalog',requireAdmin,requireRole('stock'),async(req,res)=>{const db=readDb(),b=req.body||{};if(Array.isArray(b.products))db.products=b.products.slice(0,700).map(p=>({id:Number(p.id)||Date.now()+Math.floor(Math.random()*1000),cat:clean(p.cat,50),emoji:clean(p.emoji,10)||'🛍️',name:{uz:clean(p.name?.uz,120),ru:clean(p.name?.ru,120)},description:{uz:clean(p.description?.uz,1200),ru:clean(p.description?.ru,1200)},seo:{title:{uz:clean(p.seo?.title?.uz,180),ru:clean(p.seo?.title?.ru,180)},description:{uz:clean(p.seo?.description?.uz,400),ru:clean(p.seo?.description?.ru,400)},keywords:clean(p.seo?.keywords,500)},unit:{uz:clean(p.unit?.uz,30),ru:clean(p.unit?.ru,30)},price:Math.max(0,Number(p.price)||0),cost:Math.max(0,Number(p.cost)||0),oldPrice:Math.max(0,Number(p.oldPrice)||0),stock:Math.max(0,Number(p.stock)||0),receivedQty:Math.max(0,Number(p.receivedQty)||0),legacyOpeningQty:Math.max(0,Number(p.legacyOpeningQty)||0),createdAt:clean(p.createdAt,40),updatedAt:clean(p.updatedAt,40)||new Date().toISOString(),lastReceivedAt:clean(p.lastReceivedAt,40),image:String(p.image||'').slice(0,6_000_000),badge:clean(p.badge,30),featured:Boolean(p.featured)}));if(Array.isArray(b.categories))db.categories=b.categories.slice(0,100);if(b.settings&&typeof b.settings==='object')db.settings=b.settings;if(typeof b.logo==='string')db.logo=b.logo.slice(0,6_000_000);audit(db,req.adminUser,'Katalog/sozlamalar yangilandi');await writeDb(db);res.json({ok:true});});

app.delete('/api/admin/products/:id',requireAdmin,requireRole('stock'),async(req,res)=>{try{const db=readDb(),id=Number(req.params.id),idx=(db.products||[]).findIndex(p=>Number(p.id)===id);if(idx<0)return res.status(404).json({error:'Mahsulot topilmadi'});const p=db.products[idx];db.products.splice(idx,1);audit(db,req.adminUser,'Mahsulot o‘chirildi',`${p.name?.uz||''} (#${id})`);await writeDb(db);res.json({ok:true,id})}catch(e){res.status(400).json({error:e.message||'Mahsulotni o‘chirishda xatolik'})}});
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

app.get('/api/admin/finance',requireAdmin,(req,res)=>{
 const db=readDb(),period=clean(req.query.period,20)||'monthly',value=clean(req.query.value,20),year=clean(req.query.year,4)||String(new Date().getFullYear()),products=db.products||[];
 const sales=(db.orders||[]).filter(o=>['delivery','done'].includes(o.status)&&finPeriodMatch(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt,{period,value})).slice().reverse().slice(0,1200).map(o=>({orderId:o.orderId,date:finDate(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt),status:o.status,customer:o.customer?.name||'',total:finNum(o.total),items:(o.items||[]).map(i=>{const p=products.find(x=>Number(x.id)===Number(i.id));const qty=finNum(i.qty),salePrice=finNum(i.price??p?.price),cost=finNum(p?.cost);return {id:Number(i.id),name:i.name||p?.name?.uz||'',qty,unit:p?.unit?.uz||'dona',salePrice,cost,amount:qty*salePrice,costAmount:qty*cost}})}));
 res.json({ok:true,settings:db.financeSettings||{},companies:financeCompanyBalances(db),purchases:(db.financePurchases||[]).slice().reverse().slice(0,1000),companyPayments:(db.financeCompanyPayments||[]).slice().reverse().slice(0,1000),employees:db.financeEmployees||[],payroll:(db.financePayroll||[]).slice().reverse().slice(0,1000),expenses:(db.financeExpenses||[]).slice().reverse().slice(0,1500),taxPayments:(db.financeTaxPayments||[]).slice().reverse().slice(0,1500),receipts:receiptHistoryRows(db).slice().reverse().slice(0,5000),sales,products:products.map(p=>({id:Number(p.id),name:p.name?.uz||'',nameRu:p.name?.ru||'',stock:finNum(p.stock),cost:finNum(p.cost),price:finNum(p.price),unit:p.unit?.uz||'dona'})),summary:financeSummary(db,{period,value}),balance:financeCurrentBalance(db),series:financeSeries(db,year)});
});
app.put('/api/admin/finance/settings',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},f=db.financeSettings||{};for(const k of ['turnoverTaxRate','payrollIncomeTaxRate','payrollPensionRate','payrollBudgetShareRate','employerSocialTaxRate','landTaxMonthly','propertyTaxRate','propertyTaxBase','otherTaxRate','otherTaxMonthly','cashOpening','bankOpening','defaultMarkupRate'])if(b[k]!==undefined)f[k]=finNum(b[k]);f.payrollTaxRate=finNum(f.payrollIncomeTaxRate ?? f.payrollTaxRate ?? 12);f.otherTaxBase=['revenue','payroll','fixed'].includes(b.otherTaxBase)?b.otherTaxBase:(f.otherTaxBase||'revenue');f.defaultSalesAccount=b.defaultSalesAccount==='cash'?'cash':'bank';db.financeSettings=f;audit(db,req.adminUser,'Finans sozlamalari','Soliq, narx va balans sozlamalari yangilandi');await writeDb(db);res.json({ok:true,settings:f});});
app.post('/api/admin/finance/companies',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},name=clean(b.name,160);if(!name)return res.status(400).json({error:'Firma nomini kiriting'});const c={id:'COM-'+Date.now(),name,inn:clean(b.inn,30),phone:clean(b.phone,40),note:clean(b.note,300),createdAt:new Date().toISOString()};db.financeCompanies.push(c);audit(db,req.adminUser,'Firma qo‘shildi',name);await writeDb(db);res.json({ok:true,company:c});});
app.post('/api/admin/finance/company-payments',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},company=(db.financeCompanies||[]).find(x=>String(x.id)===String(b.companyId)),amount=finNum(b.amount);if(!company||amount<=0)return res.status(400).json({error:'Firma va to‘lov summasini kiriting'});const x={id:'PAY-'+Date.now(),companyId:company.id,amount,date:clean(b.date,10)||new Date().toISOString().slice(0,10),account:b.account==='cash'?'cash':'bank',note:clean(b.note,300),createdAt:new Date().toISOString(),actor:req.adminUser};db.financeCompanyPayments.push(x);audit(db,req.adminUser,'Firmaga to‘lov',`${company.name}: ${money(amount)}`);await writeDb(db);res.json({ok:true,payment:x});});
app.post('/api/admin/finance/purchases',requireAdmin,async(req,res)=>{try{
 const db=readDb(),b=req.body||{},company=(db.financeCompanies||[]).find(x=>String(x.id)===String(b.companyId)),qty=finNum(b.qty),unitCost=finNum(b.unitCost);if(!company||qty<=0||unitCost<=0)return res.status(400).json({error:'Firma, miqdor va xarid narxini kiriting'});
 let product=(db.products||[]).find(x=>Number(x.id)===Number(b.productId)),createdProduct=false;
 if(!product&&b.newProduct&&typeof b.newProduct==='object'){
  const np=b.newProduct,nameUz=clean(np.nameUz,120),nameRu=clean(np.nameRu,120)||nameUz;if(!nameUz)return res.status(400).json({error:'Yangi mahsulot nomini kiriting'});
  const cat=(db.categories||[]).some(c=>String(c.id)===String(np.cat))?clean(np.cat,50):(db.categories?.[0]?.id||'food'),now=new Date().toISOString();
  product={id:Date.now()+crypto.randomInt(10,999),cat,emoji:'🛍️',name:{uz:nameUz,ru:nameRu},description:{uz:clean(np.descriptionUz,1200),ru:clean(np.descriptionRu,1200)||clean(np.descriptionUz,1200)},seo:{title:{uz:'',ru:''},description:{uz:'',ru:''},keywords:''},unit:{uz:clean(np.unitUz,30)||'dona',ru:clean(np.unitRu,30)||'шт'},price:0,cost:0,oldPrice:0,stock:0,receivedQty:0,legacyOpeningQty:0,createdAt:now,updatedAt:now,lastReceivedAt:'',image:'',badge:'YANGI',featured:false};db.products.push(product);createdProduct=true;
 }
 if(!product)return res.status(400).json({error:'Mahsulotni tanlang yoki yangi mahsulot ma’lumotlarini kiriting'});
 const transport=finNum(b.transport),extra=finNum(b.extra),total=qty*unitCost+transport+extra,unitLanded=total/qty,oldQty=finNum(product.stock),oldCost=finNum(product.cost),newQty=oldQty+qty,weighted=newQty>0?((oldQty*oldCost)+total)/newQty:unitLanded,markup=finNum(b.markupRate||db.financeSettings?.defaultMarkupRate),suggested=Math.round(unitLanded*(1+markup/100)),manualSalePrice=finNum(b.salePrice),appliedSalePrice=manualSalePrice>0?manualSalePrice:suggested,date=clean(b.date,10)||new Date().toISOString().slice(0,10),now=new Date().toISOString();
 product.stock=newQty;product.cost=Math.round(weighted);product.price=appliedSalePrice;product.lastReceivedAt=now;product.updatedAt=now;
 const x={id:'PUR-'+Date.now(),companyId:company.id,productId:product.id,productName:product.name?.uz||'',unit:product.unit?.uz||'',qty,unitCost,transport,extra,total,unitLanded:Math.round(unitLanded),markupRate:markup,suggestedSalePrice:suggested,salePrice:appliedSalePrice,date,invoice:clean(b.invoice,80),note:clean(b.note,300),createdAt:now,actor:req.adminUser};
 db.financePurchases.push(x);db.inventoryReceipts.push({receiptId:`RCV-${Date.now()}-${crypto.randomInt(10,99)}`,productId:product.id,qty,createdAt:new Date(date+'T12:00:00').toISOString(),actor:req.adminUser,source:'finance-purchase',purchaseId:x.id,companyId:company.id,companyName:company.name,invoice:x.invoice});
 const paid=finNum(b.paidAmount);if(paid>0)db.financeCompanyPayments.push({id:'PAY-'+Date.now()+'-P',companyId:company.id,amount:Math.min(paid,total),date,account:b.account==='cash'?'cash':'bank',note:`Xarid ${x.id} uchun boshlang‘ich to‘lov`,purchaseId:x.id,createdAt:now,actor:req.adminUser});
 audit(db,req.adminUser,createdProduct?'Yangi mahsulot + finans prixod':'Finans prixod',`${company.name} • ${product.name?.uz||''} × ${qty} • ${money(total)} • sotuv ${money(appliedSalePrice)}`);await writeDb(db);res.json({ok:true,purchase:x,createdProduct,productId:product.id,stock:product.stock,cost:product.cost,suggestedSalePrice:suggested,salePrice:appliedSalePrice});
}catch(e){console.error(e);res.status(500).json({error:'Xaridni saqlab bo‘lmadi'})}});
app.post('/api/admin/finance/employees',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},name=clean(b.name,140),salary=finNum(b.salary);if(!name)return res.status(400).json({error:'Ishchi F.I.Sh. kiriting'});const x={id:'EMP-'+Date.now(),name,position:clean(b.position,100),salary,active:b.active!==false,phone:clean(b.phone,40),startedAt:clean(b.startedAt,10),createdAt:new Date().toISOString()};db.financeEmployees.push(x);audit(db,req.adminUser,'Ishchi qo‘shildi',name);await writeDb(db);res.json({ok:true,employee:x});});

app.patch('/api/admin/finance/employees/:id',requireAdmin,async(req,res)=>{const db=readDb(),x=(db.financeEmployees||[]).find(e=>String(e.id)===String(req.params.id));if(!x)return res.status(404).json({error:'Ishchi topilmadi'});const b=req.body||{};if(b.name!==undefined)x.name=clean(b.name,140)||x.name;if(b.position!==undefined)x.position=clean(b.position,100);if(b.salary!==undefined)x.salary=finNum(b.salary);if(b.phone!==undefined)x.phone=clean(b.phone,40);if(b.startedAt!==undefined)x.startedAt=clean(b.startedAt,10);if(b.active!==undefined)x.active=Boolean(b.active);x.updatedAt=new Date().toISOString();audit(db,req.adminUser,'Ishchi yangilandi',`${x.name} • ${x.active===false?'faolsiz':'faol'}`);await writeDb(db);res.json({ok:true,employee:x});});
app.delete('/api/admin/finance/employees/:id',requireAdmin,async(req,res)=>{const db=readDb(),idx=(db.financeEmployees||[]).findIndex(e=>String(e.id)===String(req.params.id));if(idx<0)return res.status(404).json({error:'Ishchi topilmadi'});const x=db.financeEmployees[idx],hasHistory=(db.financePayroll||[]).some(r=>String(r.employeeId)===String(x.id)),force=String(req.query.force||'')==='1';if(hasHistory&&!force)return res.status(409).json({error:'Bu ishchida oylik tarixi bor. Oddiy o‘chirish hisobotni saqlaydi. Agar bu test yozuvi bo‘lsa “Tarixi bilan tozalash”dan foydalaning.'});if(force)db.financePayroll=(db.financePayroll||[]).filter(r=>String(r.employeeId)!==String(x.id));db.financeEmployees.splice(idx,1);audit(db,req.adminUser,force?'Ishchi va oylik tarixi tozalandi':'Ishchi o‘chirildi',x.name);await writeDb(db);res.json({ok:true,force});});
app.post('/api/admin/finance/employees/:id/reset',requireAdmin,async(req,res)=>{const db=readDb(),x=(db.financeEmployees||[]).find(e=>String(e.id)===String(req.params.id));if(!x)return res.status(404).json({error:'Ishchi topilmadi'});x.salary=0;x.updatedAt=new Date().toISOString();for(const r of db.financePayroll||[]){if(String(r.employeeId)!==String(x.id))continue;r.gross=0;r.bonus=0;r.advance=0;r.deduction=0;r.payable=0;r.paid=0;r.updatedAt=new Date().toISOString();}audit(db,req.adminUser,'Ishchi moliyaviy qiymatlari 0 qilindi',x.name);await writeDb(db);res.json({ok:true});});

app.post('/api/admin/finance/payroll/generate',requireAdmin,async(req,res)=>{const db=readDb(),month=/^\d{4}-\d{2}$/.test(String(req.body?.month||''))?String(req.body.month):new Date().toISOString().slice(0,7);for(const e of (db.financeEmployees||[]).filter(x=>x.active!==false)){if((db.financePayroll||[]).some(x=>x.month===month&&String(x.employeeId)===String(e.id)))continue;const gross=finNum(e.salary);db.financePayroll.push({id:'SAL-'+Date.now()+'-'+crypto.randomInt(100,999),month,employeeId:e.id,name:e.name,baseSalary:gross,bonus:0,advance:0,deduction:0,gross,payable:gross,paid:0,account:'bank',createdAt:new Date().toISOString()});}audit(db,req.adminUser,'Oylik shakllantirildi',month);await writeDb(db);res.json({ok:true});});
app.patch('/api/admin/finance/payroll/:id',requireAdmin,async(req,res)=>{const db=readDb(),x=(db.financePayroll||[]).find(r=>r.id===req.params.id);if(!x)return res.status(404).json({error:'Oylik yozuvi topilmadi'});const b=req.body||{};for(const k of ['bonus','advance','deduction','paid'])if(b[k]!==undefined)x[k]=finNum(b[k]);x.gross=finNum(x.baseSalary)+finNum(x.bonus);x.payable=Math.max(0,x.gross-finNum(x.advance)-finNum(x.deduction));if(b.account)x.account=b.account==='cash'?'cash':'bank';x.updatedAt=new Date().toISOString();audit(db,req.adminUser,'Oylik yangilandi',`${x.name} ${x.month}`);await writeDb(db);res.json({ok:true,payroll:x});});
app.post('/api/admin/finance/expenses',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},amount=finNum(b.amount),name=clean(b.name,140);if(amount<=0||!name)return res.status(400).json({error:'Xarajat nomi va summasini kiriting'});const x={id:'EXP-'+Date.now(),name,category:clean(b.category,60)||'Boshqa',amount,date:clean(b.date,10)||new Date().toISOString().slice(0,10),account:b.account==='cash'?'cash':'bank',note:clean(b.note,300),createdAt:new Date().toISOString(),actor:req.adminUser};db.financeExpenses.push(x);audit(db,req.adminUser,'Xarajat',`${name}: ${money(amount)}`);await writeDb(db);res.json({ok:true,expense:x});});
app.post('/api/admin/finance/tax-payments',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},amount=finNum(b.amount);if(amount<=0)return res.status(400).json({error:'Soliq to‘lov summasini kiriting'});const x={id:'TAX-'+Date.now(),type:clean(b.type,80)||'Boshqa soliq',amount,date:clean(b.date,10)||new Date().toISOString().slice(0,10),account:b.account==='cash'?'cash':'bank',note:clean(b.note,300),createdAt:new Date().toISOString(),actor:req.adminUser};db.financeTaxPayments.push(x);audit(db,req.adminUser,'Soliq to‘lovi',`${x.type}: ${money(amount)}`);await writeDb(db);res.json({ok:true,taxPayment:x});});


app.get('/api/admin/receipts.xls',requireAdmin,(req,res)=>{
 const db=readDb(),esc=htmlEsc,from=clean(req.query.from,10),to=clean(req.query.to,10),status=clean(req.query.status,30),q=clean(req.query.q,120).toLowerCase();
 let rows=receiptHistoryRows(db).slice().reverse().filter(r=>{const d=String(r.createdAt||'').slice(0,10);if(from&&d<from)return false;if(to&&d>to)return false;if(status&&String(r.status)!==status)return false;if(q){const hay=[r.orderId,r.customer?.name,r.customer?.phone,(r.items||[]).map(i=>i.name).join(' ')].join(' ').toLowerCase();if(!hay.includes(q))return false}return true});
 const body=rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.orderId||'')}</td><td>${esc(String(r.createdAt||'').replace('T',' ').slice(0,19))}</td><td>${esc(r.customer?.name||'')}</td><td>${esc(r.customer?.phone||'')}</td><td>${esc(r.customer?.area||'')}</td><td>${esc((r.items||[]).map(x=>`${x.name} × ${x.qty}`).join('; '))}</td><td>${Number(r.subtotal||0)}</td><td>${Number(r.discount||0)}</td><td>${Number(r.deliveryFee||0)}</td><td>${Number(r.total||0)}</td><td>${esc(r.payment||r.customer?.payment||'')}</td><td>${esc(statusLabel(r.status)||r.status||'')}</td></tr>`).join('');
 const total=rows.reduce((a,r)=>a+Number(r.total||0),0);
 const html=`<html><head><meta charset="UTF-8"></head><body><h1>ZARBULOQ.UZ — CHEKLAR TARIXI</h1><p>Jami cheklar: <b>${rows.length}</b> • Jami summa: <b>${total}</b></p><table border="1"><tr><th>#</th><th>Chek / Buyurtma №</th><th>Sana-vaqt</th><th>Mijoz</th><th>Telefon</th><th>Hudud</th><th>Mahsulotlar</th><th>Oraliq summa</th><th>Chegirma</th><th>Yetkazish</th><th>Jami</th><th>To‘lov</th><th>Holat</th></tr>${body}</table></body></html>`;
 res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="ZARBULOQ_CHEKLAR_TARIXI_${new Date().toISOString().slice(0,10)}.xls"`);res.send('﻿'+html);
});

app.get('/api/admin/finance/reconciliation.xls',requireAdmin,(req,res)=>{const db=readDb(),company=(db.financeCompanies||[]).find(c=>String(c.id)===String(req.query.companyId)),from=clean(req.query.from,10),to=clean(req.query.to,10),esc=htmlEsc;if(!company)return res.status(404).send('Firma topilmadi');const purchases=(db.financePurchases||[]).filter(x=>String(x.companyId)===String(company.id)).map(x=>({date:finDate(x.date||x.createdAt),kind:'Prixod',doc:x.invoice||x.id,debit:finNum(x.total),credit:0,note:(db.products||[]).find(p=>Number(p.id)===Number(x.productId))?.name?.uz||''}));const payments=(db.financeCompanyPayments||[]).filter(x=>String(x.companyId)===String(company.id)).map(x=>({date:finDate(x.date||x.createdAt),kind:'To‘lov',doc:x.id,debit:0,credit:finNum(x.amount),note:x.note||''}));const all=[...purchases,...payments].filter(x=>x.date).sort((a,b)=>a.date.localeCompare(b.date));const before=all.filter(x=>from&&x.date<from),opening=before.reduce((s,x)=>s+x.debit-x.credit,0);const rows=all.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to));let bal=opening;const body=rows.map((x,i)=>{bal+=x.debit-x.credit;return `<tr><td>${i+1}</td><td>${esc(x.date)}</td><td>${esc(x.kind)}</td><td>${esc(x.doc)}</td><td>${esc(x.note)}</td><td>${x.debit}</td><td>${x.credit}</td><td>${bal}</td></tr>`}).join('');const deb=rows.reduce((s,x)=>s+x.debit,0),cred=rows.reduce((s,x)=>s+x.credit,0),closing=opening+deb-cred;const html=`<html><head><meta charset="UTF-8"></head><body><h1>IMOM OTA BARAKA — AKT SVERKA</h1><p><b>Firma:</b> ${esc(company.name)} ${company.inn?`• INN: ${esc(company.inn)}`:''}</p><p><b>Davr:</b> ${esc(from||'boshlanishidan')} — ${esc(to||'bugungacha')}</p><table border="1"><tr><th>#</th><th>Sana</th><th>Operatsiya</th><th>Hujjat</th><th>Izoh</th><th>Prixod / Debet</th><th>To‘lov / Kredit</th><th>Qoldiq qarz</th></tr><tr><td colspan="7"><b>Davr boshiga qoldiq</b></td><td><b>${opening}</b></td></tr>${body}<tr><td colspan="5"><b>JAMI</b></td><td><b>${deb}</b></td><td><b>${cred}</b></td><td><b>${closing}</b></td></tr></table><br><p>Yetkazib beruvchi vakili: ____________________</p><p>IMOM OTA BARAKA vakili: ____________________</p></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="AKT_SVERKA_${String(company.name).replace(/[^a-zA-Z0-9_-]+/g,'_')}_${from||'all'}_${to||'today'}.xls"`);res.send('﻿'+html);});

app.get('/api/admin/finance-report.xls',requireAdmin,(req,res)=>{const db=readDb(),period=req.query.period==='yearly'?'yearly':'monthly',value=clean(req.query.value,10)||(period==='yearly'?String(new Date().getFullYear()):new Date().toISOString().slice(0,7)),esc=htmlEsc;const opts={period,value},sum=financeSummary(db,opts),bal=financeCurrentBalance(db),companies=financeCompanyBalances(db),series=period==='yearly'?financeSeries(db,value):[];const rows=period==='yearly'?series.map((m,i)=>`<tr><td>${i+1}</td><td>${esc(m.month)}</td><td>${m.revenue}</td><td>${m.cogs}</td><td>${m.grossProfit}</td><td>${m.payrollGross}</td><td>${m.otherExpenses}</td><td>${m.taxAccrued}</td><td>${m.netProfit}</td></tr>`).join(''):`<tr><td>${esc(value)}</td><td>${sum.revenue}</td><td>${sum.cogs}</td><td>${sum.grossProfit}</td><td>${sum.payrollGross}</td><td>${sum.otherExpenses}</td><td>${sum.taxAccrued}</td><td>${sum.netProfit}</td></tr>`;const html=`<html><head><meta charset="UTF-8"></head><body><h1>IMOM OTA BARAKA — ${period==='yearly'?'Yillik / Годовой':'Oylik / Месячный'} moliyaviy hisobot ${esc(value)}</h1><h2>Yagona moliyaviy natija</h2><table border="1"><tr><th>Davr</th><th>Sotuv aylanmasi</th><th>Sotilgan mahsulot tannarxi</th><th>Yalpi foyda</th><th>Oyliklar</th><th>Boshqa xarajatlar</th><th>Hisoblangan soliqlar</th><th>Sof natija</th></tr>${rows}</table><h2>Soliqlar</h2><table border="1"><tr><th>Aylanma solig‘i</th><th>Oylik solig‘i</th><th>Yer solig‘i</th><th>Mol-mulk solig‘i</th><th>Boshqa soliq</th><th>Jami hisoblangan</th><th>To‘langan</th><th>Qarz</th></tr><tr><td>${sum.turnoverTax}</td><td>${sum.payrollTax}</td><td>${sum.landTax}</td><td>${sum.propertyTax}</td><td>${sum.otherTax}</td><td>${sum.taxAccrued}</td><td>${sum.taxPaid}</td><td>${sum.taxDebt}</td></tr></table><h2>Firmalar va qarzdorlik</h2><table border="1"><tr><th>Firma</th><th>Olingan mahsulotlar</th><th>To‘langan</th><th>Qarz</th></tr>${companies.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.purchases}</td><td>${c.paid}</td><td>${c.debt}</td></tr>`).join('')}</table><h2>ERP PRO BALANS</h2><table border="1" cellspacing="0" cellpadding="5"><tr style="background:#dfeee8;font-weight:bold"><th colspan="2">AKTIVLAR</th><th colspan="2">PASSIVLAR</th></tr><tr><td>Kassa</td><td>${bal.cash}</td><td>Firmalarga qarz</td><td>${bal.supplierDebt}</td></tr><tr><td>Bank</td><td>${bal.bank}</td><td>Ish haqi qarzi</td><td>${bal.payrollDebt}</td></tr><tr><td>Ombordagi tovarlar</td><td>${bal.inventoryValue}</td><td>Soliq qarzi</td><td>${bal.taxDebt}</td></tr><tr><td>Debitor qarzdorlik</td><td>${bal.receivables||0}</td><td>Boshqa majburiyatlar</td><td>${bal.otherLiabilities||0}</td></tr><tr><td>Yetkazib beruvchilarga avans</td><td>${bal.supplierAdvances||0}</td><td><b>Jami majburiyatlar</b></td><td><b>${bal.liabilities}</b></td></tr><tr><td>Boshqa joriy aktivlar</td><td>${bal.otherCurrentAssets||0}</td><td>Kapital / Netto (avtomatik)</td><td>${bal.equity}</td></tr><tr style="font-weight:bold"><td>JAMI AKTIV</td><td>${bal.assets}</td><td>JAMI PASSIV</td><td>${bal.passiveTotal}</td></tr><tr><td colspan="3"><b>Balans holati</b></td><td><b>${bal.balanced?'TENG':'FARQ BOR'} (${bal.balanceDifference})</b></td></tr></table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="IMOM_OTA_BARAKA_FINANS_${period}_${value}.xls"`);res.send('\ufeff'+html);});

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
 const db=readDb(),month=/^\d{4}-\d{2}$/.test(String(req.query.month||''))?String(req.query.month):new Date().toISOString().slice(0,7),start=month+'-01',end=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).toISOString().slice(0,10),orders=db.orders||[],receipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[],purchases=Array.isArray(db.financePurchases)?db.financePurchases:[],companies=Array.isArray(db.financeCompanies)?db.financeCompanies:[];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const soldDate=o=>String(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt||'').slice(0,10);
 const soldQty=(pid,from,to)=>orders.filter(o=>['delivery','done'].includes(o.status)&&(!from||soldDate(o)>=from)&&(!to||soldDate(o)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const applicationQty=(pid,from,to)=>orders.filter(o=>o.status==='new'&&(!from||String(o.createdAt||'').slice(0,10)>=from)&&(!to||String(o.createdAt||'').slice(0,10)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const receiptEvents=p=>{const arr=[];const initialQty=Math.max(0,Number(p.receivedQty??0)),initialDate=String(p.createdAt||'').slice(0,10);if(initialQty>0&&initialDate)arr.push({qty:initialQty,date:initialDate,initial:true});for(const r of receipts){if(Number(r.productId)!==Number(p.id))continue;const date=String(r.createdAt||'').slice(0,10),qty=Math.max(0,Number(r.qty)||0);if(qty>0&&date)arr.push({qty,date,initial:false});}return arr;};
 const rows=(db.products||[]).map(p=>{const events=receiptEvents(p),legacyOpening=Math.max(0,Number(p.legacyOpeningQty)||0),receivedBefore=events.filter(r=>r.date<start).reduce((a,r)=>a+r.qty,0),receivedMonth=events.filter(r=>r.date>=start&&r.date<=end).reduce((a,r)=>a+r.qty,0),soldBefore=soldQty(p.id,'',new Date(new Date(start+'T00:00:00').getTime()-86400000).toISOString().slice(0,10)),opening=Math.max(0,legacyOpening+receivedBefore-soldBefore),sold=soldQty(p.id,start,end),applications=applicationQty(p.id,start,end),closing=Math.max(0,opening+receivedMonth-sold),dates=[...new Set(events.filter(r=>r.date>=start&&r.date<=end).map(r=>r.date))].join(', ')||'—',pp=purchases.filter(x=>Number(x.productId)===Number(p.id)&&String(x.date||x.createdAt||'').slice(0,7)===month),firmas=[...new Set(pp.map(x=>{const c=companies.find(c=>String(c.id)===String(x.companyId));return c?`${c.name}${c.inn?' (INN '+c.inn+')':''}`:''}).filter(Boolean))].join('; ')||'—',docs=[...new Set(pp.map(x=>x.invoice).filter(Boolean))].join(', ')||'—';return `<tr><td>${esc(p.name?.uz)}</td><td>${esc(p.name?.ru)}</td><td>${esc(p.unit?.uz||'dona')}</td><td>${Number(p.cost||0)}</td><td>${Number(p.price||0)}</td><td>${opening}</td><td>${receivedMonth}</td><td>${esc(firmas)}</td><td>${esc(docs)}</td><td>${sold}</td><td>${applications}</td><td>${closing}</td><td>${Number(p.stock||0)}</td><td>${esc(dates)}</td></tr>`}).join('');
 const detail=purchases.filter(x=>String(x.date||x.createdAt||'').slice(0,7)===month).sort((a,b)=>String(a.date).localeCompare(String(b.date))).map((x,i)=>{const c=companies.find(c=>String(c.id)===String(x.companyId)),p=(db.products||[]).find(p=>Number(p.id)===Number(x.productId));return `<tr><td>${i+1}</td><td>${esc(x.date||'')}</td><td>${esc(c?.name||'—')}</td><td>${esc(c?.inn||'—')}</td><td>${esc(p?.name?.uz||x.productName||'')}</td><td>${Number(x.qty||0)}</td><td>${Number(x.unitCost||0)}</td><td>${Number(x.salePrice||0)}</td><td>${Number(x.total||0)}</td><td>${esc(x.invoice||'—')}</td></tr>`}).join('');
 const html=`<html><head><meta charset="UTF-8"></head><body><h2>IMOM OTA BARAKA — Ombor hisoboti ${esc(month)}</h2><table border="1"><tr><th>Mahsulot nomi</th><th>Название товара</th><th>Birlik</th><th>Tannarxi</th><th>Sotuv narxi</th><th>Oy boshiga ostatka</th><th>Qabul qilingan</th><th>Yetkazib beruvchi firma / INN</th><th>Nakladnoy / hujjat №</th><th>Sotilgan (Yetkazilmoqda + Yakunlandi)</th><th>Zayavka (Yangi)</th><th>Oy oxiriga qoldiq</th><th>Joriy qoldiq</th><th>Qabul sanasi</th></tr>${rows}</table><br><h3>${esc(month)} — Firma bo‘yicha prixod tafsilotlari</h3><table border="1"><tr><th>#</th><th>Sana</th><th>Firma</th><th>INN</th><th>Mahsulot</th><th>Miqdor</th><th>Xarid narxi</th><th>Sotuv narxi</th><th>Jami</th><th>Hujjat №</th></tr>${detail||'<tr><td colspan="10">Bu oy firma prixodi yo‘q</td></tr>'}</table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-ombor-${month}.xls"`);res.send('\ufeff'+html);
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
 db.orders=db.orders||[];db.orders.push(order);db.receiptHistory=db.receiptHistory||[];db.receiptHistory.push({orderId:order.orderId,createdAt:order.createdAt,status:order.status,customer:order.customer,items:order.items,subtotal:order.subtotal,discount:order.discount,deliveryFee:Number(order.deliveryFee||0),total:order.total,payment:order.customer?.payment||'Naqd',source:'order'});audit(db,'customer','Yangi buyurtma',`${orderId} • ${money(total)}`);await writeDb(db);
 if(BOT_TOKEN&&CHAT_ID){try{const msg=await tgCall('sendMessage',{chat_id:CHAT_ID,text:orderText(order),reply_markup:statusKeyboard(orderId,'new')});const db2=readDb(),o=db2.orders.find(x=>x.orderId===orderId);if(o){o.telegram={chatId:String(msg.chat.id),messageId:msg.message_id};await writeDb(db2);}}catch(e){console.error('Telegram send error:',e.message);return res.json({ok:true,orderId,total,discount,order,warning:'Buyurtma saqlandi, lekin Telegramga yuborilmadi'});}}
 res.json({ok:true,orderId,total,discount,order});
});

async function updateOrderStatus(orderId,status,actor='admin'){
 const allowed=['new','accepted','delivery','done','cancelled'];if(!allowed.includes(status))throw new Error('Invalid status');const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===orderId);if(!o)throw new Error('Order not found');const prev=o.status,soldStatuses=['delivery','done'],wasSold=soldStatuses.includes(prev)&&o.stockAdjusted===true,willSold=soldStatuses.includes(status);if(willSold&&!wasSold){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p){if(Number(p.stock||0)<Number(it.qty||0))throw new Error(`${p.name?.uz||'Mahsulot'} omborda yetarli emas`);p.stock=Math.max(0,Number(p.stock||0)-Number(it.qty||0));}}o.stockAdjusted=true;o.stockAdjustedAt=new Date().toISOString()}else if(!willSold&&wasSold){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p)p.stock=Number(p.stock||0)+Number(it.qty||0)}o.stockAdjusted=false;o.stockAdjustedAt=''}o.status=status;o.statusUpdatedAt=new Date().toISOString();audit(db,actor,'Buyurtma statusi',`${orderId}: ${prev} → ${status}`);await writeDb(db);
 if(BOT_TOKEN&&o.telegram?.chatId&&o.telegram?.messageId){try{await tgCall('editMessageText',{chat_id:o.telegram.chatId,message_id:o.telegram.messageId,text:orderText(o),reply_markup:['done','cancelled'].includes(status)?{inline_keyboard:[]}:statusKeyboard(o.orderId,status)});}catch(e){console.error('Telegram edit error:',e.message)}}return o;
}
app.patch('/api/admin/orders/:id/status',requireAdmin,requireRole('operator'),async(req,res)=>{try{const o=await updateOrderStatus(req.params.id,String(req.body?.status||''),req.adminUser);res.json({ok:true,order:o});}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/admin/orders/:id',requireAdmin,requireRole('operator'),async(req,res)=>{try{const db=readDb(),idx=(db.orders||[]).findIndex(x=>String(x.orderId)===String(req.params.id));if(idx<0)return res.status(404).json({error:'Buyurtma topilmadi'});const o=db.orders[idx];if(o.stockAdjusted===true&&['delivery','done'].includes(o.status)){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p)p.stock=Number(p.stock||0)+Number(it.qty||0);}}db.orders.splice(idx,1);audit(db,req.adminUser,'Buyurtma o‘chirildi',String(o.orderId));await writeDb(db);res.json({ok:true,deleted:o.orderId})}catch(e){res.status(400).json({error:e.message})}});


let polling=false,offset=0;
async function pollTelegram(){if(!BOT_TOKEN||polling)return;polling=true;try{try{await tgCall('deleteWebhook',{drop_pending_updates:false});}catch{}console.log('Telegram order-status buttons: polling started');while(true){try{const updates=await tgCall('getUpdates',{offset,timeout:25,allowed_updates:['callback_query']});for(const u of updates){offset=Math.max(offset,u.update_id+1);const q=u.callback_query;if(!q)continue;const [kind,status,orderId]=String(q.data||'').split('|');if(kind!=='st')continue;try{await updateOrderStatus(orderId,status,'telegram');await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:statusLabel(status)});}catch(e){await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik'}).catch(()=>{});console.error('Callback error:',e.message)}}}catch(e){console.error('Telegram polling error:',e.message);await new Promise(r=>setTimeout(r,4000));}}}finally{polling=false}}

async function start(){
 try{
  await initStorage();
  app.listen(PORT,()=>{
   console.log(`IMOM OTA BARAKA v13.26.9 INSTANT CUSTOMER RECEIPT + REALTIME ZARBULOQ / zarbuloq.uz: http://localhost:${PORT}`);
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
