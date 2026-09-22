const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const XLSX = require('xlsx');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim() ||
  crypto.createHash('sha256')
    .update([process.env.DATABASE_URL||'',process.env.ADMIN_PASSWORD||'',process.env.TELEGRAM_BOT_TOKEN||'',__dirname].join('|'))
    .digest('hex');
const TELEGRAM_WEBHOOK_URL = String(process.env.TELEGRAM_WEBHOOK_URL || 'https://zarbuloq.uz/api/telegram/webhook').trim();
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || crypto.createHash('sha256').update(SESSION_SECRET).digest('hex').slice(0,48));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
const DB_FILE = path.join(DATA_DIR,'shop.json');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const DATABASE_SSL = String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false';
const REQUIRE_DATABASE = String(process.env.REQUIRE_DATABASE || 'false').toLowerCase() === 'true';
const pool = DATABASE_URL ? new Pool({
 connectionString:DATABASE_URL,
 ssl:DATABASE_SSL?{rejectUnauthorized:false}:false,
 max:8,
 idleTimeoutMillis:120000,
 connectionTimeoutMillis:20000,
 keepAlive:true,
 keepAliveInitialDelayMillis:10000,
 allowExitOnIdle:false,
 application_name:'zarbuloq-v13.26.75'
}) : null;
if(pool) pool.on('error',err=>console.error('PostgreSQL pool error:',err.code||'',err.message));

const DB_RETRY_CODES=new Set(['57P01','57P02','57P03','08000','08001','08003','08004','08006','08007','08P01','53300']);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function transientDbError(err){
 const code=String(err?.code||'');
 const msg=String(err?.message||'').toLowerCase();
 return DB_RETRY_CODES.has(code) ||
   /econnreset|econnrefused|etimedout|connection terminated|connection timeout|server closed the connection|terminating connection|socket hang up|network/.test(msg);
}
async function dbQuery(text,params=[],opts={}){
 if(!pool)throw new Error('PostgreSQL configured emas');
 const retries=Number.isFinite(Number(opts.retries))?Number(opts.retries):3;
 let lastErr;
 for(let attempt=0;attempt<=retries;attempt++){
  try{return await pool.query(text,params)}
  catch(err){
   lastErr=err;
   if(attempt>=retries || !transientDbError(err))throw err;
   const wait=Math.min(5000,500*(2**attempt));
   console.warn(`PostgreSQL transient error (${err.code||err.message}); retry ${attempt+1}/${retries} in ${wait}ms`);
   await sleep(wait);
  }
 }
 throw lastErr;
}
let dbCache = null;
let persistChain = Promise.resolve();
// V13.26.75 — ADMIN PRODUCT SYNC FIX + SECURITY HARDENED; durable product guard preserved.
// Keeps the last successfully committed product snapshots separately from dbCache so an
// accidental full-state overwrite can never silently remove products.
let committedProducts = new Map();
function cloneProductSafe(p){ try{return JSON.parse(JSON.stringify(p))}catch{return {...p}} }
function rememberCommittedProducts(db){
  committedProducts = new Map((db?.products||[]).map(p=>[String(Number(p.id)),cloneProductSafe(p)]));
}


// V13.26.20 — tashriflar statistikasi
const onlineVisitors = new Map();
const VISITOR_ONLINE_MS = 2 * 60 * 1000;
function uzDayKey(value=new Date()){
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
  catch{return new Date(value).toISOString().slice(0,10);}
}
function visitorDevice(ua=''){ua=String(ua||'').toLowerCase();if(/ipad|tablet/.test(ua))return 'Planshet';if(/mobi|android|iphone/.test(ua))return 'Telefon';return 'Kompyuter';}
function visitorStats(db){
  db=normalizeDb(db||initialDb());
  const rows=Array.isArray(db.visits)?db.visits:[], now=Date.now(), today=uzDayKey(now);
  const dayMs=86400000, cutoff7=now-6*dayMs, cutoff30=now-29*dayMs;
  const todayRows=rows.filter(x=>uzDayKey(x.at)===today), last7=rows.filter(x=>new Date(x.at).getTime()>=cutoff7), last30=rows.filter(x=>new Date(x.at).getTime()>=cutoff30);
  for(const [id,v] of [...onlineVisitors]) if(now-Number(v.lastSeen||0)>VISITOR_ONLINE_MS) onlineVisitors.delete(id);
  const unique=a=>new Set(a.map(x=>x.visitorId).filter(Boolean)).size;
  const series=[];for(let i=6;i>=0;i--){const d=new Date(now-i*dayMs),key=uzDayKey(d);const rs=rows.filter(x=>uzDayKey(x.at)===key);series.push({date:key,visits:rs.length,unique:unique(rs)});}
  return {today:todayRows.length,todayUnique:unique(todayRows),last7:last7.length,last7Unique:unique(last7),last30:last30.length,last30Unique:unique(last30),total:rows.length,uniqueTotal:unique(rows),online:onlineVisitors.size,series};
}

// V13.15 SEO + REALTIME — Server-Sent Events (SSE)
// Only a tiny change signal is broadcast. Clients fetch fresh data through normal APIs.
const realtimeClients = new Set();
let realtimeRevision = 0;
// V13.26.59 — Android ilova boshqaruvi uchun alohida real-time SSE kanal.
// Katta banner/base64 ma'lumotlar SSE orqali yuborilmaydi; faqat revision/reason yuboriladi,
// ilova esa /api/app-config dan yangi holatni oladi.
const appRealtimeClients = new Set();
let appRealtimeRevision = 0;
function broadcastAppRealtime(reason='app-control'){
  appRealtimeRevision += 1;
  const payload = `event: app-update\ndata: ${JSON.stringify({reason,revision:appRealtimeRevision,at:new Date().toISOString()})}\n\n`;
  for(const res of [...appRealtimeClients]){
    try{res.write(payload)}catch{appRealtimeClients.delete(res)}
  }
}

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

if(process.env.NODE_ENV==='production'){
  if(!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD==='change-me'){
    console.warn('SECURITY WARNING: ADMIN_PASSWORD hali kuchli qiymatga almashtirilmagan.');
  }
  if(!process.env.SESSION_SECRET){
    console.warn('SECURITY NOTICE: SESSION_SECRET yo‘q; server kuchli deterministic fallback secret ishlatmoqda. Alohida SESSION_SECRET tavsiya etiladi.');
  }
}

// SECURITY v13.26.74 — request size guard before JSON parsing.
// Public endpoints do not need giant bodies; admin image/app-control payloads keep the larger limit.
app.use((req,res,next)=>{
  const len=Number(req.headers['content-length']||0);
  const adminPath=req.path.startsWith('/api/admin/');
  const limit=adminPath?60*1024*1024:5*1024*1024;
  if(len && len>limit)return res.status(413).json({error:'So‘rov hajmi juda katta'});
  next();
});
app.use(express.json({limit:'55mb'}));

// V13.26.63 — Excel URL rasmlarini PRO prays/PDF uchun same-origin proxy orqali yuklash.
// html2canvas boshqa domen rasmlarini CORS sabab canvasga chiza olmaydi; proxy faqat ommaviy image/* URLlarni qaytaradi.
function isPrivateIpv4(host=''){
  const m=String(host||'').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if(!m)return false;
  const a=m.slice(1).map(Number);if(a.some(n=>n<0||n>255))return true;
  return a[0]===10 || a[0]===127 || a[0]===0 || (a[0]===100&&a[1]>=64&&a[1]<=127) ||
    (a[0]===169&&a[1]===254) || (a[0]===172&&a[1]>=16&&a[1]<=31) ||
    (a[0]===192&&a[1]===168) || a[0]>=224;
}
function isPrivateIpAddress(addr=''){
  const ip=String(addr||'').toLowerCase();
  if(net.isIPv4(ip))return isPrivateIpv4(ip);
  if(net.isIPv6(ip)){
    return ip==='::1'||ip==='::'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe8')||
      ip.startsWith('fe9')||ip.startsWith('fea')||ip.startsWith('feb')||ip.startsWith('::ffff:127.')||
      ip.startsWith('::ffff:10.')||ip.startsWith('::ffff:192.168.');
  }
  return true;
}
function safeRemoteImageUrl(raw=''){
  try{
    const u=new URL(String(raw||'').trim());
    if(!['http:','https:'].includes(u.protocol))return null;
    if(u.username||u.password)return null;
    const h=String(u.hostname||'').toLowerCase();
    if(!h || h==='localhost' || h.endsWith('.local') || isPrivateIpAddress(h))return null;
    return u.href;
  }catch{return null}
}
async function assertPublicRemoteUrl(raw){
  const safe=safeRemoteImageUrl(raw);if(!safe)throw new Error('Rasm URL xavfsiz yoki to‘g‘ri emas');
  const u=new URL(safe);
  const rows=await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!rows.length || rows.some(x=>isPrivateIpAddress(x.address)))throw new Error('Rasm manzili ichki tarmoqqa olib boradi');
  return u;
}
async function fetchRemoteImage(raw,{maxBytes=6_000_000,timeoutMs=12_000}={}){
  let current=(await assertPublicRemoteUrl(raw)).href;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    let r;
    for(let redirects=0;redirects<=3;redirects++){
      r=await fetch(current,{redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 ZARBULOQ-ImageProxy/1.1','Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'}});
      if([301,302,303,307,308].includes(r.status)){
        const loc=r.headers.get('location');if(!loc)throw new Error('Rasm redirect noto‘g‘ri');
        current=new URL(loc,current).href;
        current=(await assertPublicRemoteUrl(current)).href;
        continue;
      }
      break;
    }
    if(!r||!r.ok)throw new Error(`Rasm serveri HTTP ${r?.status||0}`);
    const type=String(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/i.test(type))throw new Error('URL rasm fayliga olib bormadi');
    const len=Number(r.headers.get('content-length')||0);if(len&&len>maxBytes)throw new Error('Rasm juda katta');
    const ab=await r.arrayBuffer();if(ab.byteLength>maxBytes)throw new Error('Rasm juda katta');
    return {buffer:Buffer.from(ab),type:type==='image/jpg'?'image/jpeg':type,url:current};
  }finally{clearTimeout(timer)}
}
app.get('/api/image-proxy',async(req,res)=>{
  try{
    const img=await fetchRemoteImage(req.query.url,{maxBytes:6_000_000,timeoutMs:12_000});
    res.setHeader('Content-Type',img.type);
    res.setHeader('Cache-Control','public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.send(img.buffer);
  }catch(e){res.status(404).type('text/plain').send('Rasm yuklanmadi')}
});

// V13.16 PRODUCT SEO — har bir mahsulot uchun Google indekslaydigan alohida sahifa.
function seoSlug(value=''){
  // Latin + Russian/Cyrillic names are converted to stable ASCII slugs for Google-friendly URLs.
  const translitMap={
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  const raw=String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  const latin=[...raw].map(ch=>translitMap[ch]??ch).join('');
  return latin
    .replace(/[ʻʼ‘’`´']/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0,90) || 'mahsulot';
}
function productSlug(p,lang='uz'){return `${seoSlug(p?.name?.[lang] || p?.name?.uz || p?.name?.ru || 'mahsulot')}-${Number(p?.id)||0}`;}
function htmlEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function xmlEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function stripProductIdFromSlug(slug=''){
  return String(slug||'').replace(/-\d+$/,'').replace(/^-+|-+$/g,'');
}
function productSlugBases(p){
  return ['uz','ru']
    .map(lang=>seoSlug(p?.name?.[lang]||''))
    .filter(Boolean)
    .filter(x=>x!=='mahsulot');
}
function legacySlugScore(a,b){
  a=stripProductIdFromSlug(a);b=stripProductIdFromSlug(b);
  if(!a||!b)return 0;
  if(a===b)return 1;
  const aa=new Set(a.split('-').filter(Boolean)),bb=new Set(b.split('-').filter(Boolean));
  if(!aa.size||!bb.size)return 0;
  let common=0;for(const x of aa)if(bb.has(x))common++;
  return (2*common)/(aa.size+bb.size);
}
function productBySlug(db,slug){
  const products=db.products||[],incoming=String(slug||'');
  const idMatch=incoming.match(/-(\d+)$/);
  if(idMatch){
    const p=products.find(x=>Number(x.id)===Number(idMatch[1]));
    if(p)return p;
  }
  // Current canonical slugs in any supported language.
  const exact=products.find(p=>['uz','ru'].some(lang=>productSlug(p,lang)===incoming));
  if(exact)return exact;

  // Legacy URLs often keep the old product id after a product was re-created.
  // Match the human-readable slug part to the current product name automatically.
  const base=stripProductIdFromSlug(incoming);
  const exactLegacy=products.filter(p=>productSlugBases(p).includes(base));
  if(exactLegacy.length===1)return exactLegacy[0];

  // Conservative fuzzy fallback: redirect only when one product is a very strong unique match.
  const scored=products.map(p=>({p,score:Math.max(0,...productSlugBases(p).map(x=>legacySlugScore(base,x)))}))
    .filter(x=>x.score>=0.86).sort((a,b)=>b.score-a.score);
  if(scored.length && (!scored[1] || scored[0].score-scored[1].score>=0.12))return scored[0].p;
  return null;
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

app.get('/robots.txt',(req,res)=>{
  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control','public, max-age=300');
  res.send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin.html',
    'Disallow: /api/admin/',
    'Disallow: /downloads/',
    '',
    'Sitemap: https://zarbuloq.uz/sitemap.xml',
    ''
  ].join('\n'));
});

app.get('/sitemap.xml',(req,res)=>{
  const db=readDb();
  const today=new Date().toISOString().slice(0,10);
  const validDate=(value)=>{
    const raw=String(value||'').trim();
    if(/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);
    const d=new Date(value);
    return Number.isNaN(d.getTime()) ? today : d.toISOString().slice(0,10);
  };
  const productUrls=(db.products||[]).flatMap(p=>{
    const last=validDate(p.updatedAt||p.lastReceivedAt||p.createdAt||today);
    const entries=[
      {lang:'uz',url:`https://zarbuloq.uz/mahsulot/${productSlug(p,'uz')}`},
      {lang:'ru',url:`https://zarbuloq.uz/ru/mahsulot/${productSlug(p,'ru')}`}
    ];
    return entries.map(entry=>[
      '  <url>',
      `    <loc>${xmlEsc(entry.url)}</loc>`,
      `    <lastmod>${xmlEsc(last)}</lastmod>`,
      '    <changefreq>daily</changefreq>',
      '    <priority>0.9</priority>',
      ...entries.map(alt=>`    <xhtml:link rel="alternate" hreflang="${alt.lang}" href="${xmlEsc(alt.url)}"/>`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEsc(entries[0].url)}"/>`,
      '  </url>'
    ].join('\n'));
  });
  const home=[
    '  <url>',
    '    <loc>https://zarbuloq.uz/</loc>',
    `    <lastmod>${today}</lastmod>`,
    '    <changefreq>daily</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>'
  ].join('\n');
  const xml=[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    home,
    ...productUrls,
    '</urlset>',
    ''
  ].join('\n');
  // Final sitemap response: write headers + body directly so Express cannot
  // reinterpret the XML string as HTML.
  res.writeHead(200,{
    'Content-Type':'application/xml; charset=utf-8',
    'Content-Disposition':'inline; filename="sitemap.xml"',
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':'no-cache, no-store, must-revalidate',
    'Pragma':'no-cache',
    'Expires':'0'
  });
  return res.end(xml,'utf8');
});

app.get('/api/seo-status',(req,res)=>{
  const db=readDb();
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,
    version:'13.26.56',
    robots:'/robots.txt',
    sitemap:'/sitemap.xml',
    productCount:Array.isArray(db.products)?db.products.length:0,
    sitemapContentType:'application/xml; charset=utf-8'
  });
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
  const db=readDb(),rawProduct=productBySlug(db,req.params.slug),p=rawProduct?publicProductWithPromotion(db,rawProduct):null;
  const prefix=lang==='ru'?'/ru/mahsulot/':'/mahsulot/';
  if(!p){
    // A genuinely removed product should disappear from Google cleanly instead of lingering as a soft 404.
    res.status(410);
    res.setHeader('X-Robots-Tag','noindex, follow');
    return res.send(`<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><title>Mahsulot mavjud emas | ZARBULOQ.UZ</title></head><body style="font-family:Arial;padding:40px"><h1>Mahsulot hozir mavjud emas</h1><p>Mahsulot katalogdan o‘chirilgan yoki manzili yangilangan.</p><p><a href="/#products">Barcha mahsulotlarni ko‘rish</a></p></body></html>`);
  }
  const canonicalSlug=productSlug(p,lang);if(req.params.slug!==canonicalSlug)return res.redirect(301,prefix+canonicalSlug);
  const isRu=lang==='ru',name=p.name?.[lang]||p.name?.uz||'Mahsulot',catObj=productCategory(db,p),cat=catObj?.name?.[lang]||catObj?.name?.uz||(isRu?'Товар':'Mahsulot');
  const customDesc=p.seo?.description?.[lang]||p.description?.[lang]||p.description?.uz||'',desc=customDesc||productDescription(db,p),img=productImageUrl(p),price=Number(p.price||0),old=Number(p.oldPrice||0),stock=Number(p.stock||0),unit=p.unit?.[lang]||p.unit?.uz||'';
  const url=`https://zarbuloq.uz${prefix}${canonicalSlug}`;
  const alternates=[
    {lang:'uz',url:`https://zarbuloq.uz/mahsulot/${productSlug(p,'uz')}`},
    {lang:'ru',url:`https://zarbuloq.uz/ru/mahsulot/${productSlug(p,'ru')}`}
  ];
  const seoReviews=(db.productReviews||[]).filter(r=>String(r.productId)===String(p.id)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))),seoSummary=reviewSummary(seoReviews);
  const autoTitle=isRu?`${name} — цена | ZARBULOQ.UZ`:`${name} narxi | ZARBULOQ.UZ`,title=p.seo?.title?.[lang]||autoTitle,stockText=stock>0?(isRu?`В наличии: ${stock}${unit?' '+unit:''}`:`Omborda: ${stock}${unit?' '+unit:''}`):(isRu?'Нет в наличии':'Omborda yo‘q'),keywords=p.seo?.keywords||[p.name?.uz,p.name?.ru,catObj?.name?.uz,catObj?.name?.ru,'ZARBULOQ.UZ','Parkent'].filter(Boolean).join(', ');
  const schema={'@context':'https://schema.org','@type':'Product',name,alternateName:[p.name?.uz,p.name?.ru].filter(Boolean),description:desc,image:[img],sku:String(p.sku||p.id),category:cat,brand:{'@type':'Brand',name:'IMOM OTA BARAKA'},offers:{'@type':'Offer',url,priceCurrency:'UZS',price,availability:stock>0?'https://schema.org/InStock':'https://schema.org/OutOfStock',itemCondition:'https://schema.org/NewCondition',seller:{'@type':'Organization',name:'IMOM OTA BARAKA',url:'https://zarbuloq.uz/'}},...(seoSummary.count?{aggregateRating:{'@type':'AggregateRating',ratingValue:seoSummary.average,reviewCount:seoSummary.count}}:{})};
  const oldPrice=old>price?`<span class="old">${old.toLocaleString('ru-RU')} ${isRu?'сум':'so‘m'}</span>`:'';
  res.setHeader('X-Robots-Tag','index, follow, max-image-preview:large');
  res.send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEsc(title)}</title><meta name="description" content="${htmlEsc(desc)}"><meta name="keywords" content="${htmlEsc(keywords)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="${htmlEsc(url)}">${alternates.map(a=>`<link rel="alternate" hreflang="${a.lang}" href="${htmlEsc(a.url)}">`).join('')}<link rel="alternate" hreflang="x-default" href="${htmlEsc(alternates[0].url)}"><meta property="og:type" content="product"><meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}"><meta property="og:url" content="${htmlEsc(url)}"><meta property="og:image" content="${htmlEsc(img)}"><meta property="product:price:amount" content="${price}"><meta property="product:price:currency" content="UZS"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"><meta name="twitter:image" content="${htmlEsc(img)}"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f5faf5;color:#17351f}.wrap{max-width:1100px;margin:auto;padding:22px}.top{display:flex;align-items:center;gap:14px;margin-bottom:24px}.top img{width:58px;height:58px;object-fit:contain}.top a{text-decoration:none;color:#17351f}.card{display:grid;grid-template-columns:minmax(280px,1fr) minmax(300px,1fr);gap:34px;background:#fff;border-radius:24px;padding:28px;box-shadow:0 12px 40px #17351f12}.media{min-height:420px;display:flex;align-items:center;justify-content:center;background:#f3f7f3;border-radius:18px;overflow:hidden}.media img{max-width:100%;max-height:480px;object-fit:contain}.cat{color:#2a7b3f;font-weight:700}.price{font-size:32px;font-weight:800;margin:16px 0}.old{text-decoration:line-through;color:#888;font-size:16px;margin-right:10px}.stock{display:inline-block;padding:8px 12px;border-radius:999px;background:#eaf6ec}.desc{line-height:1.65;color:#48604e}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}.btn{border:0;border-radius:12px;padding:14px 20px;font-weight:700;cursor:pointer;text-decoration:none}.primary{background:#1f6b35;color:white}.secondary{background:#edf5ee;color:#17351f}.ratingline{display:flex;align-items:center;gap:10px;margin:8px 0 12px}.stars{color:#f4b400;letter-spacing:2px;font-size:20px}.reviews{margin-top:22px;background:#fff;border-radius:24px;padding:26px;box-shadow:0 12px 40px #17351f12}.review-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.summary-box,.review-form{border:1px solid #e2ece5;border-radius:18px;padding:18px}.avg{font-size:48px;font-weight:900;color:#166d3a}.review-form input,.review-form textarea{width:100%;box-sizing:border-box;border:1px solid #d8e5dc;border-radius:12px;padding:12px;margin:6px 0;font:inherit}.review-form textarea{min-height:95px;resize:vertical}.pickstars button{border:0;background:transparent;color:#c7d0ca;font-size:28px;cursor:pointer;padding:2px}.pickstars button.on{color:#f4b400}.review-row{padding:16px 0;border-top:1px solid #e8efea}.review-row:first-child{border-top:0}.review-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.admin-reply{margin:10px 0 0 28px;padding:12px 14px;background:#eaf7ef;border-radius:12px;border-left:4px solid #1b8a4b}.admin-reply b{display:block;color:#176837;margin-bottom:4px}.seo-overlay{position:fixed;inset:0;background:#102a1d66;opacity:0;pointer-events:none;transition:.22s;z-index:80}.seo-overlay.show{opacity:1;pointer-events:auto}.seo-cart{position:fixed;right:0;top:0;width:min(440px,94vw);height:100vh;background:#fff;z-index:81;transform:translateX(105%);transition:.25s;box-shadow:-18px 0 45px #102a1d26;display:flex;flex-direction:column}.seo-cart.open{transform:translateX(0)}.seo-cart-head{padding:20px 22px;border-bottom:1px solid #e5eee7;display:flex;justify-content:space-between;align-items:center}.seo-cart-head h2{margin:0}.seo-cart-head button{border:0;background:#edf5ee;width:38px;height:38px;border-radius:50%;font-size:24px;cursor:pointer}.seo-cart-items{padding:14px 20px;overflow:auto;flex:1}.seo-cart-line{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #edf2ee}.seo-cart-thumb{width:64px;height:64px;border-radius:12px;background:#f3f7f3;display:flex;align-items:center;justify-content:center;overflow:hidden}.seo-cart-thumb img{width:100%;height:100%;object-fit:contain}.seo-cart-info b{display:block;margin-bottom:5px}.seo-cart-info span{font-size:13px;color:#65746a}.seo-stepper{display:flex;align-items:center;gap:8px;margin-top:8px}.seo-stepper button{width:28px;height:28px;border:0;border-radius:8px;background:#edf5ee;cursor:pointer}.seo-cart-price{text-align:right}.seo-cart-price button{display:block;margin:8px 0 0 auto;border:0;background:transparent;color:#a33;font-size:20px;cursor:pointer}.seo-cart-foot{padding:18px 20px 24px;border-top:1px solid #e5eee7;background:#fbfdfb}.seo-total{display:flex;justify-content:space-between;font-size:20px;margin-bottom:12px}.seo-min{padding:10px 12px;border-radius:12px;background:#fff8dd;color:#735c00;font-size:12px;font-weight:700;margin-bottom:12px}.seo-checkout{display:block;width:100%;box-sizing:border-box;text-align:center;background:#1f6b35;color:#fff;border-radius:12px;padding:14px 18px;font-weight:800;text-decoration:none}.seo-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);background:#17351f;color:#fff;padding:12px 18px;border-radius:12px;opacity:0;pointer-events:none;transition:.2s;z-index:90}.seo-toast.show{opacity:1;transform:translate(-50%,0)}@media(max-width:760px){.card{grid-template-columns:1fr;padding:18px}.media{min-height:300px}.price{font-size:27px}.review-grid{grid-template-columns:1fr}.reviews{padding:18px}.avg{font-size:40px}}</style></head><body><main class="wrap"><header class="top"><a href="/"><img src="/logo.png" alt="IMOM OTA BARAKA"></a><div><a href="/"><b>ZARBULOQ.UZ</b></a><div>${isRu?'Интернет-магазин IMOM OTA BARAKA':'IMOM OTA BARAKA internet do‘koni'}</div></div></header><section class="card"><div class="media"><img src="${htmlEsc(img)}" alt="${htmlEsc(name)}" loading="eager"></div><div><div class="cat">${htmlEsc(cat)}</div><h1>${htmlEsc(name)}</h1><div class="ratingline"><span class="stars">${seoSummary.count?'★'.repeat(Math.round(seoSummary.average))+'☆'.repeat(5-Math.round(seoSummary.average)):'☆☆☆☆☆'}</span><b>${seoSummary.count?seoSummary.average.toFixed(1):'—'}</b><span>(${seoSummary.count} ${isRu?'отзывов':'ta baho'})</span></div><p class="desc">${htmlEsc(desc)}</p><div class="price">${oldPrice}${price.toLocaleString('ru-RU')} ${isRu?'сум':'so‘m'}</div><div class="stock">${htmlEsc(stockText)}</div><div class="actions">${stock>0?`<button class="btn primary" onclick="addToCartAndOpen()">${isRu?'В корзину':'Savatga qo‘shish'}</button>`:''}<a class="btn secondary" href="/#products">${isRu?'Все товары':'Barcha mahsulotlar'}</a></div></div></section><section class="reviews"><h2>${isRu?'Оценки и отзывы':'Baholar va izohlar'} (${seoSummary.count})</h2><div class="review-grid"><div class="summary-box"><div>${isRu?'Общая оценка':'Umumiy baho'}</div><div class="avg">${seoSummary.count?seoSummary.average.toFixed(1):'—'}</div><div class="stars">${seoSummary.count?'★'.repeat(Math.round(seoSummary.average))+'☆'.repeat(5-Math.round(seoSummary.average)):'☆☆☆☆☆'}</div><p>${seoSummary.count} ${isRu?'оценок':'ta baho asosida'}</p></div><form class="review-form" onsubmit="submitReview(event)"><h3>${isRu?'Оставьте свой отзыв':'O‘z fikringizni qoldiring'}</h3><div class="pickstars" id="pickStars">${[1,2,3,4,5].map(n=>`<button type="button" onclick="pickRating(${n})">★</button>`).join('')}</div><input type="hidden" id="ratingValue" value="0"><input id="reviewName" placeholder="${isRu?'Ваше имя':'Ismingiz'}" required><input id="reviewPhone" placeholder="+998 90 123 45 67" required><textarea id="reviewComment" maxlength="500" placeholder="${isRu?'Ваш отзыв':'Mahsulot haqida fikringizni yozing...'}" required></textarea><button class="btn primary" type="submit">${isRu?'Отправить отзыв':'Izoh qoldirish'}</button><div id="reviewStatus"></div></form></div><div id="reviewRows">${seoReviews.slice(0,50).map(r=>`<article class="review-row"><div class="review-meta"><b>${htmlEsc(r.name||'Foydalanuvchi')}</b><span class="stars">${'★'.repeat(Math.max(1,Math.min(5,Number(r.rating)||1)))+'☆'.repeat(5-Math.max(1,Math.min(5,Number(r.rating)||1)))}</span><small>${htmlEsc(String(r.updatedAt||r.createdAt||'').slice(0,10))}</small></div><p>${htmlEsc(r.comment||'')}</p>${r.adminReply?`<div class="admin-reply"><b>${isRu?'Ответ администратора':'Admin javobi'}</b>${htmlEsc(r.adminReply)}</div>`:''}</article>`).join('')||`<p>${isRu?'Отзывов пока нет.':'Hali izoh yo‘q.'}</p>`}</div></section></main><div class="seo-overlay" id="seoOverlay" onclick="closeSeoCart()"></div><aside class="seo-cart" id="seoCart"><div class="seo-cart-head"><div><h2>${isRu?'Корзина':'Savat'}</h2><small id="seoCartSub"></small></div><button onclick="closeSeoCart()">×</button></div><div class="seo-cart-items" id="seoCartItems"></div><div class="seo-cart-foot"><div class="seo-total"><span>${isRu?'Итого':'Jami'}</span><b id="seoCartTotal">0 so‘m</b></div><div class="seo-min" id="seoMinNote">${isRu?'Минимальный заказ: 100 000 сум':'Minimal buyurtma: 100 000 so‘m'}</div><a class="seo-checkout" href="/?checkout=1">${isRu?'Оформить заказ':'Buyurtma berish'}</a></div></aside><div class="seo-toast" id="seoToast">${isRu?'✓ Товар добавлен в корзину':'✓ Mahsulot savatga qo‘shildi'}</div><script>let chosenRating=0;function pickRating(n){chosenRating=n;document.getElementById('ratingValue').value=n;[...document.querySelectorAll('#pickStars button')].forEach((b,i)=>b.classList.toggle('on',i<n))}async function submitReview(e){e.preventDefault();const st=document.getElementById('reviewStatus');if(chosenRating<1){st.textContent='${isRu?'Выберите оценку':'Baho tanlang'}';return}const body={name:document.getElementById('reviewName').value.trim(),phone:document.getElementById('reviewPhone').value.trim(),rating:chosenRating,comment:document.getElementById('reviewComment').value.trim()};st.textContent='${isRu?'Отправляем...':'Yuborilmoqda...'}';try{const r=await fetch('/api/products/${encodeURIComponent(String(p.id))}/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw new Error(d.error||'Xatolik');location.reload()}catch(err){st.textContent=err.message}}const SEO_CURRENT={id:${JSON.stringify(Number(p.id))},name:${JSON.stringify(name)},price:${JSON.stringify(price)},stock:${JSON.stringify(stock)},image:${JSON.stringify(img)}};let seoProducts=[SEO_CURRENT];function seoMoney(n){return Number(n||0).toLocaleString('ru-RU')+' ${isRu?'сум':'so‘m'}'}async function loadSeoProducts(){try{const r=await fetch('/api/products',{cache:'no-store'}),d=await r.json();const a=Array.isArray(d)?d:(Array.isArray(d.products)?d.products:[]);if(a.length)seoProducts=a}catch(e){}}function seoProduct(id){return seoProducts.find(function(p){return Number(p.id)===Number(id)})||(Number(id)===Number(SEO_CURRENT.id)?SEO_CURRENT:null)}function seoName(p){if(!p)return '${isRu?'Товар':'Mahsulot'}';return typeof p.name==='string'?p.name:(p.name&&p.name.${lang}||p.name&&p.name.uz||p.name&&p.name.ru||'${isRu?'Товар':'Mahsulot'}')}function renderSeoCart(){let cart=[];try{cart=JSON.parse(localStorage.getItem('iob_cart_v13')||'[]')}catch(e){}const box=document.getElementById('seoCartItems');let total=0,count=0,html='';cart.forEach(function(x){const pp=seoProduct(x.id),pr=Number(pp&&pp.price||0),q=Number(x.qty||0),im=pp&&pp.image||'';total+=pr*q;count+=q;html+='<div class="seo-cart-line"><div class="seo-cart-thumb">'+(im?'<img src="'+im+'">':'')+'</div><div class="seo-cart-info"><b>'+seoName(pp)+'</b><span>'+seoMoney(pr)+' × '+q+'</span><div class="seo-stepper"><button onclick="changeSeoCart('+Number(x.id)+',-1)">−</button><b>'+q+'</b><button onclick="changeSeoCart('+Number(x.id)+',1)">+</button></div></div><div class="seo-cart-price"><b>'+seoMoney(pr*q)+'</b><button onclick="removeSeoCart('+Number(x.id)+')">×</button></div></div>'});box.innerHTML=html||'<p>${isRu?'Корзина пуста.':'Savat bo‘sh.'}</p>';document.getElementById('seoCartSub').textContent=count+' ${isRu?'товар(ов)':'ta mahsulot'}';document.getElementById('seoCartTotal').textContent=seoMoney(total);document.getElementById('seoMinNote').style.display=count?'block':'none'}function openSeoCart(){renderSeoCart();document.getElementById('seoCart').classList.add('open');document.getElementById('seoOverlay').classList.add('show')}function closeSeoCart(){document.getElementById('seoCart').classList.remove('open');document.getElementById('seoOverlay').classList.remove('show')}function saveSeoCart(cart){localStorage.setItem('iob_cart_v13',JSON.stringify(cart));renderSeoCart()}function changeSeoCart(id,d){let cart=JSON.parse(localStorage.getItem('iob_cart_v13')||'[]'),x=cart.find(function(a){return Number(a.id)===Number(id)});if(!x)return;const pp=seoProduct(id),max=Number(pp&&pp.stock||999999);x.qty=Math.max(1,Math.min(max,Number(x.qty||1)+d));saveSeoCart(cart)}function removeSeoCart(id){let cart=JSON.parse(localStorage.getItem('iob_cart_v13')||'[]').filter(function(a){return Number(a.id)!==Number(id)});saveSeoCart(cart)}function addToCartAndOpen(){try{const id=SEO_CURRENT.id,stock=SEO_CURRENT.stock;let cart=JSON.parse(localStorage.getItem('iob_cart_v13')||'[]');let x=cart.find(function(a){return Number(a.id)===id});if(x){if(Number(x.qty)>=stock){alert('${isRu?'Максимальное количество уже в корзине.':'Ombordagi maksimal miqdor savatda.'}');openSeoCart();return}x.qty=Number(x.qty||0)+1}else cart.push({id:id,qty:1});localStorage.setItem('iob_cart_v13',JSON.stringify(cart));const t=document.getElementById('seoToast');t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1400);openSeoCart()}catch(e){openSeoCart()}}loadSeoProducts().then(renderSeoCart);</script></body></html>`);
}
app.get('/mahsulot/:slug',(req,res)=>renderProductSeoPage(req,res,'uz'));
app.get('/uz/mahsulot/:slug',(req,res)=>res.redirect(301,`/mahsulot/${encodeURIComponent(req.params.slug)}`));
app.get('/ru/mahsulot/:slug',(req,res)=>renderProductSeoPage(req,res,'ru'));

