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
 heroSlides:[{id:'slide-1',image:'parkent-slide-1.webp',active:true}],
 phone:'+998901361211',telegram:'https://t.me/imomotabaraka',email:'info@imomotamarket.uz',
 delivery:{free:true,district:'Parkent tumani',areas:['Parkent shahri','Chinor','Zarkent','So‘qoq','Kumushkon','Nevich','Boshqizilsoy','Changi','Qoraqalpoq','Nomdanak'],slots:['09:00–12:00','12:00–15:00','15:00–18:00','18:00–21:00']},
 seo:{title:'IMOM OTA BARAKA — ZARBULOQ.UZ',description:'ZARBULOQ.UZ — Parkent tumani bo‘ylab bepul yetkazib beruvchi IMOM OTA BARAKA internet do‘koni.',keywords:'zarbuloq, imom ota baraka, parkent, internet do‘kon, bepul yetkazib berish'}
};
const defaultPromos=[{code:'BARAKA5',type:'percent',value:5,minTotal:150000,active:true,usageLimit:100,used:0,expires:''}];

function initialDb(){return {products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[],productRequests:[],promos:defaultPromos,audit:[]};}
function normalizeDb(db){
 const merged={...initialDb(),...(db||{}),settings:{...defaultSettings,...(db?.settings||{}),delivery:{...defaultSettings.delivery,...(db?.settings?.delivery||{})},seo:{...defaultSettings.seo,...(db?.settings?.seo||{})},company:{...defaultSettings.company,...(db?.settings?.company||{})},map:{...defaultSettings.map,...(db?.settings?.map||{})},footer:{...defaultSettings.footer,...(db?.settings?.footer||{})},ui:{...defaultSettings.ui,...(db?.settings?.ui||{})}},promos:Array.isArray(db?.promos)?db.promos:defaultPromos,audit:Array.isArray(db?.audit)?db.audit:[]};
 const dom=String(merged.settings.siteDomain||'').toLowerCase();
 if(['velora.uz','barkamarket.uz','barakamarket.uz','imomotamarket.uz'].includes(dom))merged.settings.siteDomain='zarbuloq.uz';
 if(merged.settings.map?.title==='Parkent tumani xaritasi')merged.settings.map.title='Yetkazib berish bepul hududlar';
 if(merged.settings.map?.text?.startsWith('Buyurtmalar Parkent tumani bo‘ylab bepul yetkazib beriladi'))merged.settings.map.text='Xaritada yashil rang va qizil chegara bilan ko‘rsatilgan Parkent tumani hududlarida yetkazib berish bepul. Buyurtma vaqtida manzilingizni tanlang yoki aniq GPS lokatsiyangizni yuboring.';
 merged.settings.map.openUrl='https://www.openstreetmap.org/relation/5745823';
 for(const k of ['title','description','keywords'])if(typeof merged.settings.seo?.[k]==='string')merged.settings.seo[k]=merged.settings.seo[k].replace(/VELORA\.UZ/gi,'ZARBULOQ.UZ').replace(/velora/gi,'zarbuloq').replace(/BarkaMarket\.uz/gi,'ZARBULOQ.UZ').replace(/barkamarket/gi,'zarbuloq').replace(/barakamarket/gi,'zarbuloq').replace(/imomotamarket/gi,'zarbuloq');
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
app.get('/api/status',(req,res)=>res.json({ok:true,version:'13.15.0',telegramConfigured:Boolean(BOT_TOKEN&&CHAT_ID),adminOnline:true,storage:pool?'postgresql':'local-json',persistent:Boolean(pool),dataFile:DB_FILE}));
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
 res.json({role:req.adminRole,productRequests:(db.productRequests||[]).slice(0,500),stats:{orders:orders.length,today:orders.filter(o=>String(o.createdAt||'').slice(0,10)===today).length,month:orders.filter(o=>String(o.createdAt||'').slice(0,7)===month).length,year:orders.filter(o=>String(o.createdAt||'').slice(0,4)===year).length,revenue,profit,avg,pending:orders.filter(o=>['new','accepted','delivery'].includes(o.status)).length,cancelled:orders.filter(o=>o.status==='cancelled').length,lowStock:products.filter(p=>Number(p.stock||0)<=5).length,customers:getCustomers(orders).length},orders:orders.slice().reverse().slice(0,300),products,categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||'',customers:getCustomers(orders),promos:db.promos||[],audit:(db.audit||[]).slice(0,500),charts:{last7,topProducts:Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,qty])=>({name,qty})),areas:Object.entries(areaMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}))}});
});
app.put('/api/admin/catalog',requireAdmin,requireRole('stock'),async(req,res)=>{const db=readDb(),b=req.body||{};if(Array.isArray(b.products))db.products=b.products.slice(0,700).map(p=>({id:Number(p.id)||Date.now()+Math.floor(Math.random()*1000),cat:clean(p.cat,50),emoji:clean(p.emoji,10)||'🛍️',name:{uz:clean(p.name?.uz,120),ru:clean(p.name?.ru,120),en:clean(p.name?.en,120)},price:Math.max(0,Number(p.price)||0),cost:Math.max(0,Number(p.cost)||0),oldPrice:Math.max(0,Number(p.oldPrice)||0),stock:Math.max(0,Math.floor(Number(p.stock)||0)),image:String(p.image||'').slice(0,6_000_000),badge:clean(p.badge,30),featured:Boolean(p.featured)}));if(Array.isArray(b.categories))db.categories=b.categories.slice(0,100);if(b.settings&&typeof b.settings==='object')db.settings=b.settings;if(typeof b.logo==='string')db.logo=b.logo.slice(0,6_000_000);audit(db,req.adminUser,'Katalog/sozlamalar yangilandi');await writeDb(db);res.json({ok:true});});
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

