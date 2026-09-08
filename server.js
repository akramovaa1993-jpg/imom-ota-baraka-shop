const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
const DB_FILE = path.join(DATA_DIR,'shop.json');

app.use(express.json({limit:'8mb'}));
app.use(express.static(__dirname));

const defaultCategories=[
 {id:'food',icon:'🍎',name:{uz:'Oziq-ovqat',ru:'Продукты',en:'Food'}},
 {id:'home',icon:'🏠',name:{uz:'Uy uchun',ru:'Для дома',en:'Home'}}
];
const defaultProducts=[
 {id:1,cat:'food',emoji:'🍚',name:{uz:'Premium guruch',ru:'Премиальный рис',en:'Premium rice'},price:45000,stock:25,image:''},
 {id:2,cat:'food',emoji:'🍯',name:{uz:'Tabiiy asal',ru:'Натуральный мёд',en:'Natural honey'},price:78000,stock:20,image:''},
 {id:3,cat:'food',emoji:'🫙',name:{uz:'Sof zaytun yog‘i',ru:'Оливковое масло',en:'Pure olive oil'},price:125000,stock:15,image:''},
 {id:4,cat:'home',emoji:'🧺',name:{uz:'Uy uchun to‘plam',ru:'Набор для дома',en:'Home essentials set'},price:99000,stock:10,image:''}
];
const defaultSettings={
 hero:{uz:{title:'Baraka bilan tanlang.',text:'Siz uchun saralangan sifatli mahsulotlar. Zamonaviy xarid tajribasi, ishonchli xizmat va tez yetkazib berish.'},ru:{title:'Выбирайте с баракатом.',text:'Качественные товары, отобранные для вас. Современный шопинг, надёжный сервис и быстрая доставка.'},en:{title:'Choose with baraka.',text:'Quality products selected for you. A modern shopping experience, reliable service and fast delivery.'}},
 catalog:{uz:'Mashhur mahsulotlar',ru:'Популярные товары',en:'Popular products'},
 about:{uz:{title:'Baraka — sifat va ishonchdan boshlanadi.',text:'Imom Ota Baraka brendi mijozga sifatli mahsulot, shaffof xizmat va yoqimli xarid tajribasini taqdim etishga intiladi.'},ru:{title:'Баракат начинается с качества и доверия.',text:'Imom Ota Baraka стремится дать клиентам качественные товары, прозрачный сервис и приятный опыт покупок.'},en:{title:'Baraka starts with quality and trust.',text:'Imom Ota Baraka aims to provide quality products, transparent service and a pleasant shopping experience.'}},
 contact:{uz:{title:'Yangiliklardan xabardor bo‘ling.',text:'Aksiyalar va yangi mahsulotlar haqida birinchi bo‘lib bilib oling.'},ru:{title:'Будьте в курсе новостей.',text:'Узнавайте первыми об акциях и новых товарах.'},en:{title:'Stay in the loop.',text:'Be the first to hear about offers and new products.'}},
 phone:'+998901361211',telegram:'https://t.me/imomotabaraka',email:'info@imomotamarket.uz'
};