// SECURITY v13.26.74 — browser hardening headers.
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  if(process.env.NODE_ENV==='production'){
    res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  }
  next();
});

// SECURITY v13.26.74 — sensitive server files can never be served by express.static.
const BLOCKED_STATIC_EXACT=new Set([
  '/server.js','/package.json','/package-lock.json','/render.yaml','/.env','/.env.local',
  '/V13_26_71_FULL_BACKEND_DATA_RESTORE.txt','/V13_26_72_RENDER_DEPLOY_FIX.txt',
  '/V13_26_73_SERVER_STABILITY.txt','/V13_26_74_SECURITY_HARDENED.txt'
]);
app.use((req,res,next)=>{
  const p=decodeURIComponent(String(req.path||'')).replace(/\\/g,'/').toLowerCase();
  if(BLOCKED_STATIC_EXACT.has(p) || p.startsWith('/data/') || p.startsWith('/.git/') ||
     p.includes('/node_modules/') || /(^|\/)\.env(?:\.|$)/.test(p)){
    return res.status(404).end();
  }
  next();
});

app.use((req,res,next)=>{if(req.path==='/admin.html'||req.path==='/'||req.path==='/index.html'){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0')}next()});
// V13.26.59 — APK local cache + PostgreSQL persistent binary storage.
// Render Free restart qilganda local disk yo‘qolsa ham APK PostgreSQL'dan qayta tarqatiladi.
const APK_DIR = path.join(DATA_DIR,'downloads');
const APK_FILE = path.join(APK_DIR,'Zarbuloq.apk');
async function readApkBinary(){
 try{if(fs.existsSync(APK_FILE))return fs.readFileSync(APK_FILE)}catch{}
 if(pool){
  const r=await dbQuery('SELECT data FROM app_binary WHERE id=1');
  const buf=r.rows?.[0]?.data;
  if(Buffer.isBuffer(buf)&&buf.length){
   try{fs.mkdirSync(APK_DIR,{recursive:true});fs.writeFileSync(APK_FILE,buf)}catch{}
   return buf;
  }
 }
 return null;
}
async function readApkStoredMeta(){
 if(pool){
  try{const r=await dbQuery('SELECT size,sha256,updated_at FROM app_binary WHERE id=1');if(r.rows.length)return {available:true,size:Number(r.rows[0].size||0),sha256:r.rows[0].sha256||'',updatedAt:r.rows[0].updated_at||''};}catch{}
 }
 try{if(fs.existsSync(APK_FILE)){const st=fs.statSync(APK_FILE);return {available:true,size:st.size,sha256:'',updatedAt:st.mtime?.toISOString?.()||''}}}catch{}
 return {available:false,size:0,sha256:'',updatedAt:''};
}
async function persistApkBinary(buf,sha256){
 if(!pool)return;
 await dbQuery('INSERT INTO app_binary (id,data,size,sha256,updated_at) VALUES (1,$1,$2,$3,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,size=EXCLUDED.size,sha256=EXCLUDED.sha256,updated_at=NOW()',[buf,buf.length,sha256||'']);
}
async function deleteApkBinary(){if(pool)await dbQuery('DELETE FROM app_binary WHERE id=1');}
app.get('/downloads/Zarbuloq.apk',async(req,res)=>{
 try{
  const buf=await readApkBinary();if(!buf)return res.status(404).send('APK hali yuklanmagan');
  res.setHeader('Content-Type','application/vnd.android.package-archive');
  res.setHeader('Content-Disposition','attachment; filename="Zarbuloq.apk"');
  res.setHeader('Content-Length',String(buf.length));
  res.setHeader('Cache-Control','no-store');
  return res.end(buf);
 }catch(e){console.error('APK download:',e);return res.status(500).send('APK faylini ochib bo‘lmadi')}
});
app.head('/downloads/Zarbuloq.apk',async(req,res)=>{
 try{const meta=await readApkStoredMeta();if(!meta.available)return res.sendStatus(404);res.setHeader('Content-Type','application/vnd.android.package-archive');res.setHeader('Content-Length',String(meta.size||0));res.setHeader('Cache-Control','no-store');return res.sendStatus(200)}catch{return res.sendStatus(404)}
});
app.get('/api/app-apk-info',async(req,res)=>{
 const db=readDb(),c={...defaultSettings.appControl,...(db.settings?.appControl||{})},meta=await readApkStoredMeta();
 res.setHeader('Cache-Control','no-store');
 res.json({ok:true,available:meta.available,version:c.apkVersion||c.currentVersion||'',versionCode:Number(c.apkVersionCode||c.latestVersionCode||0),notes:c.apkNotes||'',updatedAt:c.apkUpdatedAt||meta.updatedAt||'',size:meta.size||Number(c.apkSize||0),sha256:c.apkSha256||meta.sha256||'',url:'/downloads/Zarbuloq.apk',storage:pool?'postgresql+cache':'local'});
});

app.use(express.static(__dirname));

const defaultCategories=[
 {id:'food',icon:'🍎',name:{uz:'Oziq-ovqat',ru:'Продукты'}},
 {id:'home',icon:'🏠',name:{uz:'Uy uchun',ru:'Для дома'}},
 {id:'care',icon:'🧴',name:{uz:'Shaxsiy parvarish',ru:'Уход'}}
];
const defaultProducts=[
 {id:1,cat:'food',emoji:'🍚',name:{uz:'Premium guruch',ru:'Премиальный рис'},price:45000,cost:35000,oldPrice:0,stock:25,image:'',badge:'TOP',featured:true},
 {id:2,cat:'food',emoji:'🍯',name:{uz:'Tabiiy asal',ru:'Натуральный мёд'},price:78000,cost:59000,oldPrice:85000,stock:20,image:'',badge:'AKSIYA',featured:true},
 {id:3,cat:'food',emoji:'🫙',name:{uz:'Sof zaytun yog‘i',ru:'Оливковое масло'},price:125000,cost:98000,oldPrice:0,stock:15,image:'',badge:'YANGI',featured:true},
 {id:4,cat:'home',emoji:'🧺',name:{uz:'Uy uchun to‘plam',ru:'Набор для дома'},price:99000,cost:72000,oldPrice:120000,stock:10,image:'',badge:'-18%',featured:false}
];
const defaultSettings={
 siteName:'IMOM OTA BARAKA',siteDomain:'zarbuloq.uz',theme:'original',
 tagline:{uz:'Sifat, ishonch, baraka!',ru:'Качество, доверие, баракат!'},
 hero:{uz:{eyebrow:'SIFAT • ISHONCH • BARAKA',title:'Har bir xonadonga — sifat va baraka.',text:'Parkent tumani bo‘ylab bepul yetkazib berish, qulay buyurtma va ishonchli xizmat.'},ru:{eyebrow:'КАЧЕСТВО • ДОВЕРИЕ • БАРАКАТ',title:'Качество и баракат — в каждый дом.',text:'Бесплатная доставка по Паркентскому району, удобный заказ и надёжный сервис.'}},
 catalog:{uz:'Mashhur mahsulotlar',ru:'Популярные товары'},
 about:{uz:{title:'IMOM OTA BARAKA — ishonchli tanlov.',text:'Biz mijozlarimizga sifatli mahsulot, shaffof xizmat, tezkor aloqa va qulay xarid tajribasini taqdim etamiz.'},ru:{title:'IMOM OTA BARAKA — надёжный выбор.',text:'Качественные товары, прозрачный сервис, быстрая связь и удобные покупки.'}},
 contact:{uz:{title:'Biz bilan bog‘laning',text:'Savol, taklif va buyurtmalar uchun Telegram yoki telefon orqali murojaat qiling.'},ru:{title:'Свяжитесь с нами',text:'По вопросам, предложениям и заказам свяжитесь через Telegram или по телефону.'}},
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
 appControl:{currentVersion:'4.9.4',latestVersionCode:74,minVersionCode:68,forceUpdate:false,maintenance:false,maintenanceMessage:'Ilovada texnik ishlar olib borilmoqda. Iltimos, birozdan so‘ng qayta urinib ko‘ring.',updateTitle:'Yangi versiya mavjud',updateMessage:'ZARBULOQ.UZ ilovasining yangi versiyasini o‘rnating.',updateUrl:'https://zarbuloq.uz/downloads/Zarbuloq.apk',noticeEnabled:false,noticeText:'',productRequestEnabled:true,liveChatEnabled:true,reviewsEnabled:true,trackingEnabled:true,supportPhone:'+998901361211',supportTelegram:'https://t.me/imomotabaraka',homeHeroImage:'',homeHeroTitle:'Tabiatning ezgu ne’matlari sizning uyingizda!',homeHeroBadge:'100% TABIIY',homeHeroButton:'Mahsulotga so‘rov qoldirish',homeNewsTitleUz:'Yangiliklar',homeNewsTitleRu:'Новинки',homeSalesTitleUz:'Aksiyalar',homeSalesTitleRu:'Акции',homeAdsTitleUz:'Reklamalar',homeAdsTitleRu:'Реклама',homeProductsTitleUz:'Mahsulotlar',homeProductsTitleRu:'Товары',homeSeeAllUz:'Barchasini ko‘rish',homeSeeAllRu:'Смотреть все',appBanners:[],apkAvailable:false,apkFileName:'Zarbuloq.apk',apkVersion:'',apkVersionCode:0,apkNotes:'',apkUpdatedAt:'',apkSize:0,apkSha256:'',apkUrl:'/downloads/Zarbuloq.apk'},
 delivery:{free:true,district:'Parkent tumani',areas:['Parkent shahri','Chinor','Zarkent','So‘qoq','Kumushkon','Nevich','Boshqizilsoy','Changi','Qoraqalpoq','Nomdanak'],slots:['09:00–12:00','12:00–15:00','15:00–18:00','18:00–21:00']},
 seo:{title:'IMOM OTA BARAKA — ZARBULOQ.UZ',description:'ZARBULOQ.UZ — Parkent tumani bo‘ylab bepul yetkazib beruvchi IMOM OTA BARAKA internet do‘koni.',keywords:'zarbuloq, imom ota baraka, parkent, internet do‘kon, bepul yetkazib berish'}
};
const defaultPromos=[{code:'BARAKA5',type:'percent',value:5,minTotal:150000,active:true,usageLimit:100,used:0,expires:''}];

function activeProductPromotion(db,product,at=new Date()){
 const rows=Array.isArray(db?.productPromotions)?db.productPromotions:[];
 const pid=String(product?.id??''),sku=String(product?.sku||'').trim().toUpperCase();
 const now=at instanceof Date?at:new Date(at);
 return rows.find(x=>{
  if(!x||x.active===false)return false;
  const same=String(x.productId??'')===pid || (sku&&String(x.sku||'').trim().toUpperCase()===sku);
  if(!same)return false;
  if(x.starts&&new Date(String(x.starts)+'T00:00:00')>now)return false;
  if(x.expires&&new Date(String(x.expires)+'T23:59:59')<now)return false;
  return true;
 })||null;
}
function productSaleInfo(db,product){
 const base=Math.max(0,Number(product?.price)||0),promo=activeProductPromotion(db,product);
 if(!promo||base<=0)return {basePrice:base,price:base,discount:0,percent:0,promotion:null};
 let discount=promo.type==='fixed'?Math.max(0,Number(promo.value)||0):Math.round(base*Math.max(0,Number(promo.value)||0)/100);
 discount=Math.min(base,discount);const price=Math.max(0,base-discount),percent=base?Math.round(discount*100/base):0;
 return {basePrice:base,price,discount,percent,promotion:promo};
}
function publicProductWithPromotion(db,p){
 const sale=productSaleInfo(db,p);
 if(!sale.promotion)return {...p};
 return {...p,basePrice:sale.basePrice,price:sale.price,oldPrice:sale.basePrice,badge:`-${sale.percent}%`,promotion:{id:sale.promotion.id||'',type:sale.promotion.type||'percent',value:Number(sale.promotion.value||0),discount:sale.discount,percent:sale.percent,starts:sale.promotion.starts||'',expires:sale.promotion.expires||'',label:sale.promotion.label||'AKSIYA'}};
}

function initialDb(){return {products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[],productRequests:[],productReviews:[],orderComplaints:[],chats:[],appNotifications:[],promos:defaultPromos,productPromotions:[],audit:[],inventoryReceipts:[],financeCompanies:[],financePurchases:[],financeCompanyPayments:[],financeEmployees:[],financePayroll:[],financeExpenses:[],financeTaxPayments:[],receiptHistory:[],visits:[],financeSettings:{turnoverTaxRate:4,payrollIncomeTaxRate:12,payrollPensionRate:0.1,payrollBudgetShareRate:11.9,employerSocialTaxRate:0,payrollTaxRate:12,landTaxMonthly:0,propertyTaxRate:0,propertyTaxBase:0,otherTaxRate:0,otherTaxBase:'revenue',otherTaxMonthly:0,cashOpening:0,bankOpening:0,defaultSalesAccount:'bank',defaultMarkupRate:30}};}
function normalizeDb(db){
 const merged={...initialDb(),...(db||{}),settings:{...defaultSettings,...(db?.settings||{}),delivery:{...defaultSettings.delivery,...(db?.settings?.delivery||{})},seo:{...defaultSettings.seo,...(db?.settings?.seo||{})},company:{...defaultSettings.company,...(db?.settings?.company||{})},map:{...defaultSettings.map,...(db?.settings?.map||{})},footer:{...defaultSettings.footer,...(db?.settings?.footer||{})},ui:{...defaultSettings.ui,...(db?.settings?.ui||{})},appControl:{...defaultSettings.appControl,...(db?.settings?.appControl||{})},testMode:{...defaultSettings.testMode,...(db?.settings?.testMode||{})},homePromos:{left:{...defaultSettings.homePromos.left,...(db?.settings?.homePromos?.left||{})},center:{...defaultSettings.homePromos.center,...(db?.settings?.homePromos?.center||{})},right:{...defaultSettings.homePromos.right,...(db?.settings?.homePromos?.right||{})}},benefits:Array.isArray(db?.settings?.benefits)?db.settings.benefits:defaultSettings.benefits},orders:Array.isArray(db?.orders)?db.orders:[],productRequests:Array.isArray(db?.productRequests)?db.productRequests:[],productReviews:Array.isArray(db?.productReviews)?db.productReviews:[],orderComplaints:Array.isArray(db?.orderComplaints)?db.orderComplaints:[],chats:Array.isArray(db?.chats)?db.chats:[],appNotifications:Array.isArray(db?.appNotifications)?db.appNotifications:[],promos:Array.isArray(db?.promos)?db.promos:defaultPromos,productPromotions:Array.isArray(db?.productPromotions)?db.productPromotions:[],audit:Array.isArray(db?.audit)?db.audit:[],inventoryReceipts:Array.isArray(db?.inventoryReceipts)?db.inventoryReceipts:[],financeCompanies:Array.isArray(db?.financeCompanies)?db.financeCompanies:[],financePurchases:Array.isArray(db?.financePurchases)?db.financePurchases:[],financeCompanyPayments:Array.isArray(db?.financeCompanyPayments)?db.financeCompanyPayments:[],financeEmployees:Array.isArray(db?.financeEmployees)?db.financeEmployees:[],financePayroll:Array.isArray(db?.financePayroll)?db.financePayroll:[],financeExpenses:Array.isArray(db?.financeExpenses)?db.financeExpenses:[],financeTaxPayments:Array.isArray(db?.financeTaxPayments)?db.financeTaxPayments:[],receiptHistory:Array.isArray(db?.receiptHistory)?db.receiptHistory:[],visits:Array.isArray(db?.visits)?db.visits:[],financeSettings:{...initialDb().financeSettings,...(db?.financeSettings||{})}};
 const dom=String(merged.settings.siteDomain||'').toLowerCase();
 if(['velora.uz','barkamarket.uz','barakamarket.uz','imomotamarket.uz'].includes(dom))merged.settings.siteDomain='zarbuloq.uz';
 if(merged.settings.map?.title==='Parkent tumani xaritasi')merged.settings.map.title='Yetkazib berish bepul hududlar';
 if(merged.settings.map?.text?.startsWith('Buyurtmalar Parkent tumani bo‘ylab bepul yetkazib beriladi'))merged.settings.map.text='Xaritada yashil rang va qizil chegara bilan ko‘rsatilgan Parkent tumani hududlarida yetkazib berish bepul. Buyurtma vaqtida manzilingizni tanlang yoki aniq GPS lokatsiyangizni yuboring.';
 merged.settings.map.openUrl='https://www.openstreetmap.org/relation/5745823';
 for(const k of ['title','description','keywords'])if(typeof merged.settings.seo?.[k]==='string')merged.settings.seo[k]=merged.settings.seo[k].replace(/VELORA\.UZ/gi,'ZARBULOQ.UZ').replace(/velora/gi,'zarbuloq').replace(/BarkaMarket\.uz/gi,'ZARBULOQ.UZ').replace(/barkamarket/gi,'zarbuloq').replace(/barakamarket/gi,'zarbuloq').replace(/imomotamarket/gi,'zarbuloq');
 // UZ/RU ONLY: old English fields are removed automatically from persisted data.
 for(const p of merged.products||[]){
  if(p.name&&typeof p.name==='object')delete p.name.en;
  if(p.description&&typeof p.description==='object')delete p.description.en;
  if(p.unit&&typeof p.unit==='object')delete p.unit.en;
  if(p.seo?.title&&typeof p.seo.title==='object')delete p.seo.title.en;
  if(p.seo?.description&&typeof p.seo.description==='object')delete p.seo.description.en;
 }
 for(const c of merged.categories||[])if(c.name&&typeof c.name==='object')delete c.name.en;
 const stripEn=(v)=>{
  if(!v||typeof v!=='object')return;
  if(Object.prototype.hasOwnProperty.call(v,'en'))delete v.en;
  for(const x of Object.values(v))if(x&&typeof x==='object')stripEn(x);
 };
 stripEn(merged.settings);
 for(const n of merged.appNotifications||[]){
  if(n.title&&typeof n.title==='object')delete n.title.en;
  if(n.body&&typeof n.body==='object')delete n.body.en;
 }
 // Legacy ombor migration: old products had only current stock, without receipt history.
 // Reconstruct a stable opening quantity so monthly closing stock does not become 0.
 for(const p of merged.products||[]){
  if(Number.isFinite(Number(p.legacyOpeningQty))&&p.legacyOpeningQty!==''&&p.legacyOpeningQty!==null&&p.legacyOpeningQty!==undefined)continue;
  const hasTrackedInitial=Boolean(String(p.createdAt||'').slice(0,10))&&p.receivedQty!==undefined&&p.receivedQty!==null;
  if(hasTrackedInitial){p.legacyOpeningQty=0;continue;}
  const soldAll=(merged.orders||[]).filter(o=>['delivery','delivered','completed','done'].includes(o.status)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(p.id)).reduce((a,i)=>a+Number(i.qty||0),0),0);
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
function adminProductImageUrl(p){
 const raw=String(p?.image||'').trim();
 if(!raw)return '';
 // Large data: images stay in PostgreSQL; admin JSON only receives a lightweight URL.
 if(/^data:image\//i.test(raw))return `/api/admin/products/${encodeURIComponent(String(p.id))}/image?v=${encodeURIComponent(String(p.updatedAt||p.createdAt||''))}`;
 return raw;
}
function adminProductPayload(p){
 const out=cloneProductSafe(p||{});
 out.image=adminProductImageUrl(p);
 return out;
}
function isAdminImageProxy(raw,id){
 const v=String(raw||'');
 const n=String(Number(id));
 return v.includes(`/api/admin/products/${n}/image`);
}
async function persistRemote(snapshot){
 if(!pool)return;
 await dbQuery('INSERT INTO shop_state (id,data,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()',[snapshot]);
}
async function writeDb(db,opts={}){
 let normalized=normalizeDb(db);
 const allowReplace=Boolean(opts.allowProductReplace);
 const allowedDeleteIds=new Set((opts.allowProductDeleteIds||[]).map(x=>String(Number(x))));
 // Product count may decrease only through explicit product DELETE or explicit backup restore.
 if(!allowReplace && committedProducts.size){
  const nowMap=new Map((normalized.products||[]).map(p=>[String(Number(p.id)),p]));
  let restored=0;
  for(const [id,p] of committedProducts){
   if(allowedDeleteIds.has(id))continue;
   if(!nowMap.has(id)){ normalized.products.push(cloneProductSafe(p)); restored++; }
  }
  if(restored) console.warn(`PRODUCT GUARD: restored ${restored} accidentally missing product(s) before commit`);
 }
 const snapshot=JSON.stringify(normalized);
 // PostgreSQL-first: never acknowledge a save in memory/local storage before the durable DB commit succeeds.
 if(pool){
  persistChain=persistChain.catch(()=>{}).then(()=>persistRemote(snapshot));
  await persistChain;
 }
 dbCache=normalized;
 writeLocal(normalized);
 rememberCommittedProducts(normalized);
 broadcastRealtime('data-changed');
}
async function initStorage(){
 fs.mkdirSync(DATA_DIR,{recursive:true});
 if(REQUIRE_DATABASE && !DATABASE_URL) throw new Error('DATABASE_URL is required in production (REQUIRE_DATABASE=true)');
 const local=readLocal();
 if(!pool){dbCache=local;writeLocal(dbCache);rememberCommittedProducts(dbCache);console.log('Storage: local JSON fallback');return;}
 await dbQuery('CREATE TABLE IF NOT EXISTS shop_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
 await dbQuery("CREATE TABLE IF NOT EXISTS app_binary (id INTEGER PRIMARY KEY, data BYTEA NOT NULL, size BIGINT NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 const r=await dbQuery('SELECT data FROM shop_state WHERE id=1');
 if(r.rows.length){dbCache=normalizeDb(r.rows[0].data);writeLocal(dbCache);rememberCommittedProducts(dbCache);console.log('Storage: PostgreSQL loaded');}
 else{dbCache=local;await persistRemote(JSON.stringify(dbCache));writeLocal(dbCache);rememberCommittedProducts(dbCache);console.log('Storage: PostgreSQL initialized from local data');}
}
function clean(v,max=500){return String(v??'').replace(/[<>]/g,'').trim().slice(0,max)}
const money=n=>new Intl.NumberFormat('ru-RU').format(Number(n)||0)+' so‘m';
function normalizeOrderStatus(raw){
 const s=String(raw||'').trim().toLowerCase().replace(/[_-]+/g,' ');
 if(/cancel|bekor|отмен/.test(s))return 'cancelled';
 if(/complete|customer confirmed|yakun|заверш/.test(s))return 'completed';
 if(/delivered|yetkazildi|доставлен/.test(s)||s==='done')return 'delivered';
 if(/delivery|shipping|yetkazilmoqda|courier|доставк/.test(s))return 'delivery';
 if(/ready|prepar|tayyor|готов/.test(s))return 'preparing';
 if(/accept|qabul|принят/.test(s))return 'accepted';
 if(/new|yangi/.test(s))return 'new';
 return s||'new';
}
function statusLabel(code){code=normalizeOrderStatus(code);return {new:'🕓 Yangi',accepted:'✅ Qabul qilindi',preparing:'🧺 Tayyorlanmoqda',delivery:'🚚 Yetkazilmoqda',delivered:'📦 Yetkazildi',completed:'✅ Yakunlandi',cancelled:'❌ Bekor qilindi'}[code]||'🕓 Yangi'}
function statusKeyboard(orderId,current='new'){
 current=normalizeOrderStatus(current);
 const rows=[
  [{text:'✅ Qabul qilindi',callback_data:`st|accepted|${orderId}`},{text:'🧺 Tayyorlanmoqda',callback_data:`st|preparing|${orderId}`}],
  [{text:'🚚 Yetkazilmoqda',callback_data:`st|delivery|${orderId}`},{text:'📦 Yetkazildi',callback_data:`st|delivered|${orderId}`}],
  [{text:'❌ Bekor qilindi',callback_data:`st|cancelled|${orderId}`}]
 ];
 if(['delivered','completed','cancelled'].includes(current))return {inline_keyboard:[]};
 return {inline_keyboard:rows.map(row=>row.map(b=>{const active=b.callback_data.includes(`|${current}|`);return {...b,text:active?`${b.text.toUpperCase()} — HOZIRGI STATUS`:b.text}}))};
}
function pushOrderHistory(order,status,source='system'){
 order.statusHistory=Array.isArray(order.statusHistory)?order.statusHistory:[];
 const st=normalizeOrderStatus(status),last=order.statusHistory[order.statusHistory.length-1];
 if(!last||normalizeOrderStatus(last.status)!==st)order.statusHistory.push({status:st,at:new Date().toISOString(),source:clean(source,40)||'system'});
 order.statusHistory=order.statusHistory.slice(-40);
}
async function tgCall(method,payload){const r=await fetch(`${TG}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));if(!r.ok||!data.ok)throw new Error(data.description||`Telegram ${method} failed`);return data.result}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));}
// SECURITY v13.26.74 — in-memory rate limits (single Render instance).
const securityBuckets=new Map();
function clientIp(req){return String(req.ip||req.socket?.remoteAddress||'unknown').slice(0,120)}
function rateLimit(name,{windowMs,max,blockMs=windowMs}){
 return (req,res,next)=>{
  const now=Date.now(),key=`${name}|${clientIp(req)}`,row=securityBuckets.get(key)||{start:now,count:0,blockedUntil:0};
  if(row.blockedUntil>now){
   res.setHeader('Retry-After',String(Math.ceil((row.blockedUntil-now)/1000)));
   return res.status(429).json({error:'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.'});
  }
  if(now-row.start>windowMs){row.start=now;row.count=0}
  row.count++;
  if(row.count>max){row.blockedUntil=now+blockMs;securityBuckets.set(key,row);res.setHeader('Retry-After',String(Math.ceil(blockMs/1000)));return res.status(429).json({error:'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.'})}
  securityBuckets.set(key,row);next();
 };
}
setInterval(()=>{const now=Date.now();for(const [k,v] of securityBuckets){if(now-Math.max(v.start||0,v.blockedUntil||0)>2*60*60*1000)securityBuckets.delete(k)}},30*60*1000).unref();

const loginLimiter=rateLimit('admin-login',{windowMs:15*60*1000,max:8,blockMs:15*60*1000});
const publicWriteLimiter=rateLimit('public-write',{windowMs:60*1000,max:35,blockMs:2*60*1000});

function sameOriginAdminMutation(req,res,next){
 if(!req.path.startsWith('/api/admin/'))return next();
 if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();
 const host=String(req.get('host')||'').toLowerCase();
 const origin=String(req.get('origin')||'').trim();
 const referer=String(req.get('referer')||'').trim();
 const fetchSite=String(req.get('sec-fetch-site')||'').toLowerCase();
 let ok=false;
 try{if(origin){const u=new URL(origin);ok=String(u.host||'').toLowerCase()===host}}catch{}
 if(!ok&&referer){try{const u=new URL(referer);ok=String(u.host||'').toLowerCase()===host}catch{}}
 if(!ok&&['same-origin','same-site'].includes(fetchSite))ok=true;
 if(!ok)return res.status(403).json({error:'Xavfsizlik tekshiruvi: so‘rov manbasi tasdiqlanmadi'});
 next();
}
app.use(sameOriginAdminMutation);

function signSession(user,role,exp){const raw=`${user}|${role}|${exp}`;const sig=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex');return Buffer.from(`${raw}|${sig}`).toString('base64url');}
function verifySession(token){try{const [user,role,exp,sig]=Buffer.from(token,'base64url').toString().split('|');if(!user||!role||!exp||!sig||Date.now()>Number(exp))return null;const raw=`${user}|${role}|${exp}`;const good=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex');if(sig.length!==good.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(good)))return null;return {user,role};}catch{return null}}
function requireAdmin(req,res,next){const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim(),fallback=String(req.headers['x-admin-session']||'').trim();const token=parseCookies(req).iob_admin||bearer||fallback||'';const s=verifySession(token);if(!s)return res.status(401).json({error:'Kirish talab qilinadi'});req.adminUser=s.user;req.adminRole=s.role;next();}
function requireRole(...roles){return (req,res,next)=>{if(req.adminRole==='admin'||roles.includes(req.adminRole))return next();return res.status(403).json({error:'Ruxsat yetarli emas'});}}
function audit(db,user,action,details=''){db.audit=db.audit||[];db.audit.unshift({id:Date.now()+Math.random(),at:new Date().toISOString(),user:user||'system',action:clean(action,120),details:clean(details,500)});db.audit=db.audit.slice(0,1500);}
function orderText(order){
 const loc=order.customer?.lat&&order.customer?.lng?`\n📍 Lokatsiya: https://maps.google.com/?q=${order.customer.lat},${order.customer.lng}`:'';
 const items=(order.items||[]).map((x,i)=>`${i+1}. ${x.name} × ${x.qty} — ${money(Number(x.price)*Number(x.qty))}`).join('\n');
 return `🛒 YANGI BUYURTMA #${order.orderId}\n\n👤 Mijoz: ${order.customer?.name||''}\n📞 Telefon: ${order.customer?.phone||''}\n📍 Hudud: ${order.customer?.area||''}\n🏠 Manzil: ${order.customer?.address||''}${loc}\n🚚 Yetkazish: BEPUL • ${order.customer?.deliverySlot||''}\n💳 To‘lov: ${order.customer?.payment||''}\n📝 Izoh: ${order.customer?.comment||'-'}\n\n${items}\n\n🔥 Aksiya chegirmasi: ${money(order.productDiscount||0)}\n🎟 Promo kod chegirmasi: ${money(order.discount||0)}\n💰 JAMI: ${money(order.total)}\n🕒 ${new Date(order.createdAt).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})}\n📌 Holat: ${statusLabel(order.status)}`;
}
function validatePromo(db,code,subtotal){const c=String(code||'').trim().toUpperCase();if(!c)return {ok:true,discount:0,promo:null};const p=(db.promos||[]).find(x=>String(x.code||'').toUpperCase()===c);if(!p||!p.active)return {ok:false,error:'Promo kod topilmadi yoki faol emas'};if(p.expires&&new Date(p.expires+'T23:59:59')<new Date())return {ok:false,error:'Promo kod muddati tugagan'};if(Number(p.usageLimit||0)>0&&Number(p.used||0)>=Number(p.usageLimit))return {ok:false,error:'Promo kod limiti tugagan'};if(Number(subtotal)<Number(p.minTotal||0))return {ok:false,error:`Minimal buyurtma ${money(p.minTotal)}`};let discount=p.type==='fixed'?Number(p.value||0):Math.round(Number(subtotal)*Number(p.value||0)/100);discount=Math.max(0,Math.min(discount,Number(subtotal)));return {ok:true,discount,promo:p};}

function receiptHistoryRows(db){
 const saved=Array.isArray(db.receiptHistory)?db.receiptHistory:[];
 const byId=new Map(saved.map(r=>[String(r.orderId),r]));
 for(const o of (db.orders||[])){
  if(!byId.has(String(o.orderId))) byId.set(String(o.orderId),{orderId:o.orderId,createdAt:o.createdAt,status:o.status,customer:o.customer||{},items:o.items||[],originalSubtotal:Number(o.originalSubtotal||o.subtotal||0),productDiscount:Number(o.productDiscount||0),subtotal:Number(o.subtotal||0),discount:Number(o.discount||0),deliveryFee:Number(o.deliveryFee||0),total:Number(o.total||0),payment:o.customer?.payment||o.payment||'Naqd',source:o.source||'legacy',customerConfirmed:Boolean(o.customerConfirmed),adminConfirmed:Boolean(o.adminConfirmed),completionSource:o.completionSource||(o.customerConfirmed?'customer':o.adminConfirmed?'admin':'')});
  else {const r=byId.get(String(o.orderId)); r.status=o.status; r.statusUpdatedAt=o.statusUpdatedAt||r.statusUpdatedAt;r.customerConfirmed=Boolean(o.customerConfirmed);r.adminConfirmed=Boolean(o.adminConfirmed);r.completionSource=o.completionSource||(o.customerConfirmed?'customer':o.adminConfirmed?'admin':'');}
 }
 return [...byId.values()].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
}

function getCustomers(orders){const m=new Map();for(const o of orders){const phone=String(o.customer?.phone||'').replace(/\D/g,'');if(!phone)continue;const c=m.get(phone)||{name:o.customer?.name||'',phone:o.customer?.phone||'',orders:0,total:0,lastOrder:'',areas:{}};c.orders++;if(['completed','done'].includes(o.status))c.total+=Number(o.total||0);if(!c.lastOrder||String(o.createdAt)>c.lastOrder)c.lastOrder=o.createdAt;c.areas[o.customer?.area||'Noma’lum']=(c.areas[o.customer?.area||'Noma’lum']||0)+1;m.set(phone,c);}return [...m.values()].sort((a,b)=>b.total-a.total);}


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
 db=normalizeDb(db||initialDb());
 const products=db.products||[], orders=db.orders||[], fsx=db.financeSettings||{}, purchases=db.financePurchases||[], payments=db.financeCompanyPayments||[], payroll=db.financePayroll||[], expenses=db.financeExpenses||[], taxPayments=db.financeTaxPayments||[];
 const done=orders.filter(o=>['completed','done'].includes(o.status)&&finPeriodMatch(o.statusUpdatedAt||o.createdAt,opts));
 const revenue=done.reduce((a,o)=>a+finNum(o.total),0);
 const productDiscount=done.reduce((a,o)=>a+finNum(o.productDiscount),0);
 const promoCodeDiscount=done.reduce((a,o)=>a+finNum(o.discount),0);
 const discountTotal=productDiscount+promoCodeDiscount;
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
 return {revenue,productDiscount,promoCodeDiscount,discountTotal,cogs,grossProfit,purchaseTotal,supplierPaid,payrollGross,payrollPaid,otherExpenses,turnoverTax,payrollTax,payrollIncomeTaxRate,payrollPensionRate,payrollBudgetShareRate,payrollPensionShare,payrollBudgetShare,employerSocialTax,employerSocialTaxRate,landTax,propertyTax,otherTax,taxAccrued,taxPaid,taxDebt:Math.max(0,taxAccrued-taxPaid),netProfit,orders:done.length};
}
function financeCurrentBalance(db){
 db=normalizeDb(db||initialDb());
 const fsx=db.financeSettings||{}, products=db.products||[];
 const purchases=db.financePurchases||[], companyPayments=db.financeCompanyPayments||[], payroll=db.financePayroll||[], taxPayments=db.financeTaxPayments||[];
 const companyIds=new Set([...(db.financeCompanies||[]).map(x=>String(x.id)),...purchases.map(x=>String(x.companyId||'')),...companyPayments.map(x=>String(x.companyId||''))]);
 let supplierDebt=0,supplierAdvances=0;
 for(const id of companyIds){if(!id)continue;const bought=purchases.filter(x=>String(x.companyId||'')===id).reduce((a,x)=>a+finNum(x.total),0),paid=companyPayments.filter(x=>String(x.companyId||'')===id).reduce((a,x)=>a+finNum(x.amount),0),net=bought-paid;if(net>=0)supplierDebt+=net;else supplierAdvances+=-net;}
 const inventoryValue=products.reduce((a,p)=>a+finNum(p.stock)*finNum(p.cost),0);
 let payrollDebt=0,payrollAdvances=0;for(const x of payroll){const net=finNum(x.payable)-finNum(x.paid);if(net>=0)payrollDebt+=net;else payrollAdvances+=-net;}
 const year=String(new Date().getFullYear()),y=financeSummary(db,{period:'yearly',value:year}),taxPaidYear=taxPayments.filter(x=>finDate(x.date||x.createdAt).slice(0,4)===year).reduce((a,x)=>a+finNum(x.amount),0),taxNet=y.taxAccrued-taxPaidYear,taxDebt=Math.max(0,taxNet),taxAdvances=Math.max(0,-taxNet);
 const revenueAll=(db.orders||[]).filter(o=>['completed','done'].includes(o.status)).reduce((a,o)=>a+finNum(o.total),0);
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

app.get('/api/version',(req,res)=>res.json({ok:true,version:'13.26.75',adminFix:'realtime-app-control-sync'}));
app.get('/health',async(req,res)=>{
 try{
  if(REQUIRE_DATABASE && !pool) throw new Error('database_not_configured');
  if(pool) await dbQuery('SELECT 1');
  res.status(200).json({ok:true,storage:pool?'postgresql':'local'});
 }catch(e){res.status(503).json({ok:false,storage:'postgresql',error:'database_unavailable'});}
});
// V13.26.20 — public tashrif hisoblagichi (PII/IP saqlanmaydi)
app.post('/api/visit',async(req,res)=>{
  try{
    const visitorId=clean(req.body?.visitorId,80),sessionId=clean(req.body?.sessionId,80),page=clean(req.body?.page,240)||'/',referrer=clean(req.body?.referrer,300),lang=clean(req.body?.lang,12),ua=clean(req.headers['user-agent']||'',500);
    if(!visitorId||!sessionId)return res.status(400).json({error:'visitorId/sessionId kerak'});
    const now=new Date().toISOString(),db=readDb();db.visits=Array.isArray(db.visits)?db.visits:[];
    const duplicate=db.visits.find(x=>x.sessionId===sessionId && x.page===page && Date.now()-new Date(x.at).getTime()<30*60*1000);
    if(!duplicate){db.visits.push({id:'VIS-'+Date.now()+'-'+crypto.randomInt(100,999),visitorId,sessionId,at:now,page,referrer,lang,device:visitorDevice(ua)});if(db.visits.length>20000)db.visits=db.visits.slice(-20000);await writeDb(db);broadcastRealtime('visit');}
    onlineVisitors.set(visitorId,{lastSeen:Date.now(),sessionId,page});
    res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message||'Tashrifni yozishda xatolik'});}
});
app.post('/api/visit/ping',(req,res)=>{const visitorId=clean(req.body?.visitorId,80),sessionId=clean(req.body?.sessionId,80),page=clean(req.body?.page,240)||'/';if(visitorId)onlineVisitors.set(visitorId,{lastSeen:Date.now(),sessionId,page});res.json({ok:true});});

app.get('/api/status',(req,res)=>res.json({ok:true,version:'13.26.75',telegramConfigured:Boolean(BOT_TOKEN&&CHAT_ID),adminOnline:true,storage:pool?'postgresql':'local-json',persistent:Boolean(pool),dataFile:DB_FILE}));
app.get('/api/healthz',async(req,res)=>{
 try{
  if(pool)await dbQuery('SELECT 1',[],{retries:1});
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,version:'13.26.75',storage:pool?'postgresql':'local-json',at:new Date().toISOString()});
 }catch(e){
  res.status(503).json({ok:false,version:'13.26.75',error:e.message||'database_unavailable',at:new Date().toISOString()});
 }
});
app.get('/api/admin/storage-diagnostics',requireAdmin,async(req,res)=>{
 try{
  const cacheCount=Array.isArray(dbCache?.products)?dbCache.products.length:0;
  const out={ok:true,storage:pool?'postgresql':'local-json',persistent:Boolean(pool),cacheProductCount:cacheCount,committedProductCount:committedProducts.size,dataFile:DB_FILE};
  if(pool){
   const r=await dbQuery("SELECT updated_at, jsonb_array_length(COALESCE(data->'products','[]'::jsonb)) AS product_count FROM shop_state WHERE id=1");
   out.postgresProductCount=r.rows.length?Number(r.rows[0].product_count||0):0;
   out.postgresUpdatedAt=r.rows.length?r.rows[0].updated_at:null;
   out.countsMatch=out.postgresProductCount===cacheCount && cacheCount===committedProducts.size;
  }
  res.setHeader('Cache-Control','no-store');res.json(out);
 }catch(e){res.status(503).json({ok:false,error:e.message||'diagnostics_failed'});}
});
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
app.get('/api/app-events',(req,res)=>{
 res.setHeader('Content-Type','text/event-stream; charset=utf-8');
 res.setHeader('Cache-Control','no-cache, no-transform');
 res.setHeader('Connection','keep-alive');
 res.setHeader('X-Accel-Buffering','no');
 res.flushHeaders?.();
 appRealtimeClients.add(res);
 res.write(`event: ready\ndata: ${JSON.stringify({revision:appRealtimeRevision,at:new Date().toISOString()})}\n\n`);
 const ping=setInterval(()=>{try{res.write(`: app-ping ${Date.now()}\n\n`)}catch{}},20000);
 req.on('close',()=>{clearInterval(ping);appRealtimeClients.delete(res)});
});
app.get('/api/app-realtime/health',(req,res)=>res.json({ok:true,module:'zarbuloq-app-control-realtime',version:'13.26.75',revision:appRealtimeRevision,clients:appRealtimeClients.size}));

app.get('/api/catalog',(req,res)=>{const db=readDb(),groups={};for(const r of db.productReviews||[]){const k=String(r.productId||'');if(k)(groups[k]??=[]).push(r)}const products=(db.products||[]).map(p=>{const rs=groups[String(p.id)]||[],sum=rs.length?reviewSummary(rs):{average:0,count:0};return {...publicProductWithPromotion(db,p),ratingAverage:sum.average,ratingCount:sum.count}});res.json({products,categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',promos:(db.promos||[]).filter(p=>p.active).map(p=>({code:p.code,minTotal:p.minTotal,type:p.type,value:p.value,expires:p.expires}))});});
app.get('/api/app-config',(req,res)=>{const db=readDb(),c={...defaultSettings.appControl,...(db.settings?.appControl||{})};res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.json({ok:true,app:c,serverVersion:'13.26.74',revision:appRealtimeRevision,realtimeUrl:'/api/app-events'});});
function localizedMessageField(v,lang='uz'){
 if(v&&typeof v==='object')return clean(v[lang]||v.uz||v.ru||v.en||'',1200);
 return clean(v,1200);
}
app.get('/api/app-notifications',(req,res)=>{
 const db=readDb(),lang=['uz','ru'].includes(String(req.query.lang||''))?String(req.query.lang):'uz';
 const after=clean(req.query.after,120),rows=(db.appNotifications||[]).filter(x=>x&&x.active!==false).filter(x=>!after||String(x.id)!==after);
 const items=rows.slice(0,100).map(x=>({id:String(x.id||''),createdAt:x.createdAt||'',title:localizedMessageField(x.title,lang),body:localizedMessageField(x.body,lang),kind:x.kind||'info',actionUrl:x.actionUrl||'',important:Boolean(x.important)}));
 res.setHeader('Cache-Control','no-store');res.json({ok:true,items,latestId:items[0]?.id||''});
});
app.post('/api/promo/validate',(req,res)=>{const db=readDb();const result=validatePromo(db,req.body?.code,Number(req.body?.subtotal||0));if(!result.ok)return res.status(400).json(result);res.json({ok:true,discount:result.discount,code:result.promo?.code||''});});
app.get('/api/track/:orderId',(req,res)=>{const db=readDb();const order=(db.orders||[]).find(o=>o.orderId===req.params.orderId);if(!order)return res.status(404).json({error:'Buyurtma topilmadi'});const phone=String(req.query.phone||'').replace(/\D/g,'');const stored=String(order.customer?.phone||'').replace(/\D/g,'');if(!phone||phone.slice(-9)!==stored.slice(-9))return res.status(403).json({error:'Telefon raqami mos kelmadi'});const completionSource=order.completionSource||(order.customerConfirmed?'customer':order.adminConfirmed?'admin':'');res.json({orderId:order.orderId,status:order.status,statusLabel:statusLabel(order.status),completionSource,completionLabel:completionSource==='customer'?'Haridor tomonidan tasdiqlangan':completionSource==='admin'?'Admin tomonidan tasdiqlangan':'',customerConfirmed:Boolean(order.customerConfirmed),adminConfirmed:Boolean(order.adminConfirmed),createdAt:order.createdAt,statusUpdatedAt:order.statusUpdatedAt,total:order.total,subtotal:order.subtotal,discount:order.discount||0,area:order.customer?.area||'',address:order.customer?.address||'',payment:order.customer?.payment||'',deliverySlot:order.customer?.deliverySlot||'',items:(order.items||[]).map(x=>({id:x.id,name:x.name,qty:x.qty,price:x.price})),statusHistory:order.statusHistory||[]});});



// V13.26.29 — Android ilova uchun haqiqiy mahsulot baholari va izohlar.
const reviewHits=new Map();
function normalizeReviewPhone(v){let d=String(v??'').replace(/\D/g,'');if(d.length===9)d='998'+d;return d;}
function reviewKey(productId,phone){return crypto.createHash('sha256').update(`${productId}|${normalizeReviewPhone(phone)}`).digest('hex');}
function publicReview(r){return {id:String(r.id||''),productId:String(r.productId||''),name:clean(r.name,80)||'Foydalanuvchi',rating:Math.max(1,Math.min(5,Number(r.rating)||1)),comment:clean(r.comment,500),adminReply:clean(r.adminReply,700),adminReplyAt:r.adminReplyAt||'',createdAt:r.createdAt||new Date().toISOString(),updatedAt:r.updatedAt||r.createdAt||new Date().toISOString()};}
function reviewSummary(rows){const a=Array.isArray(rows)?rows:[];if(!a.length)return {average:0,count:0};return {average:Math.round((a.reduce((x,r)=>x+Math.max(1,Math.min(5,Number(r.rating)||1)),0)/a.length)*10)/10,count:a.length};}
function reviewAllowed(req){const k=String(req.ip||req.socket?.remoteAddress||'unknown'),now=Date.now(),a=(reviewHits.get(k)||[]).filter(t=>now-t<60000);if(a.length>=15)return false;a.push(now);reviewHits.set(k,a);return true;}
app.get('/api/reviews/summary',(req,res)=>{
 const db=readDb(),out={};
 for(const r of db.productReviews||[]){const pid=String(r.productId||'');if(!pid)continue;(out[pid]??=[]).push(r);}
 const products={};for(const [pid,rows] of Object.entries(out))products[pid]=reviewSummary(rows);
 res.json({ok:true,products});
});
app.get('/api/products/:productId/reviews',(req,res)=>{
 const pid=clean(req.params.productId,80);if(!pid)return res.status(400).json({error:'Mahsulot ID topilmadi'});
 const rows=(readDb().productReviews||[]).filter(r=>String(r.productId)===String(pid)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).slice(0,100).map(publicReview);
 res.json({ok:true,productId:pid,summary:reviewSummary(rows),reviews:rows});
});
app.post('/api/products/:productId/reviews',async(req,res)=>{
 try{
  if(!reviewAllowed(req))return res.status(429).json({error:'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.'});
  const pid=clean(req.params.productId,80),b=req.body||{},name=clean(b.name,80),comment=clean(b.comment,500),rating=Number(b.rating),phone=normalizeReviewPhone(b.phone);
  if(!pid)return res.status(400).json({error:'Mahsulot ID topilmadi'});
  if(name.length<2)return res.status(400).json({error:'Ismni kiriting'});
  if(!/^998\d{9}$/.test(phone))return res.status(400).json({error:'+998 telefon raqamini to‘g‘ri kiriting'});
  if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'1 dan 5 gacha baho tanlang'});
  if(comment.length<2)return res.status(400).json({error:'Izoh yozing'});
  const db=readDb(),key=reviewKey(pid,phone),now=new Date().toISOString();db.productReviews=Array.isArray(db.productReviews)?db.productReviews:[];
  let row=db.productReviews.find(r=>String(r.productId)===String(pid)&&r.reviewerKey===key);
  const phoneMasked='+998 ** *** ** '+phone.slice(-2);
  if(row){row.name=name;row.rating=rating;row.comment=comment;row.phoneMasked=phoneMasked;row.updatedAt=now;}
  else{row={id:crypto.randomUUID(),productId:String(pid),reviewerKey:key,name,rating,comment,phoneMasked,adminReply:'',adminReplyAt:'',createdAt:now,updatedAt:now};db.productReviews.unshift(row);}
  db.productReviews=db.productReviews.slice(0,5000);audit(db,'customer','Mahsulot izohi',`#${pid} • ${name} • ${rating}★`);await writeDb(db);
  const rows=(db.productReviews||[]).filter(r=>String(r.productId)===String(pid)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).slice(0,100).map(publicReview);
  res.status(201).json({ok:true,published:true,productId:String(pid),summary:reviewSummary(rows),reviews:rows});
 }catch(e){console.error('Review save:',e);res.status(500).json({error:'Fikrni saqlab bo‘lmadi'})}
});


app.patch('/api/admin/reviews/:id/reply',requireAdmin,async(req,res)=>{
 try{const db=readDb(),row=(db.productReviews||[]).find(x=>String(x.id)===String(req.params.id));if(!row)return res.status(404).json({error:'Izoh topilmadi'});const reply=clean(req.body?.reply,700);if(reply.length<1)return res.status(400).json({error:'Javob matnini kiriting'});row.adminReply=reply;row.adminReplyAt=new Date().toISOString();row.adminReplyBy=req.adminUser;audit(db,req.adminUser,'Izohga javob',`${row.productId} • ${row.name}`);await writeDb(db);res.json({ok:true,review:publicReview(row)});}catch(e){res.status(500).json({error:'Javobni saqlab bo‘lmadi'})}
});
app.delete('/api/admin/reviews/:id',requireAdmin,async(req,res)=>{
 try{const db=readDb(),i=(db.productReviews||[]).findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({error:'Izoh topilmadi'});const [row]=db.productReviews.splice(i,1);audit(db,req.adminUser,'Izoh o‘chirildi',`${row.productId} • ${row.name}`);await writeDb(db);res.json({ok:true,deleted:row.id});}catch(e){res.status(500).json({error:'Izohni o‘chirib bo‘lmadi'})}
});

app.post('/api/product-requests',publicWriteLimiter,async(req,res)=>{
 try{
  const db=readDb(), b=req.body||{};
  const name=clean(b.productName,160), phone=clean(b.phone,40), customer=clean(b.customerName,100), size=clean(b.size,80), comment=clean(b.comment,500), qty=Math.max(1,Math.min(999,Math.floor(Number(b.qty)||1)));
  if(!name||!phone)return res.status(400).json({error:'Mahsulot nomi va telefon raqami majburiy'});
  const image=String(b.image||''); if(image && (!image.startsWith('data:image/')||image.length>5_000_000))return res.status(400).json({error:'Rasm hajmi yoki formati noto‘g‘ri'});
  const attachment=String(b.attachment||'');
  const attachmentName=clean(b.attachmentName,180),attachmentMime=clean(b.attachmentMime,120);
  if(attachment && (!attachment.startsWith('data:')||attachment.length>5_000_000))return res.status(400).json({error:'Fayl hajmi yoki formati noto‘g‘ri'});
  const requestId='REQ-'+new Date().toISOString().slice(2,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-5);
  const item={requestId,createdAt:new Date().toISOString(),status:'new',productName:name,qty,size,customerName:customer,phone,comment,image:image.slice(0,5_000_000),attachment:attachment.slice(0,5_000_000),attachmentName,attachmentMime};
  db.productRequests=db.productRequests||[]; db.productRequests.unshift(item); db.productRequests=db.productRequests.slice(0,1000); audit(db,'mijoz','Mahsulot so‘rovi',requestId+' '+name); await writeDb(db);
  if(BOT_TOKEN&&CHAT_ID){let text=`🔎 YANGI MAHSULOT SO‘ROVI #${requestId}\n\n📦 Mahsulot: ${name}\n🔢 Miqdor: ${qty}\n📐 O‘lcham/Hajm: ${size||'—'}\n👤 Mijoz: ${customer||'—'}\n📞 Telefon: ${phone}\n💬 Izoh: ${comment||'—'}\n🌐 ZARBULOQ.UZ`;try{if(attachment||image)text+=`\n📎 Biriktirma: ${attachmentName||'rasm/fayl'} — Admin panelda ko‘ring.`;await tgCall('sendMessage',{chat_id:CHAT_ID,text})}catch(e){console.error('Product request Telegram:',e.message||e)}}
  res.json({ok:true,requestId});
 }catch(e){console.error(e);res.status(500).json({error:'So‘rovni yuborib bo‘lmadi'})}
});

// V13.17 — sayt ichidagi mijoz ↔ admin LIVE chat
function chatId(v=''){return clean(v,90).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,90)}
function publicChatView(c){return {sessionId:c.sessionId,name:c.name||'',phone:c.phone||'',updatedAt:c.updatedAt||c.createdAt,messages:(c.messages||[]).slice(-200).map(m=>({id:m.id,from:m.from,text:m.text,createdAt:m.createdAt}))}}
app.get('/api/chat/:sessionId',(req,res)=>{const id=chatId(req.params.sessionId);if(!id)return res.status(400).json({error:'Chat ID noto‘g‘ri'});const db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);res.json(c?publicChatView(c):{sessionId:id,messages:[]})});
app.post('/api/chat/send',publicWriteLimiter,async(req,res)=>{const id=chatId(req.body?.sessionId),text=clean(req.body?.message,1200),name=clean(req.body?.name,80),phone=clean(req.body?.phone,30),phoneDigits=phone.replace(/\D/g,'');if(!id||!text)return res.status(400).json({error:'Xabar yozing'});if(name.length<2)return res.status(400).json({error:'Chat uchun ismingiz majburiy'});if(!/^(998)?\d{9}$/.test(phoneDigits))return res.status(400).json({error:'Telefon raqamini +998 formatida to‘g‘ri kiriting'});const db=readDb();db.chats=db.chats||[];let c=db.chats.find(x=>x.sessionId===id);if(!c){c={sessionId:id,name,phone,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),unreadAdmin:0,messages:[]};db.chats.unshift(c)}if(name)c.name=name;if(phone)c.phone=phone;c.updatedAt=new Date().toISOString();c.unreadAdmin=Number(c.unreadAdmin||0)+1;c.messages=c.messages||[];c.messages.push({id:'m-'+Date.now()+'-'+crypto.randomInt(100,999),from:'customer',text,createdAt:new Date().toISOString()});c.messages=c.messages.slice(-300);db.chats=db.chats.slice(0,500);audit(db,'customer','Chat xabari',id);await writeDb(db);res.json({ok:true,chat:publicChatView(c)})});
app.post('/api/admin/chats/:sessionId/send',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId),text=clean(req.body?.message,1200);if(!id||!text)return res.status(400).json({error:'Xabar yozing'});const db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);if(!c)return res.status(404).json({error:'Chat topilmadi'});c.messages=c.messages||[];c.messages.push({id:'m-'+Date.now()+'-'+crypto.randomInt(100,999),from:'admin',text,createdAt:new Date().toISOString(),actor:req.adminUser});c.messages=c.messages.slice(-300);c.updatedAt=new Date().toISOString();c.unreadAdmin=0;audit(db,req.adminUser,'Chat javobi',id);await writeDb(db);res.json({ok:true})});
app.patch('/api/admin/chats/:sessionId/read',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId),db=readDb(),c=(db.chats||[]).find(x=>x.sessionId===id);if(c){c.unreadAdmin=0;await writeDb(db)}res.json({ok:true})});
app.delete('/api/admin/chats/:sessionId',requireAdmin,async(req,res)=>{const id=chatId(req.params.sessionId);if(!id)return res.status(400).json({error:'Chat ID noto‘g‘ri'});const db=readDb();const before=(db.chats||[]).length;db.chats=(db.chats||[]).filter(x=>x.sessionId!==id);if(db.chats.length===before)return res.status(404).json({error:'Chat topilmadi'});audit(db,req.adminUser,'Chat o‘chirildi',id);await writeDb(db);res.json({ok:true})});
app.delete('/api/admin/chats',requireAdmin,async(req,res)=>{const db=readDb();const count=(db.chats||[]).length;db.chats=[];audit(db,req.adminUser,'Barcha chatlar o‘chirildi',String(count));await writeDb(db);res.json({ok:true,count})});

