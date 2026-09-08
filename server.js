const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';

app.use(express.json({limit:'200kb'}));
app.use(express.static(__dirname));

app.get('/api/status', (req,res) => {
  res.json({
    ok:true,
version:'10.1.0',
    telegramConfigured:Boolean(BOT_TOKEN && CHAT_ID),
    chatIdConfigured:Boolean(CHAT_ID),
    orderStatusButtons:true
  });
});

app.get('/health', (req,res) => res.status(200).send('OK'));

const clean = (v, max=500) => String(v ?? '').replace(/[<>]/g,'').trim().slice(0,max);
const money = n => new Intl.NumberFormat('ru-RU').format(Number(n)||0) + ' so‘m';

function statusLabel(code){
  return {
    accepted:'✅ Qabul qilindi',
    delivery:'🚚 Yetkazilmoqda',
    done:'📦 Yakunlandi',
    cancelled:'❌ Bekor qilindi'
  }[code] || '🕓 Yangi';
}

function statusKeyboard(orderId, current='new'){
  const rows = [
    [
      {text:'✅ Qabul qilindi',callback_data:`st|accepted|${orderId}`},
      {text:'🚚 Yetkazilmoqda',callback_data:`st|delivery|${orderId}`}
    ],
    [
      {text:'📦 Yakunlandi',callback_data:`st|done|${orderId}`},
      {text:'❌ Bekor qilindi',callback_data:`st|cancelled|${orderId}`}
    ]
  ];
  return {inline_keyboard: rows.map(row => row.map(b => ({...b,text:(b.callback_data.includes(`|${current}|`)?'• ':'')+b.text})))};
}

async function tgCall(method, payload){
  const r = await fetch(`${TG}/${method}`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  const data = await r.json().catch(()=>({ok:false,description:'Invalid Telegram response'}));
  if(!r.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

app.post('/api/orders', async (req,res) => {
  try {
    if(!BOT_TOKEN || !CHAT_ID) return res.status(503).json({error:'Telegram bot is not configured'});
    const body=req.body||{}, c=body.customer||{}, items=Array.isArray(body.items)?body.items.slice(0,50):[];
    if(!clean(c.name,80) || !clean(c.phone,30) || !clean(c.address,300) || !items.length) return res.status(400).json({error:'Required order fields are missing'});

    const orderId='IOB-'+Date.now().toString().slice(-8)+'-'+crypto.randomInt(10,99);
    const lines=items.map((x,i)=>`${i+1}. ${clean(x.name,120)} — ${money(x.price)}`);
    const text=[
      `🛒 YANGI BUYURTMA #${orderId}`,'',
      `👤 Mijoz: ${clean(c.name,80)}`,
      `📞 Telefon: ${clean(c.phone,30)}`,
      `📍 Manzil: ${clean(c.address,300)}`,
      `💳 To‘lov: ${clean(c.payment,80)||'—'}`,
      c.comment?`💬 Izoh: ${clean(c.comment,500)}`:'','',
      ...lines,'',
      `💰 JAMI: ${money(body.total)}`,
      `🕐 ${new Date().toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})}`,
      `📌 Holat: 🕓 Yangi`
    ].filter(Boolean).join('\n');

    const sent = await tgCall('sendMessage', {
      chat_id:CHAT_ID,
      text,
      reply_markup:statusKeyboard(orderId)
    });
    res.json({ok:true,orderId,messageId:sent.message_id});
  } catch(e){
    console.error('Order error:',e.message||e);
    res.status(500).json({error:'Server error'});
  }
});

let polling = false;
let updateOffset = 0;

async function handleCallback(q){
  try{
    if(!q || !q.id || !q.data || !q.message) return;
    const chatId = String(q.message.chat?.id ?? '');
    if(CHAT_ID && chatId !== CHAT_ID){
      await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Ruxsat yo‘q',show_alert:true});
      return;
    }
    const parts = String(q.data).split('|');
    if(parts.length !== 3 || parts[0] !== 'st') return;
    const [,status,orderId] = parts;
    if(!['accepted','delivery','done','cancelled'].includes(status)) return;

    const label = statusLabel(status);
    let text = String(q.message.text || '');
    if(/📌 Holat:.*$/m.test(text)) text = text.replace(/📌 Holat:.*$/m,`📌 Holat: ${label}`);
    else text += `\n📌 Holat: ${label}`;

    const terminal = status === 'done' || status === 'cancelled';
    await tgCall('editMessageText',{
      chat_id:chatId,
      message_id:q.message.message_id,
      text,
      reply_markup:terminal ? {inline_keyboard:[]} : statusKeyboard(orderId,status)
    });
    await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:`${orderId}: ${label}`});
  }catch(e){
    console.error('Callback error:',e.message||e);
    try{ if(q?.id) await tgCall('answerCallbackQuery',{callback_query_id:q.id,text:'Xatolik yuz berdi',show_alert:true}); }catch{}
  }
}

async function pollTelegram(){
  if(polling || !BOT_TOKEN) return;

  polling = true;
  console.log('Telegram order-status buttons: polling started');

  // Agar oldin webhook o‘rnatilgan bo‘lsa, polling uchun uni o‘chiramiz
  try {
    await tgCall('deleteWebhook', {
      drop_pending_updates: false
    });
  } catch (e) {
    console.error('Telegram deleteWebhook:', e.message || e);
  }

  while(true){
    try{
      const updates = await tgCall('getUpdates', {
        timeout: 25,
        offset: updateOffset,
        allowed_updates: ['callback_query']
      });

      if(Array.isArray(updates)){
        for(const u of updates){
          updateOffset = Math.max(
            updateOffset,
            Number(u.update_id) + 1
          );

          if(u.callback_query){
            await handleCallback(u.callback_query);
          }
        }
      }

    }catch(e){
      console.error(
        'Telegram polling error:',
        e.message || e
      );

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );
    }
  }
}
app.listen(PORT, () => {
  console.log(`Imom Ota Baraka v10.1: http://localhost:${PORT}`);
  console.log(`Telegram CHAT_ID: ${CHAT_ID ? 'configured' : 'MISSING'}`);
  console.log(`Telegram BOT_TOKEN: ${BOT_TOKEN ? 'configured' : 'MISSING'}`);

  if (BOT_TOKEN && CHAT_ID) {
    pollTelegram();
  }
});