function ensureDb(){
 fs.mkdirSync(DATA_DIR,{recursive:true});
 if(!fs.existsSync(DB_FILE)) writeDb({products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[]});
}
function readDb(){ensureDb(); try{return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch{return {products:defaultProducts,categories:defaultCategories,settings:defaultSettings,logo:'',orders:[]};}}
function writeDb(db){fs.mkdirSync(DATA_DIR,{recursive:true}); const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(db,null,2)); fs.renameSync(tmp,DB_FILE);}
function clean(v,max=500){return String(v??'').replace(/[<>]/g,'').trim().slice(0,max)}
const money=n=>new Intl.NumberFormat('ru-RU').format(Number(n)||0)+' so‘m';
function statusLabel(code){return {new:'🕓 Yangi',accepted:'✅ Qabul qilindi',delivery:'🚚 Yetkazilmoqda',done:'📦 Yakunlandi',cancelled:'❌ Bekor qilindi'}[code]||'🕓 Yangi'}
function statusKeyboard(orderId,current='new'){
 const rows=[[{text:'✅ Qabul qilindi',callback_data:`st|accepted|${orderId}`},{text:'🚚 Yetkazilmoqda',callback_data:`st|delivery|${orderId}`}],[{text:'📦 Yakunlandi',callback_data:`st|done|${orderId}`},{text:'❌ Bekor qilindi',callback_data:`st|cancelled|${orderId}`}]];
 return {inline_keyboard:rows.map(row=>row.map(b=>({...b,text:(b.callback_data.includes(`|${current}|`)?'• ':'')+b.text})))};
}
async function tgCall(method,payload){const r=await fetch(`${TG}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));if(!r.ok||!data.ok)throw new Error(data.description||`Telegram ${method} failed`);return data.result}

function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));}
function signSession(user,exp){const raw=`${user}|${exp}`; const sig=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex'); return Buffer.from(`${raw}|${sig}`).toString('base64url');}
function verifySession(token){try{const [user,exp,sig]=Buffer.from(token,'base64url').toString().split('|');if(!user||!exp||!sig||Date.now()>Number(exp))return null;const raw=`${user}|${exp}`;const good=crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('hex');if(sig.length!==good.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(good)))return null;return user;}catch{return null}}
function requireAdmin(req,res,next){const user=verifySession(parseCookies(req).iob_admin||'');if(!user)return res.status(401).json({error:'Unauthorized'});req.adminUser=user;next();}

app.get('/health',(req,res)=>res.status(200).send('OK'));
app.get('/api/status',(req,res)=>res.json({ok:true,version:'11.0.0',telegramConfigured:Boolean(BOT_TOKEN&&CHAT_ID),adminOnline:true,dataFile:DB_FILE}));
app.get('/api/catalog',(req,res)=>{const db=readDb();res.json({products:db.products||[],categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||''});});

app.post('/api/admin/login',(req,res)=>{const u=clean(req.body?.username,80),p=String(req.body?.password||'');if(u!==ADMIN_USER||p!==ADMIN_PASSWORD)return res.status(401).json({error:'Login yoki parol noto‘g‘ri'});const exp=Date.now()+12*60*60*1000;const token=signSession(u,exp);res.setHeader('Set-Cookie',`iob_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true,user:u});});
app.post('/api/admin/logout',(req,res)=>{res.setHeader('Set-Cookie','iob_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({ok:true,user:req.adminUser}));

app.get('/api/admin/dashboard',requireAdmin,(req,res)=>{const db=readDb(),orders=db.orders||[];const today=new Date().toISOString().slice(0,10);const month=today.slice(0,7);const done=orders.filter(o=>o.status==='done');res.json({stats:{orders:orders.length,today:orders.filter(o=>String(o.createdAt||'').slice(0,10)===today).length,month:orders.filter(o=>String(o.createdAt||'').slice(0,7)===month).length,revenue:done.reduce((s,o)=>s+Number(o.total||0),0),pending:orders.filter(o=>['new','accepted','delivery'].includes(o.status)).length,cancelled:orders.filter(o=>o.status==='cancelled').length,lowStock:(db.products||[]).filter(p=>Number(p.stock||0)<=5).length},orders:orders.slice().reverse().slice(0,200),products:db.products||[],categories:db.categories||[],settings:db.settings||defaultSettings,logo:db.logo||''});});
app.put('/api/admin/catalog',requireAdmin,(req,res)=>{const db=readDb();const b=req.body||{};if(Array.isArray(b.products))db.products=b.products.slice(0,500).map(p=>({id:Number(p.id)||Date.now(),cat:clean(p.cat,50),emoji:clean(p.emoji,10)||'🛍️',name:{uz:clean(p.name?.uz,120),ru:clean(p.name?.ru,120),en:clean(p.name?.en,120)},price:Math.max(0,Number(p.price)||0),stock:Math.max(0,Math.floor(Number(p.stock)||0)),image:String(p.image||'').slice(0,6_000_000)}));if(Array.isArray(b.categories))db.categories=b.categories.slice(0,100);if(b.settings&&typeof b.settings==='object')db.settings=b.settings;if(typeof b.logo==='string')db.logo=b.logo.slice(0,6_000_000);writeDb(db);res.json({ok:true});});
app.patch('/api/admin/orders/:id/status',requireAdmin,async(req,res)=>{const status=clean(req.body?.status,30);if(!['new','accepted','delivery','done','cancelled'].includes(status))return res.status(400).json({error:'Invalid status'});const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===req.params.id);if(!o)return res.status(404).json({error:'Order not found'});o.status=status;o.updatedAt=new Date().toISOString();writeDb(db);try{await syncTelegramOrder(o);}catch(e){console.error('Admin Telegram sync:',e.message||e)}res.json({ok:true,order:o});});

function orderTelegramText(o){const lines=(o.items||[]).map((x,i)=>`${i+1}. ${x.name}${x.qty>1?` × ${x.qty}`:''} — ${money(Number(x.price)*Number(x.qty||1))}`);return [`🛒 YANGI BUYURTMA #${o.orderId}`,'',`👤 Mijoz: ${o.customer.name}`,`📞 Telefon: ${o.customer.phone}`,`📍 Manzil: ${o.customer.address}`,`💳 To‘lov: ${o.customer.payment||'—'}`,o.customer.comment?`💬 Izoh: ${o.customer.comment}`:'','',...lines,'',`💰 JAMI: ${money(o.total)}`,`🕐 ${new Date(o.createdAt).toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})}`,`📌 Holat: ${statusLabel(o.status)}`].filter(Boolean).join('\n');}
async function syncTelegramOrder(o){if(!BOT_TOKEN||!CHAT_ID||!o.telegramMessageId)return;const terminal=['done','cancelled'].includes(o.status);await tgCall('editMessageText',{chat_id:CHAT_ID,message_id:o.telegramMessageId,text:orderTelegramText(o),reply_markup:terminal?{inline_keyboard:[]}:statusKeyboard(o.orderId,o.status)});}

app.post('/api/orders',async(req,res)=>{try{if(!BOT_TOKEN||!CHAT_ID)return res.status(503).json({error:'Telegram bot is not configured'});const body=req.body||{},c=body.customer||{},raw=Array.isArray(body.items)?body.items.slice(0,100):[];if(!clean(c.name,80)||!clean(c.phone,30)||!clean(c.address,300)||!raw.length)return res.status(400).json({error:'Required order fields are missing'});const db=readDb();const counts=new Map();for(const x of raw){const id=Number(x.id);counts.set(id,(counts.get(id)||0)+1)}const items=[];let total=0;for(const [id,qty] of counts){const p=(db.products||[]).find(x=>Number(x.id)===id);if(!p)return res.status(400).json({error:'Mahsulot topilmadi'});if(Number(p.stock||0)<qty)return res.status(409).json({error:`${p.name?.uz||'Mahsulot'} omborda yetarli emas`});items.push({id:p.id,name:p.name?.uz||raw.find(x=>Number(x.id)===id)?.name||'Mahsulot',price:Number(p.price)||0,qty});total+=(Number(p.price)||0)*qty;}
 const orderId='IOB-'+Date.now().toString().slice(-8)+'-'+crypto.randomInt(10,99);const order={orderId,customer:{name:clean(c.name,80),phone:clean(c.phone,30),address:clean(c.address,300),payment:clean(c.payment,80)||'—',comment:clean(c.comment,500)},items,total,status:'new',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),telegramMessageId:null};const sent=await tgCall('sendMessage',{chat_id:CHAT_ID,text:orderTelegramText(order),reply_markup:statusKeyboard(orderId)});order.telegramMessageId=sent.message_id;for(const it of items){const p=db.products.find(x=>Number(x.id)===Number(it.id));p.stock=Math.max(0,Number(p.stock||0)-it.qty)}db.orders=db.orders||[];db.orders.push(order);writeDb(db);res.json({ok:true,orderId,messageId:sent.message_id});}catch(e){console.error('Order error:',e.message||e);res.status(500).json({error:'Server error'});}});

let polling=false,updateOffset=0;
async function handleCallback(q){try{if(!q?.id||!q?.data||!q?.message)return;const chatId=String(q.message.chat?.id??'');if(CHAT_ID&&chatId!==CHAT_ID){await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Ruxsat yo‘q',show_alert:true});return}const parts=String(q.data).split('|');if(parts.length!==3||parts[0]!=='st')return;const [,status,orderId]=parts;if(!['accepted','delivery','done','cancelled'].includes(status))return;const db=readDb(),o=(db.orders||[]).find(x=>x.orderId===orderId);if(o){o.status=status;o.updatedAt=new Date().toISOString();o.telegramMessageId=q.message.message_id;writeDb(db);await syncTelegramOrder(o);}else{let text=String(q.message.text||'');const label=statusLabel(status);if(/📌 Holat:.*$/m.test(text))text=text.replace(/📌 Holat:.*$/m,`📌 Holat: ${label}`);await tgCall('editMessageText',{chat_id:chatId,message_id:q.message.message_id,text,reply_markup:['done','cancelled'].includes(status)?{inline_keyboard:[]}:statusKeyboard(orderId,status)});}await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:`${orderId}: ${statusLabel(status)}`});}catch(e){console.error('Callback error:',e.message||e);try{if(q?.id)await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik yuz berdi',show_alert:true})}catch{}}}
async function pollTelegram(){if(polling||!BOT_TOKEN)return;polling=true;console.log('Telegram order-status buttons: polling started');try{await tgCall('deleteWebhook',{drop_pending_updates:false})}catch(e){console.error('Telegram deleteWebhook:',e.message||e)}while(true){try{const updates=await tgCall('getUpdates',{timeout:25,offset:updateOffset,allowed_updates:['callback_query']});if(Array.isArray(updates))for(const u of updates){updateOffset=Math.max(updateOffset,Number(u.update_id)+1);if(u.callback_query)await handleCallback(u.callback_query)}}catch(e){console.error('Telegram polling error:',e.message||e);await new Promise(r=>setTimeout(r,3000))}}}

ensureDb();
app.listen(PORT,()=>{console.log(`Imom Ota Baraka v11: http://localhost:${PORT}`);console.log(`Telegram CHAT_ID: ${CHAT_ID?'configured':'MISSING'}`);console.log(`Telegram BOT_TOKEN: ${BOT_TOKEN?'configured':'MISSING'}`);console.log(`Online admin: /admin.html | DATA_DIR=${DATA_DIR}`);if(BOT_TOKEN&&CHAT_ID)pollTelegram();});