function safePasswordEqual(a,b){
 const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));
 return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb);
}
app.post('/api/admin/login',loginLimiter,(req,res)=>{
 const u=clean(req.body?.username,80),p=String(req.body?.password||'');
 const user=USERS.find(x=>x.username===u);
 const found=user&&safePasswordEqual(user.password,p)?user:null;
 if(!found){console.warn('Admin login failed:',clientIp(req),u||'(empty)');return res.status(401).json({error:'Login yoki parol noto‘g‘ri'})}
 const exp=Date.now()+12*60*60*1000,sessionToken=signSession(found.username,found.role,exp);
 res.setHeader('Set-Cookie',`iob_admin=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Expires=${new Date(exp).toUTCString()}${process.env.NODE_ENV==='production'?'; Secure':''}`);
 res.setHeader('Cache-Control','no-store');
 res.json({ok:true,user:found.username,role:found.role,expiresAt:exp});
});
app.post('/api/admin/logout',(req,res)=>{
 res.setHeader('Set-Cookie',`iob_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);
 res.setHeader('Cache-Control','no-store');
 res.json({ok:true});
});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({ok:true,user:req.adminUser,role:req.adminRole}));

// V13.26.75 — admin product list is loaded independently from the heavy dashboard payload.
app.get('/api/admin/products',requireAdmin,(req,res)=>{
 const db=normalizeDb(readDb()||initialDb());
 res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.setHeader('Pragma','no-cache');
 res.setHeader('Expires','0');
 const products=(db.products||[]).map(adminProductPayload);
 res.json({ok:true,products,categories:db.categories||[],productCount:products.length,storage:pool?'postgresql':'local-json',revision:realtimeRevision,updatedAt:new Date().toISOString()});
});
app.get('/api/admin/products/:id/image',requireAdmin,(req,res)=>{
 try{
  const db=readDb(),id=Number(req.params.id),p=(db.products||[]).find(x=>Number(x.id)===id);
  if(!p||!p.image)return res.status(404).end();
  const raw=String(p.image||'').trim();
  const m=raw.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i);
  if(m){
   const mime=m[1].toLowerCase()==='image/jpg'?'image/jpeg':m[1].toLowerCase();
   const buf=Buffer.from(m[2],'base64');
   res.setHeader('Content-Type',mime);
   res.setHeader('Cache-Control','private, max-age=3600');
   return res.end(buf);
  }
  if(/^https?:\/\//i.test(raw)||raw.startsWith('/'))return res.redirect(raw);
  return res.redirect('/'+raw.replace(/^\/+/,''));
 }catch(e){return res.status(404).end()}
});

app.get('/api/admin/dashboard',requireAdmin,(req,res)=>{
 res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
 res.setHeader('Pragma','no-cache');
 res.setHeader('Expires','0');
 const db=normalizeDb(readDb()||initialDb()),orders=db.orders||[],products=db.products||[],receipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[];const today=new Date().toISOString().slice(0,10),month=today.slice(0,7),year=today.slice(0,4);const done=orders.filter(o=>['completed','done'].includes(o.status));
 const costFor=o=>(o.items||[]).reduce((s,i)=>{const p=products.find(x=>Number(x.id)===Number(i.id));return s+(Number(p?.cost||0)*Number(i.qty||1));},0);
 const revenue=done.reduce((s,o)=>s+Number(o.total||0),0),profit=done.reduce((s,o)=>s+Number(o.total||0)-costFor(o),0);const avg=done.length?Math.round(revenue/done.length):0;
 const topMap={};for(const o of done)for(const i of o.items||[]){topMap[i.name]=(topMap[i.name]||0)+Number(i.qty||1)}
 const areaMap={};for(const o of orders){const a=o.customer?.area||'Noma’lum';areaMap[a]=(areaMap[a]||0)+1}
 const last7=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=d.toISOString().slice(0,10);last7.push({date:key,revenue:done.filter(o=>String(o.createdAt).slice(0,10)===key).reduce((s,o)=>s+Number(o.total||0),0),orders:orders.filter(o=>String(o.createdAt||'').slice(0,10)===key).length});}
 // V13.22 dashboard analytics: all history aggregated by month/product/status.
 const monthlyMap=new Map();
 const ensure=(m,p)=>{const k=`${m}|${p.id}`;if(!monthlyMap.has(k))monthlyMap.set(k,{month:m,productId:Number(p.id),receivedQty:0,soldQty:0,soldAmount:0,applicationQty:0,applicationAmount:0,deliveryQty:0,deliveryAmount:0,doneQty:0,doneAmount:0,acceptedQty:0,acceptedAmount:0,cancelledQty:0,cancelledAmount:0});return monthlyMap.get(k)};
 for(const o of orders){const eventDate=['accepted','preparing','delivery','delivered','completed','done','cancelled'].includes(o.status)?String(o.statusUpdatedAt||o.stockAdjustedAt||o.createdAt||''):String(o.createdAt||'');const om=eventDate.slice(0,7);if(!/^\d{4}-\d{2}$/.test(om))continue;for(const it of o.items||[]){const p=products.find(x=>Number(x.id)===Number(it.id));if(!p)continue;const r=ensure(om,p),qty=Math.max(0,Number(it.qty||0)),unitPrice=Math.max(0,Number(it.price??p.price??0)),amount=qty*unitPrice;if(o.status==='new'){r.applicationQty+=qty;r.applicationAmount+=amount}else if(['accepted','preparing'].includes(o.status)){r.acceptedQty+=qty;r.acceptedAmount+=amount}else if(['delivery','delivered'].includes(o.status)){r.deliveryQty+=qty;r.deliveryAmount+=amount;r.soldQty+=qty;r.soldAmount+=amount}else if(['completed','done'].includes(o.status)){r.doneQty+=qty;r.doneAmount+=amount;r.soldQty+=qty;r.soldAmount+=amount}else if(o.status==='cancelled'){r.cancelledQty+=qty;r.cancelledAmount+=amount}}}
 for(const rc of receipts){const rm=String(rc.createdAt||'').slice(0,7),p=products.find(x=>Number(x.id)===Number(rc.productId));if(!p||!/^\d{4}-\d{2}$/.test(rm))continue;ensure(rm,p).receivedQty+=Math.max(0,Number(rc.qty)||0)}
 // receivedQty is cumulative metadata. inventoryReceipts is the authoritative receipt ledger; do not add receivedQty again (prevents 2x stock reports).
 const years=[...new Set([...monthlyMap.values()].map(r=>Number(String(r.month).slice(0,4))).filter(Boolean))].sort((a,b)=>b-a);if(!years.includes(Number(year)))years.unshift(Number(year));
 const analytics={products:products.map(p=>({id:Number(p.id),name:p.name?.uz||'',nameRu:p.name?.ru||'',unit:p.unit?.uz||'dona',stock:Number(p.stock||0),cost:Number(p.cost||0),price:Number(p.price||0)})),years,monthly:[...monthlyMap.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.productId-b.productId)};
 const soldOrders=orders.filter(o=>['delivery','delivered','completed','done'].includes(normalizeOrderStatus(o.status)));
 const sourceBase={web:{orders:0,revenue:0},app:{orders:0,revenue:0},legacy:{orders:0,revenue:0}};
 for(const o of orders){let src=String(o.source||'legacy').toLowerCase();if(src==='android'||src==='mobile')src='app';if(!sourceBase[src])src='legacy';sourceBase[src].orders++;if(['delivery','delivered','completed','done'].includes(normalizeOrderStatus(o.status)))sourceBase[src].revenue+=Number(o.total||0)}
 const nowMs=Date.now(), perfMap=new Map(products.map(p=>[String(p.id),{productId:Number(p.id),name:p.name?.uz||'',stock:Number(p.stock||0),price:Number(p.price||0),cost:Number(p.cost||0),soldQty:0,soldAmount:0,orderCount:0,lastSaleAt:'',daysSinceLastSale:null,stockValue:Number(p.stock||0)*Number(p.cost||0),turnoverRate:0}]));
 for(const o of soldOrders){for(const it of o.items||[]){const r=perfMap.get(String(it.id));if(!r)continue;const q=Math.max(0,Number(it.qty||0));r.soldQty+=q;r.soldAmount+=q*Number(it.price||0);r.orderCount+=1;const dt=String(o.statusUpdatedAt||o.createdAt||'');if(dt&&(!r.lastSaleAt||dt>r.lastSaleAt))r.lastSaleAt=dt}}
 const perf=[...perfMap.values()].map(r=>{if(r.lastSaleAt){const t=new Date(r.lastSaleAt).getTime();r.daysSinceLastSale=Number.isFinite(t)?Math.max(0,Math.floor((nowMs-t)/86400000)):null}r.turnoverRate=(r.soldQty+r.stock)>0?Math.round((r.soldQty/(r.soldQty+r.stock))*1000)/10:0;r.risk=r.stock<=5?'low-stock':(r.stock>0&&(r.soldQty===0||(r.daysSinceLastSale!==null&&r.daysSinceLastSale>=30)))?'stagnant':r.soldQty>0?'normal':'no-sales';return r});
 const bySold=[...perf].sort((a,b)=>b.soldQty-a.soldQty||b.soldAmount-a.soldAmount), lowSold=[...perf].filter(x=>x.stock>0).sort((a,b)=>a.soldQty-b.soldQty||b.stock-a.stock), stagnant=[...perf].filter(x=>x.risk==='stagnant').sort((a,b)=>(b.daysSinceLastSale??9999)-(a.daysSinceLastSale??9999)||b.stockValue-a.stockValue), lowStock=[...perf].filter(x=>x.stock<=5).sort((a,b)=>a.stock-b.stock);
 const salesIntelligence={sources:sourceBase,topProducts:bySold.slice(0,20),lowProducts:lowSold.slice(0,20),stagnant:stagnant.slice(0,50),lowStock:lowStock.slice(0,50),inventoryValue:perf.reduce((a,x)=>a+x.stockValue,0),soldQty:perf.reduce((a,x)=>a+x.soldQty,0),soldAmount:perf.reduce((a,x)=>a+x.soldAmount,0),activeProducts:perf.filter(x=>x.soldQty>0).length,noSaleProducts:perf.filter(x=>x.soldQty===0&&x.stock>0).length};
 res.json({salesIntelligence,visitorStats:visitorStats(db),visits:(db.visits||[]).slice().reverse().slice(0,1000),role:req.adminRole,financeQuick:{summary:financeSummary(db,{period:'monthly',value:month}),balance:financeCurrentBalance(db)},warehousePurchases:(db.financePurchases||[]).slice().reverse().slice(0,1500).map(x=>{const c=(db.financeCompanies||[]).find(z=>String(z.id)===String(x.companyId)),p=(db.products||[]).find(z=>Number(z.id)===Number(x.productId));return {id:x.id,productId:Number(x.productId),productName:p?.name?.uz||x.productName||'',unit:p?.unit?.uz||x.unit||'',companyId:x.companyId,companyName:c?.name||'',companyInn:c?.inn||'',date:x.date||'',invoice:x.invoice||'',qty:finNum(x.qty),unitCost:finNum(x.unitCost),salePrice:finNum(x.salePrice||x.suggestedSalePrice),total:finNum(x.total)}}),productReviews:(db.productReviews||[]).slice(0,2000).map(r=>{const p=products.find(x=>String(x.id)===String(r.productId));return {...r,reviewerKey:undefined,productName:p?.name?.uz||p?.name?.ru||('Mahsulot #'+r.productId)}}),productRequests:(db.productRequests||[]).slice(0,500),orderComplaints:(db.orderComplaints||[]).slice(0,500),chats:(db.chats||[]).slice(0,500),appNotifications:(db.appNotifications||[]).slice(0,500),stats:{orders:orders.length,today:orders.filter(o=>String(o.createdAt||'').slice(0,10)===today).length,month:orders.filter(o=>String(o.createdAt||'').slice(0,7)===month).length,year:orders.filter(o=>String(o.createdAt||'').slice(0,4)===year).length,revenue,profit,avg,pending:orders.filter(o=>['new','accepted','preparing','delivery','delivered'].includes(o.status)).length,cancelled:orders.filter(o=>o.status==='cancelled').length,lowStock:products.filter(p=>Number(p.stock||0)<=5).length,customers:getCustomers(orders).length},orders:orders.slice().reverse().slice(0,300),products:products.map(adminProductPayload),categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',customers:getCustomers(orders),promos:db.promos||[],productPromotions:db.productPromotions||[],audit:(db.audit||[]).slice(0,500),analytics,charts:{last7,topProducts:Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,qty])=>({name,qty})),areas:Object.entries(areaMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}))}});
});

// V13.26.56 — Excel orqali omborga mahsulot importi.
const EXCEL_IMPORT_HEADERS=[
 'Mahsulot kodi','Nomi UZ','Nomi RU','Kategoriya UZ','Kategoriya RU',
 "Sotuv narxi (so'm)","Tannarx (so'm)",'Omborga miqdor','Birlik UZ','Birlik RU',
 'Tavsif UZ','Tavsif RU','Rasm URL'
];
function excelCell(row,names){
 for(const n of names)if(Object.prototype.hasOwnProperty.call(row,n)&&String(row[n]??'').trim()!=='')return row[n];
 return '';
}
function excelNumber(v){const n=Number(String(v??'').replace(/\s/g,'').replace(/,/g,'.').replace(/[^\d.-]/g,''));return Number.isFinite(n)?n:0}
function normalizeImportRow(row,rowNo){
 const sku=clean(excelCell(row,['Mahsulot kodi','Kod','SKU','Артикул']),60);
 const nameUz=clean(excelCell(row,['Nomi UZ','Mahsulot nomi UZ','Nomi','Mahsulot nomi']),120);
 const nameRu=clean(excelCell(row,['Nomi RU','Название RU','Название товара','Название']),120);
 const catUz=clean(excelCell(row,['Kategoriya UZ','Kategoriya','Bo‘lim']),120);
 const catRu=clean(excelCell(row,['Kategoriya RU','Категория RU','Категория']),120);
 const price=Math.max(0,excelNumber(excelCell(row,["Sotuv narxi (so'm)",'Sotuv narxi','Narxi',"Narxi (so'm)",'Цена продажи'])));
 const cost=Math.max(0,excelNumber(excelCell(row,["Tannarx (so'm)",'Tannarx','Xarid narxi','Себестоимость'])));
 const qty=Math.max(0,excelNumber(excelCell(row,['Omborga miqdor','Ombor miqdori','Miqdor','Zaxira','Количество'])));
 const unitUz=clean(excelCell(row,['Birlik UZ','Birlik','O‘lchov birligi']),30)||'dona';
 const unitRu=clean(excelCell(row,['Birlik RU','Единица RU','Единица']),30)||'шт';
 const descriptionUz=clean(excelCell(row,['Tavsif UZ','Mahsulot ma’lumoti UZ','Tavsif']),1200);
 const descriptionRu=clean(excelCell(row,['Tavsif RU','Описание RU','Описание']),1200);
 const image=String(excelCell(row,['Rasm URL','Rasm','Фото URL','Image URL'])||'').trim().slice(0,2000);
 return {rowNo,sku,nameUz,nameRu,catUz,catRu,price,cost,qty,unitUz,unitRu,descriptionUz,descriptionRu,image};
}
function parseProductExcel(buffer){
 const wb=XLSX.read(buffer,{type:'buffer',cellDates:false});
 const first=wb.SheetNames[0];if(!first)throw new Error('Excel ichida varaq topilmadi');
 const rows=XLSX.utils.sheet_to_json(wb.Sheets[first],{defval:'',raw:false}).slice(0,2000);
 return rows.map((r,i)=>normalizeImportRow(r,i+2)).filter(r=>r.nameUz||r.sku);
}
function importMatch(db,r){
 if(r.sku){const bySku=(db.products||[]).find(p=>String(p.sku||'').trim().toLowerCase()===r.sku.toLowerCase());if(bySku)return bySku;}
 if(r.nameUz){const key=r.nameUz.toLowerCase();return (db.products||[]).find(p=>String(p.name?.uz||'').trim().toLowerCase()===key)||null;}
 return null;
}
function ensureImportCategory(db,r){
 const key=String(r.catUz||'Boshqa').trim().toLowerCase();
 let c=(db.categories||[]).find(x=>String(x.name?.uz||'').trim().toLowerCase()===key);
 if(c)return c;
 const base=seoSlug(r.catUz||'boshqa').slice(0,32)||'boshqa';
 let id='excel_'+base,n=2;while((db.categories||[]).some(x=>String(x.id)===id))id='excel_'+base+'_'+n++;
 c={id,icon:'',name:{uz:r.catUz||'Boshqa',ru:r.catRu||r.catUz||'Другое'}};
 db.categories=db.categories||[];db.categories.push(c);return c;
}
function previewProductExcel(db,buffer){
 const rows=parseProductExcel(buffer);
 return rows.map(r=>{
  const errors=[];if(!r.nameUz)errors.push('Nomi UZ majburiy');if(r.price<0)errors.push('Narx noto‘g‘ri');if(r.qty<0)errors.push('Miqdor noto‘g‘ri');
  const match=importMatch(db,r);
  return {...r,mode:match?'update':'create',currentStock:match?Number(match.stock||0):0,productId:match?.id||null,errors};
 });
}
const excelRaw=express.raw({type:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/octet-stream'],limit:'20mb'});
app.get('/api/admin/products-import-template',requireAdmin,(req,res)=>{
 const wb=XLSX.utils.book_new();
 const sample=[
  EXCEL_IMPORT_HEADERS,
  ['M001','Suyuq sovun 500 ml','Жидкое мыло 500 мл','Gigiyena','Гигиена',18000,12000,25,'dona','шт','Yoqimli hidli suyuq sovun','Жидкое мыло с приятным ароматом',''],
  ['M002','Kir yuvish geli 1 L','Гель для стирки 1 л','Maishiy kimyo','Бытовая химия',32000,24500,15,'dona','шт','Kundalik kir yuvish uchun gel','Гель для ежедневной стирки','']
 ];
 const ws=XLSX.utils.aoa_to_sheet(sample);
 ws['!cols']=[{wch:16},{wch:28},{wch:28},{wch:20},{wch:20},{wch:18},{wch:18},{wch:16},{wch:14},{wch:14},{wch:34},{wch:34},{wch:42}];
 XLSX.utils.book_append_sheet(wb,ws,'Mahsulot importi');
 const info=XLSX.utils.aoa_to_sheet([
  ['ZARBULOQ.UZ — Excel import yo‘riqnomasi'],
  ['1','Har bir mahsulot alohida qator bo‘lsin.'],
  ['2','Nomi UZ majburiy. Mahsulot kodi (SKU) dublikatni aniqlash uchun tavsiya etiladi.'],
  ['3','Mavjud SKU yoki aynan bir xil Nomi UZ topilsa, mahsulot yangilanadi va Omborga miqdor joriy zaxiraga qo‘shiladi.'],
  ['4','Yangi mahsulot bo‘lsa kartochka avtomatik yaratiladi. Kategoriya bo‘lmasa avtomatik yaratiladi.'],
  ['5','Rasm URL ixtiyoriy.']
 ]);
 info['!cols']=[{wch:10},{wch:95}];XLSX.utils.book_append_sheet(wb,info,"Yo'riqnoma");
 const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
 res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 res.setHeader('Content-Disposition','attachment; filename="Zarbuloq_Mahsulot_Import_Shablon_UZ_RU.xlsx"');
 res.send(out);
});
app.post('/api/admin/products-import-preview',requireAdmin,requireRole('stock'),excelRaw,(req,res)=>{
 try{if(!Buffer.isBuffer(req.body)||req.body.length<100)return res.status(400).json({error:'Excel fayl topilmadi'});const rows=previewProductExcel(readDb(),req.body);res.json({ok:true,rows,count:rows.length,create:rows.filter(x=>x.mode==='create'&&!x.errors.length).length,update:rows.filter(x=>x.mode==='update'&&!x.errors.length).length,errors:rows.filter(x=>x.errors.length).length})}
 catch(e){console.error('Excel preview:',e);res.status(400).json({error:e.message||'Excel faylni o‘qib bo‘lmadi'})}
});
app.post('/api/admin/products-import-excel',requireAdmin,requireRole('stock'),excelRaw,async(req,res)=>{
 try{
  if(!Buffer.isBuffer(req.body)||req.body.length<100)return res.status(400).json({error:'Excel fayl topilmadi'});
  const db=readDb(),rows=previewProductExcel(db,req.body),now=new Date().toISOString(),result={created:0,updated:0,received:0,skipped:0,errors:[]};
  for(const r of rows){
   if(r.errors.length){result.skipped++;result.errors.push({row:r.rowNo,message:r.errors.join(', ')});continue}
   let p=importMatch(db,r),isNew=!p;
   const cat=ensureImportCategory(db,r);
   if(isNew){
    p={id:Date.now()+crypto.randomInt(10,999999),sku:r.sku||autoProductSku(db.products),cat:cat.id,emoji:'',name:{uz:r.nameUz,ru:r.nameRu||r.nameUz},description:{uz:r.descriptionUz,ru:r.descriptionRu||r.descriptionUz},seo:{title:{uz:'',ru:''},description:{uz:'',ru:''},keywords:''},unit:{uz:r.unitUz,ru:r.unitRu},price:r.price,cost:r.cost,oldPrice:0,stock:0,receivedQty:0,legacyOpeningQty:0,createdAt:now,updatedAt:now,lastReceivedAt:'',image:r.image,badge:'YANGI',featured:false};
    db.products.push(p);result.created++;
   }else{
    if(r.sku)p.sku=r.sku;else if(!String(p.sku||'').trim())p.sku=autoProductSku(db.products,p.id);p.cat=cat.id;p.name=p.name||{};p.name.uz=r.nameUz||p.name.uz;p.name.ru=r.nameRu||p.name.ru||p.name.uz;
    p.description=p.description||{};if(r.descriptionUz)p.description.uz=r.descriptionUz;if(r.descriptionRu)p.description.ru=r.descriptionRu;
    p.unit={uz:r.unitUz||p.unit?.uz||'dona',ru:r.unitRu||p.unit?.ru||'шт'};
    if(r.price>0)p.price=r.price;if(r.cost>0)p.cost=r.cost;if(r.image)p.image=r.image;p.updatedAt=now;result.updated++;
   }
   if(r.qty>0){
    p.stock=Math.max(0,Number(p.stock||0))+r.qty;p.lastReceivedAt=now;
    const receipt={receiptId:`XLS-${Date.now()}-${crypto.randomInt(100,999)}`,productId:p.id,qty:r.qty,createdAt:now,actor:req.adminUser,source:'excel'};
    db.inventoryReceipts=db.inventoryReceipts||[];db.inventoryReceipts.push(receipt);result.received+=r.qty;
   }
  }
  db.inventoryReceipts=(db.inventoryReceipts||[]).slice(-20000);
  audit(db,req.adminUser,'Excel orqali mahsulot importi',`Yangi: ${result.created}; yangilandi: ${result.updated}; omborga: ${result.received}`);
  await writeDb(db);broadcastAppRealtime('catalog');res.json({ok:true,...result,total:rows.length});
 }catch(e){console.error('Excel import:',e);res.status(400).json({error:e.message||'Excel importda xatolik'})}
});

function autoProductSku(products=[],excludeId=null){
 const local=new Date(Date.now()+5*60*60*1000),pad=n=>String(n).padStart(2,'0');
 const prefix=`IM-${pad(local.getUTCDate())}${pad(local.getUTCMonth()+1)}${local.getUTCFullYear()}`;
 const used=new Set((products||[]).filter(p=>excludeId===null||Number(p.id)!==Number(excludeId)).map(p=>String(p.sku||'').trim().toUpperCase()).filter(Boolean));
 let max=0;
 for(const sku of used){if(!sku.startsWith(prefix))continue;const tail=sku.slice(prefix.length);if(/^\d+$/.test(tail))max=Math.max(max,Number(tail)||0)}
 let n=max+1,c='';do{c=prefix+String(n++).padStart(2,'0')}while(used.has(c));return c;
}

function sanitizeCatalogProduct(raw,current=null){
 const p=raw||{},old=current||{},now=new Date().toISOString();
 const id=Number(p.id)||Number(old.id)||Date.now()+crypto.randomInt(10,999999);
 return {
  id,
  sku:clean(p.sku!==undefined?p.sku:old.sku,60),
  cat:clean(p.cat!==undefined?p.cat:old.cat,50),
  emoji:clean(p.emoji!==undefined?p.emoji:old.emoji,10)||'',
  name:{uz:clean(p.name?.uz!==undefined?p.name.uz:old.name?.uz,120),ru:clean(p.name?.ru!==undefined?p.name.ru:old.name?.ru,120)},
  description:{uz:clean(p.description?.uz!==undefined?p.description.uz:old.description?.uz,1200),ru:clean(p.description?.ru!==undefined?p.description.ru:old.description?.ru,1200)},
  seo:{title:{uz:clean(p.seo?.title?.uz!==undefined?p.seo.title.uz:old.seo?.title?.uz,180),ru:clean(p.seo?.title?.ru!==undefined?p.seo.title.ru:old.seo?.title?.ru,180)},description:{uz:clean(p.seo?.description?.uz!==undefined?p.seo.description.uz:old.seo?.description?.uz,400),ru:clean(p.seo?.description?.ru!==undefined?p.seo.description.ru:old.seo?.description?.ru,400)},keywords:clean(p.seo?.keywords!==undefined?p.seo.keywords:old.seo?.keywords,500)},
  unit:{uz:clean(p.unit?.uz!==undefined?p.unit.uz:old.unit?.uz,30)||'dona',ru:clean(p.unit?.ru!==undefined?p.unit.ru:old.unit?.ru,30)||'шт'},
  price:Math.max(0,Number(p.price!==undefined?p.price:old.price)||0),
  cost:Math.max(0,Number(p.cost!==undefined?p.cost:old.cost)||0),
  oldPrice:Math.max(0,Number(p.oldPrice!==undefined?p.oldPrice:old.oldPrice)||0),
  stock:Math.max(0,Number(p.stock!==undefined?p.stock:old.stock)||0),
  receivedQty:Math.max(0,Number(p.receivedQty!==undefined?p.receivedQty:old.receivedQty)||0),
  legacyOpeningQty:Math.max(0,Number(p.legacyOpeningQty!==undefined?p.legacyOpeningQty:old.legacyOpeningQty)||0),
  createdAt:clean(p.createdAt!==undefined?p.createdAt:old.createdAt,40)||now,
  updatedAt:now,
  lastReceivedAt:clean(p.lastReceivedAt!==undefined?p.lastReceivedAt:old.lastReceivedAt,40),
  image:(()=>{const incoming=String(p.image!==undefined?p.image:(old.image||''));return isAdminImageProxy(incoming,id)?String(old.image||''):incoming.slice(0,6_000_000)})(),
  badge:clean(p.badge!==undefined?p.badge:old.badge,30),
  featured:p.featured!==undefined?Boolean(p.featured):Boolean(old.featured)
 };
}

// V13.26.60 — catalog safe merge.
// Adminning eskirgan brauzer holati endi serverdagi yangi mahsulotlarni tasodifan o‘chirib yubormaydi.
// Mahsulot o‘chirish faqat DELETE /api/admin/products/:id orqali bajariladi.
app.put('/api/admin/catalog',requireAdmin,requireRole('stock'),async(req,res)=>{
 try{
  const db=readDb(),b=req.body||{};
  if(Array.isArray(b.products)){
   db.products=Array.isArray(db.products)?db.products:[];
   const pos=new Map(db.products.map((p,i)=>[String(Number(p.id)),i]));
   for(const raw of b.products.slice(0,700)){
    const requestedId=Number(raw?.id)||Date.now()+crypto.randomInt(10,999999);
    const key=String(requestedId),idx=pos.get(key),old=idx!==undefined?db.products[idx]:null;
    const resolvedSku=clean(raw?.sku,60)||clean(old?.sku,60)||autoProductSku(db.products,requestedId);
    const safe=sanitizeCatalogProduct({...raw,id:requestedId,sku:resolvedSku},old);
    if(idx!==undefined)db.products[idx]=safe;
    else{db.products.push(safe);pos.set(String(safe.id),db.products.length-1);}
   }
  }
  if(Array.isArray(b.categories))db.categories=b.categories.slice(0,100).map(c=>({...c,name:{uz:clean(c.name?.uz,120),ru:clean(c.name?.ru,120)}}));
  if(b.settings&&typeof b.settings==='object')db.settings={...(db.settings||{}),...b.settings};
  if(typeof b.logo==='string')db.logo=b.logo.slice(0,6_000_000);
  audit(db,req.adminUser,'Katalog/sozlamalar xavfsiz yangilandi',`products payload: ${Array.isArray(b.products)?b.products.length:'yo‘q'}`);
  await writeDb(db);broadcastAppRealtime('catalog');
  res.json({ok:true,productCount:(db.products||[]).length});
 }catch(e){console.error('Catalog safe merge:',e);res.status(400).json({error:e.message||'Katalogni saqlashda xatolik'})}
});

app.delete('/api/admin/products/:id',requireAdmin,requireRole('stock'),async(req,res)=>{try{const db=readDb(),id=Number(req.params.id),idx=(db.products||[]).findIndex(p=>Number(p.id)===id);if(idx<0)return res.status(404).json({error:'Mahsulot topilmadi'});const p=db.products[idx];db.products.splice(idx,1);audit(db,req.adminUser,'Mahsulot o‘chirildi',`${p.name?.uz||''} (#${id})`);await writeDb(db,{allowProductDeleteIds:[id]});broadcastAppRealtime('catalog');res.json({ok:true,id})}catch(e){res.status(400).json({error:e.message||'Mahsulotni o‘chirishda xatolik'})}});
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
  await writeDb(db);broadcastAppRealtime('catalog');res.json({ok:true,stock:p.stock,receipt});
 }catch(e){console.error('Inventory receive error:',e);res.status(500).json({error:'Omborga qabul qilishda xatolik'})}
});
app.patch('/api/admin/product-requests/:id',requireAdmin,async(req,res)=>{const db=readDb(),r=(db.productRequests||[]).find(x=>x.requestId===req.params.id);if(!r)return res.status(404).json({error:'So‘rov topilmadi'});const st=clean(req.body?.status,30);if(!['new','working','found','closed'].includes(st))return res.status(400).json({error:'Status noto‘g‘ri'});r.status=st;r.updatedAt=new Date().toISOString();audit(db,req.adminUser,'Mahsulot so‘rovi statusi',`${r.requestId}: ${st}`);await writeDb(db);res.json({ok:true});});
app.delete('/api/admin/product-requests/:id',requireAdmin,async(req,res)=>{const db=readDb(),id=String(req.params.id||''),before=(db.productRequests||[]).length;db.productRequests=(db.productRequests||[]).filter(x=>String(x.requestId)!==id);if(db.productRequests.length===before)return res.status(404).json({error:'So‘rov topilmadi'});audit(db,req.adminUser,'Mahsulot so‘rovi o‘chirildi',id);await writeDb(db);res.json({ok:true,deleted:id});});
app.put('/api/admin/app-config',requireAdmin,async(req,res)=>{const db=readDb(),b=req.body||{},prev={...defaultSettings.appControl,...(db.settings?.appControl||{})};const c={...prev};if(b.currentVersion!==undefined)c.currentVersion=clean(b.currentVersion,30)||prev.currentVersion;for(const k of ['latestVersionCode','minVersionCode'])if(b[k]!==undefined)c[k]=Math.max(1,Math.floor(Number(b[k])||1));for(const k of ['forceUpdate','maintenance','noticeEnabled','productRequestEnabled','liveChatEnabled','reviewsEnabled','trackingEnabled'])if(b[k]!==undefined)c[k]=Boolean(b[k]);for(const k of ['maintenanceMessage','updateTitle','updateMessage','noticeText'])if(b[k]!==undefined)c[k]=clean(b[k],700);for(const k of ['updateUrl','supportPhone','supportTelegram'])if(b[k]!==undefined)c[k]=clean(b[k],500);for(const k of ['homeHeroTitle','homeHeroBadge','homeHeroButton'])if(b[k]!==undefined)c[k]=clean(b[k],180);for(const k of ['homeNewsTitleUz','homeNewsTitleRu','homeSalesTitleUz','homeSalesTitleRu','homeAdsTitleUz','homeAdsTitleRu','homeProductsTitleUz','homeProductsTitleRu','homeSeeAllUz','homeSeeAllRu'])if(b[k]!==undefined)c[k]=clean(b[k],120);if(b.homeHeroImage!==undefined){const img=String(b.homeHeroImage||'');c.homeHeroImage=/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(img)&&img.length<=2200000?img:'';}if(Array.isArray(b.appBanners))c.appBanners=b.appBanners.slice(0,15).map((x,i)=>({id:clean(x?.id,80)||`app-banner-${Date.now()}-${i}`,title:clean(x?.title,160),description:clean(x?.description,240),kind:['reklama','aksiya','yangilik','boshqa'].includes(String(x?.kind))?String(x.kind):'reklama',link:clean(x?.link||x?.url,1000),active:x?.active!==false,image:(()=>{const img=String(x?.image||'');return /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(img)&&img.length<=1800000?img:''})()})).filter(x=>x.image);db.settings=db.settings||{};db.settings.appControl=c;audit(db,req.adminUser,'Ilova boshqaruvi yangilandi',`v${c.currentVersion} / code ${c.latestVersionCode}`);await writeDb(db);broadcastRealtime('app-control');broadcastAppRealtime('app-control');res.json({ok:true,app:c,revision:appRealtimeRevision});});
// Admin paneldan APK yuklash / almashtirish.
app.put('/api/admin/app-apk',requireAdmin,express.raw({type:['application/vnd.android.package-archive','application/octet-stream'],limit:'250mb'}),async(req,res)=>{
 try{
  if(!Buffer.isBuffer(req.body)||req.body.length<1024)return res.status(400).json({error:'APK fayl topilmadi yoki juda kichik'});
  const sig=req.body.subarray(0,2).toString('hex');
  if(sig!=='504b')return res.status(400).json({error:'Bu APK fayliga o‘xshamaydi'});
  const version=clean(req.headers['x-app-version'],30),versionCode=Math.max(0,Math.floor(Number(req.headers['x-app-version-code']||0)||0)),notes=clean(decodeURIComponent(String(req.headers['x-app-notes']||'')),1200);
  fs.mkdirSync(APK_DIR,{recursive:true});
  const tmp=APK_FILE+'.uploading';fs.writeFileSync(tmp,req.body);fs.renameSync(tmp,APK_FILE);
  const sha256=crypto.createHash('sha256').update(req.body).digest('hex');
  await persistApkBinary(req.body,sha256);
  const db=readDb();db.settings=db.settings||{};const c={...defaultSettings.appControl,...(db.settings.appControl||{})};
  c.apkAvailable=true;c.apkFileName='Zarbuloq.apk';c.apkVersion=version||c.currentVersion||'';c.apkVersionCode=versionCode||Number(c.latestVersionCode||0);c.apkNotes=notes;c.apkUpdatedAt=new Date().toISOString();c.apkSize=req.body.length;c.apkSha256=sha256;c.apkUrl='/downloads/Zarbuloq.apk';c.updateUrl='https://zarbuloq.uz/downloads/Zarbuloq.apk';if(version)c.currentVersion=version;if(versionCode>0)c.latestVersionCode=versionCode;
  if(version)c.currentVersion=version;if(versionCode)c.latestVersionCode=versionCode;
  db.settings.appControl=c;audit(db,req.adminUser,'Android APK yangilandi',`v${c.apkVersion||'-'} / ${req.body.length} bytes`);await writeDb(db);broadcastRealtime('app-apk');broadcastAppRealtime('app-apk');
  res.json({ok:true,app:c,revision:appRealtimeRevision,apk:{available:true,url:c.apkUrl,size:c.apkSize,sha256:c.apkSha256,updatedAt:c.apkUpdatedAt,version:c.apkVersion,versionCode:c.apkVersionCode}});
 }catch(e){console.error('APK upload:',e);res.status(500).json({error:'APK yuklab bo‘lmadi'})}
});
app.delete('/api/admin/app-apk',requireAdmin,async(req,res)=>{
 try{if(fs.existsSync(APK_FILE))fs.unlinkSync(APK_FILE);await deleteApkBinary();const db=readDb();db.settings=db.settings||{};const c={...defaultSettings.appControl,...(db.settings.appControl||{})};c.apkAvailable=false;c.apkSize=0;c.apkSha256='';c.apkUpdatedAt=new Date().toISOString();db.settings.appControl=c;audit(db,req.adminUser,'Android APK o‘chirildi');await writeDb(db);broadcastRealtime('app-apk');broadcastAppRealtime('app-apk-delete');res.json({ok:true,app:c,revision:appRealtimeRevision})}catch(e){res.status(500).json({error:'APKni o‘chirib bo‘lmadi'})}
});

app.post('/api/admin/app-notifications',requireAdmin,async(req,res)=>{
 try{
  const db=readDb(),b=req.body||{};
  const title={uz:clean(b.titleUz||b.title,160),ru:clean(b.titleRu,160)};
  const body={uz:clean(b.bodyUz||b.body,1200),ru:clean(b.bodyRu,1200)};
  if(!title.uz||!body.uz)return res.status(400).json({error:'Xabar sarlavhasi va matni majburiy'});
  if(!title.ru)title.ru=title.uz;if(!title.en)title.en=title.uz;if(!body.ru)body.ru=body.uz;if(!body.en)body.en=body.uz;
  const row={id:'NTF-'+Date.now()+'-'+crypto.randomInt(10,99),createdAt:new Date().toISOString(),title,body,kind:['info','sale','delivery','news'].includes(String(b.kind))?String(b.kind):'info',actionUrl:clean(b.actionUrl,500),important:Boolean(b.important),active:true,sentBy:req.adminUser};
  db.appNotifications=Array.isArray(db.appNotifications)?db.appNotifications:[];db.appNotifications.unshift(row);db.appNotifications=db.appNotifications.slice(0,500);
  audit(db,req.adminUser,'Ilovaga xabar yuborildi',`${row.id} • ${title.uz}`);await writeDb(db);res.status(201).json({ok:true,notification:row});
 }catch(e){console.error('App notification:',e);res.status(500).json({error:'Xabarni yuborib bo‘lmadi'})}
});
app.patch('/api/admin/app-notifications/:id',requireAdmin,async(req,res)=>{
 const db=readDb(),row=(db.appNotifications||[]).find(x=>String(x.id)===String(req.params.id));if(!row)return res.status(404).json({error:'Xabar topilmadi'});
 if(req.body?.active!==undefined)row.active=Boolean(req.body.active);audit(db,req.adminUser,'Ilova xabari holati',`${row.id}: ${row.active?'faol':'o‘chiq'}`);await writeDb(db);res.json({ok:true,notification:row});
});
app.delete('/api/admin/app-notifications/:id',requireAdmin,async(req,res)=>{
 const db=readDb(),i=(db.appNotifications||[]).findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({error:'Xabar topilmadi'});const [row]=db.appNotifications.splice(i,1);audit(db,req.adminUser,'Ilova xabari o‘chirildi',row.id);await writeDb(db);res.json({ok:true,deleted:row.id});
});
app.put('/api/admin/promos',requireAdmin,async(req,res)=>{const db=readDb();db.promos=Array.isArray(req.body?.promos)?req.body.promos.slice(0,200).map(p=>({code:clean(p.code,30).toUpperCase(),type:p.type==='fixed'?'fixed':'percent',value:Math.max(0,Number(p.value)||0),minTotal:Math.max(0,Number(p.minTotal)||0),active:Boolean(p.active),usageLimit:Math.max(0,Math.floor(Number(p.usageLimit)||0)),used:Math.max(0,Math.floor(Number(p.used)||0)),expires:clean(p.expires,20)})):db.promos;audit(db,req.adminUser,'Promo kodlar yangilandi');await writeDb(db);res.json({ok:true});});
app.put('/api/admin/product-promotions',requireAdmin,async(req,res)=>{
 try{
  const db=readDb(),rows=Array.isArray(req.body?.promotions)?req.body.promotions:[];
  db.productPromotions=rows.slice(0,300).map((x,i)=>{
   const product=(db.products||[]).find(p=>String(p.id)===String(x?.productId))||(db.products||[]).find(p=>String(p.sku||'').toUpperCase()===String(x?.sku||'').toUpperCase());
   if(!product)return null;
   return {id:clean(x?.id,80)||`SALE-${Date.now()}-${i}`,productId:Number(product.id),sku:clean(product.sku,60),productName:clean(product.name?.uz,160),type:x?.type==='fixed'?'fixed':'percent',value:Math.max(0,Number(x?.value)||0),starts:clean(x?.starts,20),expires:clean(x?.expires,20),active:x?.active!==false,label:clean(x?.label,80)||'AKSIYA',updatedAt:new Date().toISOString()};
  }).filter(Boolean);
  audit(db,req.adminUser,'Mahsulot aksiyalari yangilandi',`${db.productPromotions.length} ta aksiya`);
  await writeDb(db);broadcastRealtime('product-promotions');broadcastAppRealtime('product-promotions');
  res.json({ok:true,promotions:db.productPromotions});
 }catch(e){res.status(400).json({error:e.message||'Aksiyalarni saqlab bo‘lmadi'})}
});


app.get('/api/admin/finance',requireAdmin,(req,res)=>{
 const db=readDb(),period=clean(req.query.period,20)||'monthly',value=clean(req.query.value,20),year=clean(req.query.year,4)||String(new Date().getFullYear()),products=db.products||[];
 const sales=(db.orders||[]).filter(o=>['delivery','delivered','completed','done'].includes(o.status)&&finPeriodMatch(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt,{period,value})).slice().reverse().slice(0,1200).map(o=>({orderId:o.orderId,date:finDate(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt),status:o.status,customer:o.customer?.name||'',originalSubtotal:finNum(o.originalSubtotal||o.subtotal),productDiscount:finNum(o.productDiscount),promoCodeDiscount:finNum(o.discount),total:finNum(o.total),items:(o.items||[]).map(i=>{const p=products.find(x=>Number(x.id)===Number(i.id));const qty=finNum(i.qty),salePrice=finNum(i.price??p?.price),cost=finNum(p?.cost);return {id:Number(i.id),name:i.name||p?.name?.uz||'',qty,unit:p?.unit?.uz||'dona',salePrice,cost,amount:qty*salePrice,costAmount:qty*cost}})}));
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
 audit(db,req.adminUser,createdProduct?'Yangi mahsulot + finans prixod':'Finans prixod',`${company.name} • ${product.name?.uz||''} × ${qty} • ${money(total)} • sotuv ${money(appliedSalePrice)}`);await writeDb(db);broadcastAppRealtime('catalog');res.json({ok:true,purchase:x,createdProduct,productId:product.id,stock:product.stock,cost:product.cost,suggestedSalePrice:suggested,salePrice:appliedSalePrice});
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

app.get('/api/admin/visitors.xls',requireAdmin,(req,res)=>{const db=readDb(),rows=(db.visits||[]).slice().reverse(),esc=htmlEsc,body=rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(new Date(x.at).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'}))}</td><td>${esc(x.visitorId||'')}</td><td>${esc(x.device||'')}</td><td>${esc(x.page||'')}</td><td>${esc(x.lang||'')}</td><td>${esc(x.referrer||'')}</td></tr>`).join(''),st=visitorStats(db),html=`<html><head><meta charset="UTF-8"></head><body><h1>ZARBULOQ.UZ — TASHRIFLAR TARIXI</h1><p><b>Bugun:</b> ${st.today} • <b>Noyob:</b> ${st.todayUnique} • <b>7 kun:</b> ${st.last7} • <b>30 kun:</b> ${st.last30} • <b>Jami:</b> ${st.total}</p><table border="1"><tr><th>#</th><th>Sana / vaqt</th><th>Visitor ID</th><th>Qurilma</th><th>Sahifa</th><th>Til</th><th>Manba</th></tr>${body}</table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="ZARBULOQ_TASHRIFLAR_${new Date().toISOString().slice(0,10)}.xls"`);res.send('\ufeff'+html);});

app.get('/api/admin/finance/reconciliation.xls',requireAdmin,(req,res)=>{const db=readDb(),company=(db.financeCompanies||[]).find(c=>String(c.id)===String(req.query.companyId)),from=clean(req.query.from,10),to=clean(req.query.to,10),esc=htmlEsc;if(!company)return res.status(404).send('Firma topilmadi');const purchases=(db.financePurchases||[]).filter(x=>String(x.companyId)===String(company.id)).map(x=>({date:finDate(x.date||x.createdAt),kind:'Prixod',doc:x.invoice||x.id,debit:finNum(x.total),credit:0,note:(db.products||[]).find(p=>Number(p.id)===Number(x.productId))?.name?.uz||''}));const payments=(db.financeCompanyPayments||[]).filter(x=>String(x.companyId)===String(company.id)).map(x=>({date:finDate(x.date||x.createdAt),kind:'To‘lov',doc:x.id,debit:0,credit:finNum(x.amount),note:x.note||''}));const all=[...purchases,...payments].filter(x=>x.date).sort((a,b)=>a.date.localeCompare(b.date));const before=all.filter(x=>from&&x.date<from),opening=before.reduce((s,x)=>s+x.debit-x.credit,0);const rows=all.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to));let bal=opening;const body=rows.map((x,i)=>{bal+=x.debit-x.credit;return `<tr><td>${i+1}</td><td>${esc(x.date)}</td><td>${esc(x.kind)}</td><td>${esc(x.doc)}</td><td>${esc(x.note)}</td><td>${x.debit}</td><td>${x.credit}</td><td>${bal}</td></tr>`}).join('');const deb=rows.reduce((s,x)=>s+x.debit,0),cred=rows.reduce((s,x)=>s+x.credit,0),closing=opening+deb-cred;const html=`<html><head><meta charset="UTF-8"></head><body><h1>IMOM OTA BARAKA — AKT SVERKA</h1><p><b>Firma:</b> ${esc(company.name)} ${company.inn?`• INN: ${esc(company.inn)}`:''}</p><p><b>Davr:</b> ${esc(from||'boshlanishidan')} — ${esc(to||'bugungacha')}</p><table border="1"><tr><th>#</th><th>Sana</th><th>Operatsiya</th><th>Hujjat</th><th>Izoh</th><th>Prixod / Debet</th><th>To‘lov / Kredit</th><th>Qoldiq qarz</th></tr><tr><td colspan="7"><b>Davr boshiga qoldiq</b></td><td><b>${opening}</b></td></tr>${body}<tr><td colspan="5"><b>JAMI</b></td><td><b>${deb}</b></td><td><b>${cred}</b></td><td><b>${closing}</b></td></tr></table><br><p>Yetkazib beruvchi vakili: ____________________</p><p>IMOM OTA BARAKA vakili: ____________________</p></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="AKT_SVERKA_${String(company.name).replace(/[^a-zA-Z0-9_-]+/g,'_')}_${from||'all'}_${to||'today'}.xls"`);res.send('﻿'+html);});

app.get('/api/admin/finance-report.xls',requireAdmin,(req,res)=>{const db=readDb(),period=req.query.period==='yearly'?'yearly':'monthly',value=clean(req.query.value,10)||(period==='yearly'?String(new Date().getFullYear()):new Date().toISOString().slice(0,7)),esc=htmlEsc;const opts={period,value},sum=financeSummary(db,opts),bal=financeCurrentBalance(db),companies=financeCompanyBalances(db),series=period==='yearly'?financeSeries(db,value):[];const rows=period==='yearly'?series.map((m,i)=>`<tr><td>${i+1}</td><td>${esc(m.month)}</td><td>${m.revenue}</td><td>${m.cogs}</td><td>${m.grossProfit}</td><td>${m.payrollGross}</td><td>${m.otherExpenses}</td><td>${m.taxAccrued}</td><td>${m.netProfit}</td></tr>`).join(''):`<tr><td>${esc(value)}</td><td>${sum.revenue}</td><td>${sum.cogs}</td><td>${sum.grossProfit}</td><td>${sum.payrollGross}</td><td>${sum.otherExpenses}</td><td>${sum.taxAccrued}</td><td>${sum.netProfit}</td></tr>`;const html=`<html><head><meta charset="UTF-8"></head><body><h1>IMOM OTA BARAKA — ${period==='yearly'?'Yillik / Годовой':'Oylik / Месячный'} moliyaviy hisobot ${esc(value)}</h1><h2>Yagona moliyaviy natija</h2><table border="1"><tr><th>Davr</th><th>Sotuv aylanmasi</th><th>Sotilgan mahsulot tannarxi</th><th>Yalpi foyda</th><th>Oyliklar</th><th>Boshqa xarajatlar</th><th>Hisoblangan soliqlar</th><th>Sof natija</th></tr>${rows}</table><h2>Soliqlar</h2><table border="1"><tr><th>Aylanma solig‘i</th><th>Oylik solig‘i</th><th>Yer solig‘i</th><th>Mol-mulk solig‘i</th><th>Boshqa soliq</th><th>Jami hisoblangan</th><th>To‘langan</th><th>Qarz</th></tr><tr><td>${sum.turnoverTax}</td><td>${sum.payrollTax}</td><td>${sum.landTax}</td><td>${sum.propertyTax}</td><td>${sum.otherTax}</td><td>${sum.taxAccrued}</td><td>${sum.taxPaid}</td><td>${sum.taxDebt}</td></tr></table><h2>Firmalar va qarzdorlik</h2><table border="1"><tr><th>Firma</th><th>Olingan mahsulotlar</th><th>To‘langan</th><th>Qarz</th></tr>${companies.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.purchases}</td><td>${c.paid}</td><td>${c.debt}</td></tr>`).join('')}</table><h2>ERP PRO BALANS</h2><table border="1" cellspacing="0" cellpadding="5"><tr style="background:#dfeee8;font-weight:bold"><th colspan="2">AKTIVLAR</th><th colspan="2">PASSIVLAR</th></tr><tr><td>Kassa</td><td>${bal.cash}</td><td>Firmalarga qarz</td><td>${bal.supplierDebt}</td></tr><tr><td>Bank</td><td>${bal.bank}</td><td>Ish haqi qarzi</td><td>${bal.payrollDebt}</td></tr><tr><td>Ombordagi tovarlar</td><td>${bal.inventoryValue}</td><td>Soliq qarzi</td><td>${bal.taxDebt}</td></tr><tr><td>Debitor qarzdorlik</td><td>${bal.receivables||0}</td><td>Boshqa majburiyatlar</td><td>${bal.otherLiabilities||0}</td></tr><tr><td>Yetkazib beruvchilarga avans</td><td>${bal.supplierAdvances||0}</td><td><b>Jami majburiyatlar</b></td><td><b>${bal.liabilities}</b></td></tr><tr><td>Boshqa joriy aktivlar</td><td>${bal.otherCurrentAssets||0}</td><td>Kapital / Netto (avtomatik)</td><td>${bal.equity}</td></tr><tr style="font-weight:bold"><td>JAMI AKTIV</td><td>${bal.assets}</td><td>JAMI PASSIV</td><td>${bal.passiveTotal}</td></tr><tr><td colspan="3"><b>Balans holati</b></td><td><b>${bal.balanced?'TENG':'FARQ BOR'} (${bal.balanceDifference})</b></td></tr></table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="IMOM_OTA_BARAKA_FINANS_${period}_${value}.xls"`);res.send('\ufeff'+html);});

app.get('/api/admin/backup.json',requireAdmin,(req,res)=>{res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-backup-${new Date().toISOString().slice(0,10)}.json"`);res.json(readDb());});
app.post('/api/admin/restore',requireAdmin,async(req,res)=>{const b=req.body;if(!b||!Array.isArray(b.products)||!Array.isArray(b.orders))return res.status(400).json({error:'Backup formati noto‘g‘ri'});const db={...initialDb(),...b};audit(db,req.adminUser,'Backup tiklandi');await writeDb(db,{allowProductReplace:true});res.json({ok:true});});

