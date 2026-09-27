'use strict';
const http=require('node:http'),https=require('node:https'),dns=require('node:dns').promises;
const {publicIp}=require('./security');
// Resolve once, reject every non-public address, then pin the actual socket lookup.
async function safeImageFetch(raw,{signal,headers={},maxBytes=12000000}={}){
 const u=new URL(raw),host=u.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||(u.port&&!['80','443'].includes(u.port)))throw new Error('Rasm URL ruxsat etilmagan');
 let timer;let rows;try{rows=await Promise.race([dns.lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),3000)})])}finally{clearTimeout(timer)}
 if(!rows.length||rows.some(r=>!publicIp(r.address)))throw new Error('Ichki manzil taqiqlangan');
 const address=rows[0];
 return new Promise((resolve,reject)=>{
  const request=(u.protocol==='https:'?https:http).request(u,{method:'GET',signal,headers,agent:false,lookup:(_host,opts,cb)=>opts?.all?cb(null,[address]):cb(null,address.address,address.family)},response=>{
   const status=response.statusCode,h={get:k=>{const v=response.headers[k.toLowerCase()];return Array.isArray(v)?v.join(','):v||null}};
   if([301,302,303,307,308].includes(status)){response.destroy();return resolve({status,ok:false,headers:h,arrayBuffer:async()=>Buffer.alloc(0)})}
   const type=String(h.get('content-type')||''),cap=/html/i.test(type)?Math.min(maxBytes,2000000):maxBytes;
   if(Number(h.get('content-length')||0)>cap){response.destroy();return reject(new Error('Rasm hajmi juda katta'))}
   let size=0;const chunks=[];
   response.on('data',chunk=>{size+=chunk.length;if(size>cap){response.destroy();reject(new Error('Rasm hajmi juda katta'))}else chunks.push(chunk)});
   response.on('error',reject);response.on('end',()=>{const data=Buffer.concat(chunks);resolve({status,ok:status>=200&&status<300,headers:h,arrayBuffer:async()=>data})});
  });request.setTimeout(10000,()=>request.destroy(new Error('Rasm yuklash vaqti tugadi')));request.on('error',reject);request.end();
 });
}
module.exports={safeImageFetch};