app.post('/api/orders',async(req,res)=>{
 const db=readDb(),b=req.body||{},customer=b.customer||{},items=Array.isArray(b.items)?b.items:[];
 if(!clean(customer.name,80)||!clean(customer.phone,30)||!clean(customer.address,300)||!clean(customer.area,100)||!clean(customer.payment,80)||!items.length)return res.status(400).json({error:'Majburiy maydonlarni to‘ldiring'});
 if(!(db.settings?.delivery?.areas||[]).includes(customer.area))return res.status(400).json({error:'Yetkazib berish hududini tanlang'});
 const finalItems=[];let subtotal=0;
 for(const i of items){const p=(db.products||[]).find(x=>Number(x.id)===Number(i.id));if(!p)continue;const qty=Math.max(1,Math.floor(Number(i.qty)||1));if(qty>Number(p.stock||0))return res.status(400).json({error:`${p.name?.uz||'Mahsulot'} omborda yetarli emas`});finalItems.push({id:p.id,name:p.name?.[b.language]||p.name?.uz||'',price:Number(p.price||0),qty});subtotal+=Number(p.price||0)*qty;}
 if(!finalItems.length)return res.status(400).json({error:'Mahsulot topilmadi'});
 const promoResult=validatePromo(db,b.promoCode,subtotal);if(!promoResult.ok)return res.status(400).json({error:promoResult.error});const discount=promoResult.discount,total=subtotal-discount;
 const orderId=`IOB-${String(Date.now()).slice(-8)}-${String(Math.floor(Math.random()*90)+10)}`,createdAt=new Date().toISOString();
 const order={orderId,createdAt,status:'new',customer:{name:clean(customer.name,80),phone:clean(customer.phone,30),address:clean(customer.address,300),area:clean(customer.area,100),deliverySlot:clean(customer.deliverySlot,50),payment:clean(customer.payment,80),comment:clean(customer.comment,500),lat:Number(customer.lat)||null,lng:Number(customer.lng)||null},items:finalItems,subtotal,discount,total,promoCode:promoResult.promo?.code||'',language:clean(b.language,5)||'uz',telegram:null};
 for(const it of finalItems){const p=db.products.find(x=>Number(x.id)===Number(it.id));p.stock=Math.max(0,Number(p.stock||0)-it.qty)}
 if(promoResult.promo)promoResult.promo.used=Number(promoResult.promo.used||0)+1;
 db.orders=db.orders||[];db.orders.push(order);audit(db,'customer','Yangi buyurtma',`${orderId} • ${money(total)}`);await writeDb(db);
 if(BOT_TOKEN&&CHAT_ID){try{const msg=await tgCall('sendMessage',{chat_id:CHAT_ID,text:orderText(order),reply_markup:statusKeyboard(orderId,'new')});const db2=readDb(),o=db2.orders.find(x=>x.orderId===orderId);if(o){o.telegram={chatId:String(msg.chat.id),messageId:msg.message_id};await writeDb(db2);}}catch(e){console.error('Telegram send error:',e.message);return res.status(502).json({error:'Buyurtma saqlandi, lekin Telegramga yuborilmadi',orderId,saved:true});}}
 res.json({ok:true,orderId,total,discount});
});

async function updateOrderStatus(orderId,status,actor='admin'){
 const allowed=['new','accepted','delivery','done','cancelled'];if(!allowed.includes(status))throw new Error('Invalid status');const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===orderId);if(!o)throw new Error('Order not found');const prev=o.status;o.status=status;o.statusUpdatedAt=new Date().toISOString();audit(db,actor,'Buyurtma statusi',`${orderId}: ${prev} → ${status}`);await writeDb(db);
 if(BOT_TOKEN&&o.telegram?.chatId&&o.telegram?.messageId){try{await tgCall('editMessageText',{chat_id:o.telegram.chatId,message_id:o.telegram.messageId,text:orderText(o),reply_markup:['done','cancelled'].includes(status)?{inline_keyboard:[]}:statusKeyboard(o.orderId,status)});}catch(e){console.error('Telegram edit error:',e.message)}}return o;
}
app.patch('/api/admin/orders/:id/status',requireAdmin,requireRole('operator'),async(req,res)=>{try{const o=await updateOrderStatus(req.params.id,String(req.body?.status||''),req.adminUser);res.json({ok:true,order:o});}catch(e){res.status(400).json({error:e.message})}});

let polling=false,offset=0;
async function pollTelegram(){if(!BOT_TOKEN||polling)return;polling=true;try{try{await tgCall('deleteWebhook',{drop_pending_updates:false});}catch{}console.log('Telegram order-status buttons: polling started');while(true){try{const updates=await tgCall('getUpdates',{offset,timeout:25,allowed_updates:['callback_query']});for(const u of updates){offset=Math.max(offset,u.update_id+1);const q=u.callback_query;if(!q)continue;const [kind,status,orderId]=String(q.data||'').split('|');if(kind!=='st')continue;try{await updateOrderStatus(orderId,status,'telegram');await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:statusLabel(status)});}catch(e){await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik'}).catch(()=>{});console.error('Callback error:',e.message)}}}catch(e){console.error('Telegram polling error:',e.message);await new Promise(r=>setTimeout(r,4000));}}}finally{polling=false}}

async function start(){
 try{
  await initStorage();
  app.listen(PORT,()=>{
   console.log(`IMOM OTA BARAKA v13.15 SEO REALTIME ZARBULOQ / zarbuloq.uz: http://localhost:${PORT}`);
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