app.get('/api/admin/reports.xls',requireAdmin,(req,res)=>{
 const db=readDb(),orders=db.orders||[],products=db.products||[];const period=String(req.query.period||'custom'),value=String(req.query.value||''),from=String(req.query.from||''),to=String(req.query.to||''),status=String(req.query.status||''),area=String(req.query.area||'');
 const filtered=orders.filter(o=>{const d=String(o.createdAt||'').slice(0,10);if(period==='daily'&&value&&d!==value)return false;if(period==='monthly'&&value&&d.slice(0,7)!==value)return false;if(period==='yearly'&&value&&d.slice(0,4)!==value)return false;if(from&&d<from)return false;if(to&&d>to)return false;if(status&&o.status!==status)return false;if(area&&o.customer?.area!==area)return false;return true;});
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const rows=filtered.map(o=>{const cost=(o.items||[]).reduce((s,i)=>s+Number(products.find(p=>Number(p.id)===Number(i.id))?.cost||0)*Number(i.qty||1),0);const profit=['completed','done'].includes(o.status)?Number(o.total||0)-cost:0;return `<tr><td>${esc(o.orderId)}</td><td>${esc(new Date(o.createdAt).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'}))}</td><td>${esc(o.customer?.name)}</td><td>${esc(o.customer?.phone)}</td><td>${esc(o.customer?.area)}</td><td>${esc(o.customer?.address)}</td><td>${esc(o.customer?.deliverySlot)}</td><td>${esc((o.items||[]).map(x=>`${x.name} × ${x.qty}`).join('; '))}</td><td>${Number(o.subtotal||0)}</td><td>${Number(o.discount||0)}</td><td>${Number(o.total||0)}</td><td>${cost}</td><td>${profit}</td><td>${esc(statusLabel(o.status))}</td></tr>`}).join('');
 const revenue=filtered.filter(o=>['completed','done'].includes(o.status)).reduce((s,o)=>s+Number(o.total||0),0);const html=`<html><head><meta charset="UTF-8"></head><body><h2>IMOM OTA BARAKA — Hisobot</h2><p>Buyurtmalar: ${filtered.length} | Yakunlangan tushum: ${revenue}</p><table border="1"><tr><th>Buyurtma</th><th>Sana</th><th>Mijoz</th><th>Telefon</th><th>Hudud</th><th>Manzil</th><th>Vaqt</th><th>Mahsulotlar</th><th>Subtotal</th><th>Chegirma</th><th>Jami</th><th>Tannarx</th><th>Foyda</th><th>Status</th></tr>${rows}</table></body></html>`;
 res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-report-${Date.now()}.xls"`);res.send('\ufeff'+html);
});

app.get('/api/admin/inventory-report.xls',requireAdmin,(req,res)=>{
 const db=readDb(),month=/^\d{4}-\d{2}$/.test(String(req.query.month||''))?String(req.query.month):new Date().toISOString().slice(0,7),start=month+'-01',end=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).toISOString().slice(0,10),orders=db.orders||[],receipts=Array.isArray(db.inventoryReceipts)?db.inventoryReceipts:[],purchases=Array.isArray(db.financePurchases)?db.financePurchases:[],companies=Array.isArray(db.financeCompanies)?db.financeCompanies:[];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const soldDate=o=>String(o.stockAdjustedAt||o.statusUpdatedAt||o.createdAt||'').slice(0,10);
 const soldQty=(pid,from,to)=>orders.filter(o=>['delivery','delivered','completed','done'].includes(o.status)&&(!from||soldDate(o)>=from)&&(!to||soldDate(o)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const applicationQty=(pid,from,to)=>orders.filter(o=>o.status==='new'&&(!from||String(o.createdAt||'').slice(0,10)>=from)&&(!to||String(o.createdAt||'').slice(0,10)<=to)).reduce((sum,o)=>sum+(o.items||[]).filter(i=>Number(i.id)===Number(pid)).reduce((a,i)=>a+Number(i.qty||0),0),0);
 const receiptEvents=p=>{const arr=[],seen=new Set();for(const r of receipts){if(Number(r.productId)!==Number(p.id))continue;const date=String(r.createdAt||'').slice(0,10),qty=Math.max(0,Number(r.qty)||0),key=String(r.receiptId||r.purchaseId||`${r.productId}|${r.createdAt}|${r.qty}|${r.source||''}`);if(seen.has(key))continue;seen.add(key);if(qty>0&&date)arr.push({qty,date,initial:false});}return arr;};
 const rows=(db.products||[]).map((p,rowIndex)=>{const events=receiptEvents(p),legacyOpening=Math.max(0,Number(p.legacyOpeningQty)||0),receivedBefore=events.filter(r=>r.date<start).reduce((a,r)=>a+r.qty,0),receivedMonth=events.filter(r=>r.date>=start&&r.date<=end).reduce((a,r)=>a+r.qty,0),soldBefore=soldQty(p.id,'',new Date(new Date(start+'T00:00:00').getTime()-86400000).toISOString().slice(0,10)),opening=Math.max(0,legacyOpening+receivedBefore-soldBefore),sold=soldQty(p.id,start,end),applications=applicationQty(p.id,start,end),closing=Math.max(0,opening+receivedMonth-sold),dates=[...new Set(events.filter(r=>r.date>=start&&r.date<=end).map(r=>r.date))].join(', ')||'—',pp=purchases.filter(x=>Number(x.productId)===Number(p.id)&&String(x.date||x.createdAt||'').slice(0,7)===month),firmas=[...new Set(pp.map(x=>{const c=companies.find(c=>String(c.id)===String(x.companyId));return c?`${c.name}${c.inn?' (INN '+c.inn+')':''}`:''}).filter(Boolean))].join('; ')||'—',docs=[...new Set(pp.map(x=>x.invoice).filter(Boolean))].join(', ')||'—';return `<tr><td>${rowIndex+1}</td><td>${esc(p.sku||'—')}</td><td>${esc(p.name?.uz)}</td><td>${esc(p.name?.ru)}</td><td>${esc(p.unit?.uz||'dona')}</td><td>${Number(p.cost||0)}</td><td>${Number(p.price||0)}</td><td>${opening}</td><td>${receivedMonth}</td><td>${esc(firmas)}</td><td>${esc(docs)}</td><td>${sold}</td><td>${applications}</td><td>${closing}</td><td>${Number(p.stock||0)}</td><td>${esc(dates)}</td></tr>`}).join('');
 const detail=purchases.filter(x=>String(x.date||x.createdAt||'').slice(0,7)===month).sort((a,b)=>String(a.date).localeCompare(String(b.date))).map((x,i)=>{const c=companies.find(c=>String(c.id)===String(x.companyId)),p=(db.products||[]).find(p=>Number(p.id)===Number(x.productId));return `<tr><td>${i+1}</td><td>${esc(x.date||'')}</td><td>${esc(c?.name||'—')}</td><td>${esc(c?.inn||'—')}</td><td>${esc(p?.sku||'—')}</td><td>${esc(p?.name?.uz||x.productName||'')}</td><td>${Number(x.qty||0)}</td><td>${Number(x.unitCost||0)}</td><td>${Number(x.salePrice||0)}</td><td>${Number(x.total||0)}</td><td>${esc(x.invoice||'—')}</td></tr>`}).join('');
 const html=`<html><head><meta charset="UTF-8"></head><body><h2>IMOM OTA BARAKA — Ombor hisoboti ${esc(month)}</h2><table border="1"><tr><th>№</th><th>SKU</th><th>Mahsulot nomi</th><th>Название товара</th><th>Birlik</th><th>Tannarxi</th><th>Sotuv narxi</th><th>Oy boshiga ostatka</th><th>Qabul qilingan</th><th>Yetkazib beruvchi firma / INN</th><th>Nakladnoy / hujjat №</th><th>Sotilgan (Yetkazilmoqda + Yetkazildi + Yakunlandi)</th><th>Zayavka (Yangi)</th><th>Oy oxiriga qoldiq</th><th>Joriy qoldiq</th><th>Qabul sanasi</th></tr>${rows}</table><br><h3>${esc(month)} — Firma bo‘yicha prixod tafsilotlari</h3><table border="1"><tr><th>#</th><th>Sana</th><th>Firma</th><th>INN</th><th>SKU</th><th>Mahsulot</th><th>Miqdor</th><th>Xarid narxi</th><th>Sotuv narxi</th><th>Jami</th><th>Hujjat №</th></tr>${detail||'<tr><td colspan="11">Bu oy firma prixodi yo‘q</td></tr>'}</table></body></html>`;res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zarbuloq-ombor-${month}.xls"`);res.send('\ufeff'+html);
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

app.get('/api/geo/geocode',async(req,res)=>{
 const q=clean(req.query.q,240);
 if(q.length<3)return res.status(400).json({error:'Manzilni kiriting'});
 try{
  const query=/parkent/i.test(q)?q:`${q}, Parkent tumani, Toshkent viloyati, Uzbekistan`;
  const u='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=uz&addressdetails=1&q='+encodeURIComponent(query);
  const r=await fetch(u,{headers:{'User-Agent':'Zarbuloq/13.26.44 (zarbuloq.uz)','Accept':'application/json','Accept-Language':'uz,ru;q=0.8,en;q=0.6'}});
  if(!r.ok)throw new Error('Geocoding failed');
  const rows=await r.json();
  for(const x of (Array.isArray(rows)?rows:[])){
   const lat=Number(x.lat),lng=Number(x.lon);if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;
   if(await checkParkentLocation(lat,lng))return res.json({ok:true,inside:true,lat,lng,displayName:clean(x.display_name,300),source:'nominatim'});
  }
  const first=Array.isArray(rows)&&rows[0]?rows[0]:null;
  if(first){const lat=Number(first.lat),lng=Number(first.lon);return res.json({ok:true,inside:false,lat,lng,displayName:clean(first.display_name,300),source:'nominatim'});}
  return res.status(404).json({error:'Manzil topilmadi'});
 }catch(e){console.error('Geocode:',e.message||e);res.status(503).json({error:'Manzilni xaritada aniqlab bo‘lmadi'})}
});

function publicOrderView(order){
 if(!order)return null;
 return {
  orderId:order.orderId,
  createdAt:order.createdAt,
  status:normalizeOrderStatus(order.status),
  statusLabel:statusLabel(order.status),
  statusUpdatedAt:order.statusUpdatedAt||order.createdAt,
  statusHistory:Array.isArray(order.statusHistory)?order.statusHistory:[],
  items:Array.isArray(order.items)?order.items.map(x=>({id:x.id,name:x.name,price:Number(x.price||0),qty:Number(x.qty||1)})):[],
  subtotal:Number(order.subtotal||0),
  discount:Number(order.discount||0),
  deliveryFee:Number(order.deliveryFee||0),
  total:Number(order.total||0),
  payment:order.customer?.payment||order.payment||'Naqd',
  customerConfirmed:Boolean(order.customerConfirmed),
  customerConfirmedAt:order.customerConfirmedAt||'',
  adminConfirmed:Boolean(order.adminConfirmed),
  adminConfirmedAt:order.adminConfirmedAt||'',
  completionSource:order.completionSource||(order.customerConfirmed?'customer':order.adminConfirmed?'admin':''),
  completedBy:order.completedBy||'',
  complaintOpen:Boolean(order.complaintOpen)
 };
}
function findOrderById(orderId){
 const id=clean(orderId,100);
 return (readDb().orders||[]).find(o=>String(o.orderId)===String(id))||null;
}
function sendPublicOrder(req,res,orderId){
 const o=findOrderById(orderId);
 if(!o)return res.status(404).json({error:'Buyurtma topilmadi'});
 res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
 res.setHeader('Pragma','no-cache');
 return res.json({ok:true,order:publicOrderView(o)});
}
app.get('/api/orders/status',(req,res)=>sendPublicOrder(req,res,req.query.orderId));
app.get('/api/orders/:orderId',(req,res)=>sendPublicOrder(req,res,req.params.orderId));
app.get('/api/order/:orderId',(req,res)=>sendPublicOrder(req,res,req.params.orderId));
app.get('/api/order-status/:orderId',(req,res)=>sendPublicOrder(req,res,req.params.orderId));
app.get('/api/orders-realtime/health',(req,res)=>res.json({ok:true,module:'zarbuloq-integrated-realtime-order-status',version:'13.26.39',storage:pool?'postgresql':'local-json'}));


// V13.26.45 — Telegram orqali telefon raqamini tasdiqlash.
// SMS provayder kerak emas: foydalanuvchi botdagi Telegram "contact sharing" tugmasi orqali
// o‘z akkauntiga bog‘langan telefon raqamini yuboradi.
let telegramBotUsernameCache='';
function normalizeVerifiedPhone(v){
 let d=String(v??'').replace(/\D/g,'');
 if(d.length===9)d='998'+d;
 if(d.length===12&&d.startsWith('998'))return d;
 return '';
}
function phoneVerifyTokenHash(token){
 return crypto.createHash('sha256').update(String(token||'')).digest('hex');
}
function trimPhoneVerifications(db){
 const now=Date.now(),rows=Array.isArray(db.phoneVerifications)?db.phoneVerifications:[];
 db.phoneVerifications=rows.filter(x=>{
  const exp=new Date(x.expiresAt||0).getTime();
  // verified records are retained until their long-lived credential expires;
  // stale pending records are removed after one day.
  if(x.status==='verified')return exp>now;
  return exp>now-24*60*60*1000;
 }).slice(-5000);
 return db.phoneVerifications;
}
async function telegramBotUsername(){
 if(telegramBotUsernameCache)return telegramBotUsernameCache;
 const fromEnv=clean(process.env.TELEGRAM_BOT_USERNAME,120).replace(/^@/,'');
 if(fromEnv){telegramBotUsernameCache=fromEnv;return fromEnv;}
 const me=await tgCall('getMe',{});
 telegramBotUsernameCache=clean(me?.username,120).replace(/^@/,'');
 return telegramBotUsernameCache;
}
function findPhoneVerification(db,rawToken,deviceId=''){
 const hash=phoneVerifyTokenHash(rawToken);
 const rows=trimPhoneVerifications(db);
 return rows.find(x=>x.tokenHash===hash && (!deviceId || String(x.deviceId)===String(deviceId)))||null;
}
app.post('/api/phone-verification/start',async(req,res)=>{
 try{
  if(!BOT_TOKEN)return res.status(503).json({error:'Telegram bot hozircha sozlanmagan'});
  const phone=normalizeVerifiedPhone(req.body?.phone),deviceId=clean(req.body?.deviceId,120);
  if(!/^998\d{9}$/.test(phone))return res.status(400).json({error:'+998 telefon raqamini to‘g‘ri kiriting'});
  if(!deviceId)return res.status(400).json({error:'Qurilma identifikatori topilmadi'});
  const rawToken=crypto.randomBytes(24).toString('hex'),tokenHash=phoneVerifyTokenHash(rawToken);
  const now=new Date(),expiresAt=new Date(now.getTime()+10*60*1000).toISOString();
  const db=readDb();trimPhoneVerifications(db);
  // One active pending verification per device/phone is enough.
  db.phoneVerifications=(db.phoneVerifications||[]).filter(x=>!(x.status!=='verified'&&x.deviceId===deviceId&&x.phone===phone));
  db.phoneVerifications.push({
   id:`PV-${Date.now()}-${crypto.randomInt(100,999)}`,
   tokenHash,phone,deviceId,status:'pending',
   telegramChatId:'',telegramUserId:'',createdAt:now.toISOString(),expiresAt,verifiedAt:''
  });
  await writeDb(db);
  const username=await telegramBotUsername();
  if(!username)return res.status(503).json({error:'Telegram bot username topilmadi'});
  res.json({ok:true,token:rawToken,telegramUrl:`https://t.me/${username}?start=verify_${rawToken}`,expiresAt,phone:'+998'+phone.slice(3)});
 }catch(e){
  console.error('Phone verification start:',e);
  res.status(500).json({error:'Telegram tasdiqlashni boshlab bo‘lmadi'});
 }
});
app.get('/api/phone-verification/status',(req,res)=>{
 try{
  const token=clean(req.query.token,120),deviceId=clean(req.query.deviceId,120);
  if(!token||!deviceId)return res.status(400).json({error:'Tasdiqlash ma’lumoti yetarli emas'});
  const db=readDb(),row=findPhoneVerification(db,token,deviceId);
  if(!row)return res.status(404).json({error:'Tasdiqlash topilmadi'});
  const expired=new Date(row.expiresAt||0).getTime()<=Date.now();
  if(expired)return res.json({ok:true,status:'expired',verified:false});
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,status:row.status||'pending',verified:row.status==='verified',verifiedAt:row.verifiedAt||'',phone:row.phone?'+998'+row.phone.slice(3):''});
 }catch(e){res.status(500).json({error:'Tasdiqlash holatini tekshirib bo‘lmadi'})}
});
function validAppPhoneVerification(db,token,deviceId,phone){
 const row=findPhoneVerification(db,token,deviceId);
 if(!row)return null;
 if(row.status!=='verified')return null;
 if(new Date(row.expiresAt||0).getTime()<=Date.now())return null;
 if(normalizeVerifiedPhone(phone)!==row.phone)return null;
 return row;
}

app.post('/api/orders',publicWriteLimiter,async(req,res)=>{
 const db=readDb(),b=req.body||{},customer=b.customer||{},items=Array.isArray(b.items)?b.items:[];
 if(!clean(customer.name,80)||!clean(customer.phone,30)||!clean(customer.address,300)||!clean(customer.area,100)||!clean(customer.payment,80)||!items.length)return res.status(400).json({error:'Majburiy maydonlarni to‘ldiring'});
 if(!(db.settings?.delivery?.areas||[]).includes(customer.area))return res.status(400).json({error:'Yetkazib berish hududini tanlang'});
 const hasLocation=customer.lat!==undefined&&customer.lat!==null&&String(customer.lat).trim()!==''&&customer.lng!==undefined&&customer.lng!==null&&String(customer.lng).trim()!=='';
 if(!hasLocation)return res.status(400).json({error:'Tasdiqlangan lokatsiya majburiy. GPS yoki qo‘lda manzil kiriting'});
 const lat=Number(customer.lat),lng=Number(customer.lng),accuracy=Number(customer.accuracy),locationMethod=clean(customer.locationMethod,20)||'gps';
 if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Lokatsiya koordinatasi noto‘g‘ri'});
 if(locationMethod!=='manual'&&(!Number.isFinite(accuracy)||accuracy>20))return res.status(400).json({error:`GPS aniqligi yetarli emas${Number.isFinite(accuracy)?`: ±${Math.round(accuracy)} m`:''}. ±20 m yoki yaxshiroq aniqlik talab qilinadi`});
 if(!(await checkParkentLocation(lat,lng)))return res.status(400).json({error:'Yuborilgan lokatsiya Parkent tumani hududidan tashqarida'});
 const finalItems=[];let subtotal=0,originalSubtotal=0,productDiscount=0;
 for(const i of items){const p=(db.products||[]).find(x=>Number(x.id)===Number(i.id));if(!p)continue;const qty=Math.max(1,Math.floor(Number(i.qty)||1));if(qty>Number(p.stock||0))return res.status(400).json({error:`${p.name?.uz||'Mahsulot'} omborda yetarli emas`});const sale=productSaleInfo(db,p),lineDiscount=sale.discount*qty;finalItems.push({id:p.id,name:p.name?.[b.language]||p.name?.uz||'',price:sale.price,basePrice:sale.basePrice,promotionDiscount:lineDiscount,promotionId:sale.promotion?.id||'',qty});subtotal+=sale.price*qty;originalSubtotal+=sale.basePrice*qty;productDiscount+=lineDiscount;}
 if(!finalItems.length)return res.status(400).json({error:'Mahsulot topilmadi'});
 if(subtotal<100000)return res.status(400).json({error:`Minimal buyurtma 100 000 so‘m. Yana ${money(100000-subtotal)}lik mahsulot qo‘shing`});
 const promoResult=validatePromo(db,b.promoCode,subtotal);if(!promoResult.ok)return res.status(400).json({error:promoResult.error});const discount=promoResult.discount,total=subtotal-discount;
 const orderId=`IOB-${String(Date.now()).slice(-8)}-${String(Math.floor(Math.random()*90)+10)}`,createdAt=new Date().toISOString();
 const orderSource=['app','android','mobile'].includes(String(b.source||'').toLowerCase())?'app':'web';
 const verificationToken=clean(b.phoneVerificationToken,120),verificationRow=orderSource==='app'?validAppPhoneVerification(db,verificationToken,clean(b.deviceId,120),customer.phone):null;
 if(orderSource==='app'&&!verificationRow)return res.status(403).json({error:'Telefon raqamingizni Telegram orqali tasdiqlang'});
 const order={orderId,createdAt,source:orderSource,status:'new',statusUpdatedAt:createdAt,statusHistory:[{status:'new',at:createdAt,source:'customer'}],customer:{name:clean(customer.name,80),phone:clean(customer.phone,30),phoneVerified:orderSource==='app',address:clean(customer.address,300),area:clean(customer.area,100),deliverySlot:'1 kun ichida',payment:clean(customer.payment,80),comment:clean(customer.comment,500),lat:Number(customer.lat),lng:Number(customer.lng),accuracy:Number(customer.accuracy),locationMethod:clean(customer.locationMethod,20)||'gps'},items:finalItems,originalSubtotal,productDiscount,subtotal,discount,total,promoCode:promoResult.promo?.code||'',language:clean(b.language,5)||'uz',telegram:null,stockAdjusted:false,customerConfirmed:false,adminConfirmed:false,completionSource:'',completedBy:'',customerDeviceId:clean(b.deviceId,120),complaintOpen:false};
 if(promoResult.promo)promoResult.promo.used=Number(promoResult.promo.used||0)+1;
 db.orders=db.orders||[];db.orders.push(order);db.receiptHistory=db.receiptHistory||[];db.receiptHistory.push({orderId:order.orderId,createdAt:order.createdAt,status:order.status,customer:order.customer,items:order.items,originalSubtotal:order.originalSubtotal,productDiscount:order.productDiscount,subtotal:order.subtotal,discount:order.discount,deliveryFee:Number(order.deliveryFee||0),total:order.total,payment:order.customer?.payment||'Naqd',source:order.source||'web'});audit(db,'customer','Yangi buyurtma',`${orderId} • ${money(total)}`);await writeDb(db);
 if(BOT_TOKEN&&CHAT_ID){try{const msg=await tgCall('sendMessage',{chat_id:CHAT_ID,text:orderText(order),reply_markup:statusKeyboard(orderId,'new')});const db2=readDb(),o=db2.orders.find(x=>x.orderId===orderId);if(o){o.telegram={chatId:String(msg.chat.id),messageId:msg.message_id};await writeDb(db2);}}catch(e){console.error('Telegram send error:',e.message);return res.json({ok:true,orderId,total,discount,order,warning:'Buyurtma saqlandi, lekin Telegramga yuborilmadi'});}}
 res.json({ok:true,orderId,total,discount,order});
});

async function updateOrderStatus(orderId,status,actor='admin'){
 status=normalizeOrderStatus(status);
 const allowed=['new','accepted','preparing','delivery','delivered','completed','cancelled'];
 if(!allowed.includes(status))throw new Error('Invalid status');
 const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===orderId);
 if(!o)throw new Error('Order not found');
 const prev=normalizeOrderStatus(o.status),soldStatuses=['delivery','delivered','completed'],wasSold=soldStatuses.includes(prev)&&o.stockAdjusted===true,willSold=soldStatuses.includes(status);
 if(willSold&&!wasSold){
  for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p){if(Number(p.stock||0)<Number(it.qty||0))throw new Error(`${p.name?.uz||'Mahsulot'} omborda yetarli emas`);p.stock=Math.max(0,Number(p.stock||0)-Number(it.qty||0));}}
  o.stockAdjusted=true;o.stockAdjustedAt=new Date().toISOString();
 }else if(!willSold&&wasSold){
  for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p)p.stock=Number(p.stock||0)+Number(it.qty||0)}
  o.stockAdjusted=false;o.stockAdjustedAt='';
 }
 o.status=status;o.statusUpdatedAt=new Date().toISOString();pushOrderHistory(o,status,actor);
 if(status==='completed'){const isCustomer=String(actor||'').toLowerCase()==='customer';o.completionSource=isCustomer?'customer':'admin';o.completedBy=clean(actor,80)||'admin';if(isCustomer){o.customerConfirmed=true;o.customerConfirmedAt=o.customerConfirmedAt||o.statusUpdatedAt;o.adminConfirmed=false;o.adminConfirmedAt='';}else{o.adminConfirmed=true;o.adminConfirmedAt=o.adminConfirmedAt||o.statusUpdatedAt;}}
 audit(db,actor,'Buyurtma statusi',`${orderId}: ${prev} → ${status}`);await writeDb(db);if(willSold||wasSold)broadcastAppRealtime('catalog');
 if(BOT_TOKEN&&o.telegram?.chatId&&o.telegram?.messageId){
  try{await tgCall('editMessageText',{chat_id:o.telegram.chatId,message_id:o.telegram.messageId,text:orderText(o),reply_markup:statusKeyboard(o.orderId,status)});}
  catch(e){console.error('Telegram edit error:',e.message)}
 }
 return o;
}
app.patch('/api/admin/orders/:id/status',requireAdmin,requireRole('operator'),async(req,res)=>{try{const o=await updateOrderStatus(req.params.id,String(req.body?.status||''),req.adminUser);res.json({ok:true,order:o});}catch(e){res.status(400).json({error:e.message})}});

app.post('/api/orders/:orderId/confirm-delivery',async(req,res)=>{
 try{
  const id=clean(req.params.orderId,100),current=findOrderById(id);
  if(!current)return res.status(404).json({error:'Buyurtma topilmadi'});
  const st=normalizeOrderStatus(current.status);
  if(!['delivered','completed'].includes(st))return res.status(409).json({error:'Buyurtma hali “Yetkazildi” holatiga kelmagan'});
  const o=st==='completed'?current:await updateOrderStatus(id,'completed','customer');
  const db=readDb(),fresh=(db.orders||[]).find(x=>String(x.orderId)===String(id));
  if(fresh){
   fresh.customerConfirmed=true;
   fresh.customerConfirmedAt=fresh.customerConfirmedAt||new Date().toISOString();
   fresh.completionSource='customer';fresh.completedBy='customer';fresh.adminConfirmed=false;fresh.adminConfirmedAt='';
   fresh.customerDeviceId=clean(req.body?.deviceId,120)||fresh.customerDeviceId||'';
   fresh.complaintOpen=false;
   await writeDb(db);
  }
  if(BOT_TOKEN&&CHAT_ID){
   try{await tgCall('sendMessage',{chat_id:CHAT_ID,text:`✅ MIJOZ BUYURTMANI TASDIQLADI\n\n📦 #${id}\n🕐 ${new Date().toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})}`});}catch(e){console.error('Customer confirm Telegram:',e.message)}
  }
  res.json({ok:true,status:'completed',customerConfirmed:true,order:publicOrderView(fresh||o)});
 }catch(e){console.error('Confirm delivery:',e);res.status(500).json({error:'Tasdiqlashda server xatosi'})}
});
app.post('/api/orders/:orderId/complete',async(req,res)=>{
 try{
  const id=clean(req.params.orderId,100),current=findOrderById(id);
  if(!current)return res.status(404).json({error:'Buyurtma topilmadi'});
  const st=normalizeOrderStatus(current.status);
  if(!['delivered','completed'].includes(st))return res.status(409).json({error:'Buyurtma hali “Yetkazildi” holatiga kelmagan'});
  const o=st==='completed'?current:await updateOrderStatus(id,'completed','customer');
  const db=readDb(),fresh=(db.orders||[]).find(x=>String(x.orderId)===String(id));
  if(fresh){fresh.customerConfirmed=true;fresh.customerConfirmedAt=fresh.customerConfirmedAt||new Date().toISOString();fresh.completionSource='customer';fresh.completedBy='customer';fresh.adminConfirmed=false;fresh.adminConfirmedAt='';fresh.customerDeviceId=clean(req.body?.deviceId,120)||fresh.customerDeviceId||'';fresh.complaintOpen=false;await writeDb(db);}
  res.json({ok:true,status:'completed',customerConfirmed:true,order:publicOrderView(fresh||o)});
 }catch(e){console.error('Complete order:',e);res.status(500).json({error:'Tasdiqlashda server xatosi'})}
});
app.post('/api/orders/:orderId/complaints',async(req,res)=>{
 try{
  const id=clean(req.params.orderId,100),db=readDb(),o=(db.orders||[]).find(x=>String(x.orderId)===String(id));
  if(!o)return res.status(404).json({error:'Buyurtma topilmadi'});
  const message=clean(req.body?.message||req.body?.comment,500);
  if(message.length<3)return res.status(400).json({error:'Kamchilikni yozing'});
  const photo=String(req.body?.photo||'');
  if(photo&&(!photo.startsWith('data:image/')||photo.length>1_800_000))return res.status(400).json({error:'Rasm hajmi yoki formati noto‘g‘ri'});
  const row={complaintId:`CMP-${Date.now()}-${crypto.randomInt(10,99)}`,orderId:id,name:clean(req.body?.name,80),phone:clean(req.body?.phone,30),message,photo:photo.slice(0,1_800_000),deviceId:clean(req.body?.deviceId,120),createdAt:new Date().toISOString(),status:'open'};
  db.orderComplaints=Array.isArray(db.orderComplaints)?db.orderComplaints:[];
  db.orderComplaints.unshift(row);db.orderComplaints=db.orderComplaints.slice(0,1000);
  o.complaint=row;o.complaintOpen=true;o.complaintUpdatedAt=row.createdAt;
  audit(db,'customer','Buyurtma kamchiligi',`${id}: ${message.slice(0,120)}`);await writeDb(db);
  if(BOT_TOKEN&&CHAT_ID){
   try{await tgCall('sendMessage',{chat_id:CHAT_ID,text:`⚠️ BUYURTMA BO‘YICHA KAMCHILIK\n\n📦 #${id}\n👤 ${row.name||'—'}\n📞 ${row.phone||'—'}\n💬 ${message}\n📷 Rasm: ${row.photo?'biriktirilgan — admin panelda ko‘ring':'yo‘q'}`});}catch(e){console.error('Complaint Telegram:',e.message)}
  }
  res.status(201).json({ok:true,complaint:{...row,photo:row.photo?'attached':''}});
 }catch(e){console.error('Complaint:',e);res.status(500).json({error:'Kamchilikni yuborib bo‘lmadi'})}
});
app.get('/api/admin/order-complaints',requireAdmin,(req,res)=>{const db=readDb();res.json({ok:true,complaints:(db.orderComplaints||[]).slice(0,1000)})});
app.patch('/api/admin/order-complaints/:id',requireAdmin,async(req,res)=>{
 const db=readDb(),c=(db.orderComplaints||[]).find(x=>String(x.complaintId)===String(req.params.id));
 if(!c)return res.status(404).json({error:'Kamchilik topilmadi'});
 const st=clean(req.body?.status,30);if(!['open','working','resolved','closed'].includes(st))return res.status(400).json({error:'Status noto‘g‘ri'});
 c.status=st;c.updatedAt=new Date().toISOString();const o=(db.orders||[]).find(x=>String(x.orderId)===String(c.orderId));if(o&&['resolved','closed'].includes(st))o.complaintOpen=false;
 audit(db,req.adminUser,'Kamchilik statusi',`${c.complaintId}: ${st}`);await writeDb(db);res.json({ok:true,complaint:c});
});

app.delete('/api/admin/orders/:id',requireAdmin,requireRole('operator'),async(req,res)=>{try{const db=readDb(),idx=(db.orders||[]).findIndex(x=>String(x.orderId)===String(req.params.id));if(idx<0)return res.status(404).json({error:'Buyurtma topilmadi'});const o=db.orders[idx];if(o.stockAdjusted===true&&['delivery','delivered','completed','done'].includes(o.status)){for(const it of o.items||[]){const p=(db.products||[]).find(x=>Number(x.id)===Number(it.id));if(p)p.stock=Number(p.stock||0)+Number(it.qty||0);}}db.orders.splice(idx,1);audit(db,req.adminUser,'Buyurtma o‘chirildi',String(o.orderId));await writeDb(db);res.json({ok:true,deleted:o.orderId})}catch(e){res.status(400).json({error:e.message})}});



// V13.26.27 — Telegram webhook mode.
// Polling (getUpdates) caused 409 Conflict during Render rolling deploys / duplicate bot instances.
// A webhook gives Telegram one canonical HTTPS endpoint and removes long-polling conflicts.

async function handleTelegramVerificationMessage(msg){
 if(!msg||!msg.chat)return;
 const chatId=String(msg.chat.id),userId=String(msg.from?.id||'');
 const text=String(msg.text||'').trim();

 if(text.startsWith('/start')){
  const m=text.match(/verify_([a-f0-9]{48})/i);
  if(!m){
   await tgCall('sendMessage',{chat_id:chatId,text:'ZARBULOQ.UZ botiga xush kelibsiz.'}).catch(()=>{});
   return;
  }
  const rawToken=m[1],db=readDb(),row=findPhoneVerification(db,rawToken);
  if(!row || row.status==='verified' || new Date(row.expiresAt||0).getTime()<=Date.now()){
   await tgCall('sendMessage',{chat_id:chatId,text:'❌ Tasdiqlash havolasi eskirgan. ZARBULOQ ilovasidan qayta boshlang.',reply_markup:{remove_keyboard:true}}).catch(()=>{});
   return;
  }
  row.telegramChatId=chatId;row.telegramUserId=userId;row.startedAtTelegram=new Date().toISOString();
  await writeDb(db);
  await tgCall('sendMessage',{
   chat_id:chatId,
   text:'📱 ZARBULOQ.UZ\n\nTelefon raqamingizni tasdiqlash uchun pastdagi “Telefon raqamimni yuborish” tugmasini bosing.\n\nTelegram sizning akkauntingizga bog‘langan raqamni Zarbuloq botiga yuboradi.',
   reply_markup:{keyboard:[[{text:'📱 Telefon raqamimni yuborish',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true,input_field_placeholder:'Telefon raqamingizni yuboring'}
  });
  return;
 }

 if(msg.contact){
  const db=readDb();trimPhoneVerifications(db);
  const rows=(db.phoneVerifications||[]).filter(x=>x.status==='pending'&&String(x.telegramChatId)===chatId&&new Date(x.expiresAt||0).getTime()>Date.now()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  const row=rows[0];
  if(!row){
   await tgCall('sendMessage',{chat_id:chatId,text:'Tasdiqlash so‘rovi topilmadi. ZARBULOQ ilovasidan qayta boshlang.',reply_markup:{remove_keyboard:true}}).catch(()=>{});
   return;
  }
  if(msg.contact.user_id && userId && String(msg.contact.user_id)!==userId){
   await tgCall('sendMessage',{chat_id:chatId,text:'❌ Faqat o‘zingizning Telegram raqamingizni yuboring.',reply_markup:{remove_keyboard:true}}).catch(()=>{});
   return;
  }
  const contactPhone=normalizeVerifiedPhone(msg.contact.phone_number);
  if(!contactPhone || contactPhone!==row.phone){
   await tgCall('sendMessage',{
    chat_id:chatId,
    text:`❌ Telegram raqami ilovada kiritilgan raqam bilan mos kelmadi.\n\nIlovaga qaytib telefon raqamingizni to‘g‘rilang va qayta tasdiqlang.`,
    reply_markup:{remove_keyboard:true}
   }).catch(()=>{});
   return;
  }
  row.status='verified';row.verifiedAt=new Date().toISOString();
  // Once verified, keep the device credential valid for 180 days.
  row.expiresAt=new Date(Date.now()+180*24*60*60*1000).toISOString();
  row.telegramUserId=userId;row.telegramChatId=chatId;
  await writeDb(db);
  await tgCall('sendMessage',{
   chat_id:chatId,
   text:'✅ Telefon raqamingiz tasdiqlandi!\n\nZARBULOQ ilovasiga qayting. Tasdiqlash avtomatik aniqlanadi.',
   reply_markup:{remove_keyboard:true}
  });
 }
}

async function handleTelegramCallback(q){
 if(!q)return;
 const [kind,status,orderId]=String(q.data||'').split('|');
 if(kind!=='st')return;
 try{
  await updateOrderStatus(orderId,status,'telegram');
  await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:statusLabel(status)});
 }catch(e){
  await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik'}).catch(()=>{});
  console.error('Telegram callback error:',e.message);
 }
}

app.post('/api/telegram/webhook',async(req,res)=>{
 try{
  if(!BOT_TOKEN)return res.sendStatus(404);
  const supplied=String(req.get('X-Telegram-Bot-Api-Secret-Token')||'');
  if(!supplied || supplied!==TELEGRAM_WEBHOOK_SECRET)return res.sendStatus(403);
  // Telegram expects a fast 2xx response. Process the callback asynchronously after acknowledging it.
  res.sendStatus(200);
  const update=req.body||{};
  if(update.callback_query)handleTelegramCallback(update.callback_query).catch(e=>console.error('Telegram webhook handler:',e.message));
  if(update.message)handleTelegramVerificationMessage(update.message).catch(e=>console.error('Telegram verification handler:',e.message));
 }catch(e){
  console.error('Telegram webhook error:',e.message);
  if(!res.headersSent)res.sendStatus(200);
 }
});

app.get('/api/telegram/webhook-status',requireAdmin,async(req,res)=>{
 if(!BOT_TOKEN)return res.status(503).json({ok:false,error:'Telegram bot token configured emas'});
 try{
  const info=await tgCall('getWebhookInfo',{});
  res.json({ok:true,url:info.url||'',pending_update_count:Number(info.pending_update_count||0),last_error_message:info.last_error_message||'',mode:'webhook'});
 }catch(e){res.status(502).json({ok:false,error:e.message})}
});

async function configureTelegramWebhook(){
 if(!BOT_TOKEN){console.log('Telegram webhook: BOT_TOKEN missing');return;}
 try{
  const result=await tgCall('setWebhook',{
   url:TELEGRAM_WEBHOOK_URL,
   secret_token:TELEGRAM_WEBHOOK_SECRET,
   allowed_updates:['callback_query','message'],
   drop_pending_updates:false,
   max_connections:20
  });
  console.log(`Telegram order-status buttons: webhook active -> ${TELEGRAM_WEBHOOK_URL}`);
  return result;
 }catch(e){
  console.error('Telegram webhook setup error:',e.message);
  // Retry later without crashing the shop. Orders still remain stored in PostgreSQL.
  setTimeout(()=>configureTelegramWebhook().catch(()=>{}),15000).unref?.();
 }
}

async function start(){
 try{
  await initStorage();
  app.listen(PORT,()=>{
   console.log(`IMOM OTA BARAKA v13.26.74 SECURITY HARDENED / zarbuloq.uz: http://localhost:${PORT}`);
   console.log(`Storage: ${pool?'PostgreSQL persistent':'local JSON fallback'}`);
   console.log(`Telegram CHAT_ID: ${CHAT_ID?'configured':'MISSING'}`);
   console.log(`Telegram BOT_TOKEN: ${BOT_TOKEN?'configured':'MISSING'}`);
   console.log(`Online admin: /admin.html | DATA_DIR=${DATA_DIR}`);
   configureTelegramWebhook();
  });
 }catch(e){
  console.error('Startup/storage error:',e);
  process.exit(1);
 }
}
start();
