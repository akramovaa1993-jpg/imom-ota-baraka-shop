const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const XLSX=require('xlsx');

function assert(ok,msg){if(!ok)throw new Error(msg)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function waitFor(url,tries=60){
  let last='';
  for(let i=0;i<tries;i++){
    try{const r=await fetch(url);if(r.ok)return r}catch(e){last=String(e)}
    await sleep(500);
  }
  throw new Error('Server start timeout: '+last);
}
async function main(){
  // Browser JS syntax: parse each inline script in admin.html.
  const html=fs.readFileSync(path.join(__dirname,'..','admin.html'),'utf8');
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
  for(const code of scripts)new Function(code);

  // Excel fixture: visible text is "Rasm", real URL is a hyperlink Target.
  const headers=['Mahsulot kodi','Nomi UZ','Nomi RU','Kategoriya UZ','Kategoriya RU',"Sotuv narxi (so'm)","Tannarx (so'm)",'Omborga miqdor','Birlik UZ','Birlik RU','Tavsif UZ','Tavsif RU','Rasm URL'];
  const ws=XLSX.utils.aoa_to_sheet([headers,['LAB-001','Lab mahsulot','Лаб товар','Test','Тест',10000,7000,1,'dona','шт','','','Rasm']]);
  ws.M2.l={Target:'https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png',Tooltip:'Test image'};
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Mahsulot importi');
  const xlsxPath=path.join('/tmp','zarbuloq-price-hyperlink.xlsx');
  XLSX.writeFile(wb,xlsxPath);

  const dataDir=path.join('/tmp','zarbuloq-price-image-ci');
  fs.rmSync(dataDir,{recursive:true,force:true});fs.mkdirSync(dataDir,{recursive:true});
  const child=spawn(process.execPath,['server.js'],{
    cwd:path.join(__dirname,'..'),
    env:{...process.env,PORT:'3123',DATA_DIR:dataDir,REQUIRE_DATABASE:'false',DATABASE_URL:'',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-pass-123',SESSION_SECRET:'price-image-lab-secret',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:''},
    stdio:['ignore','pipe','pipe']
  });
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);

  try{
    await waitFor('http://127.0.0.1:3123/api/status');

    // 1) Direct image URL through server relay.
    let r=await fetch('http://127.0.0.1:3123/api/image-proxy?url='+encodeURIComponent('https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png'));
    const directRaw=Buffer.from(await r.arrayBuffer());
    if(!r.ok)throw new Error('Direct image proxy HTTP '+r.status+' '+directRaw.toString('utf8').slice(0,300)+'\nSERVER LOGS:\n'+logs.slice(-3000));
    const direct=directRaw;
    assert(String(r.headers.get('content-type')||'').startsWith('image/'),'Direct image content-type');
    assert(direct.length>100,'Direct image too small');

    // 2) HTML product/page URL -> og:image -> image bytes.
    r=await fetch('http://127.0.0.1:3123/api/image-proxy?url='+encodeURIComponent('https://github.com/'));
    const pageRaw=Buffer.from(await r.arrayBuffer());
    if(!r.ok)throw new Error('HTML og:image fallback HTTP '+r.status+' '+pageRaw.toString('utf8').slice(0,300)+'\nSERVER LOGS:\n'+logs.slice(-3000));
    const pageImage=pageRaw;
    assert(String(r.headers.get('content-type')||'').startsWith('image/'),'HTML fallback content-type');
    assert(pageImage.length>100,'HTML fallback image too small');

    // 3) Login and Excel hyperlink preview.
    r=await fetch('http://127.0.0.1:3123/api/admin/login',{method:'POST',headers:{'content-type':'application/json','origin':'http://127.0.0.1:3123','sec-fetch-site':'same-origin'},body:JSON.stringify({username:'admin',password:'test-pass-123'})});
    assert(r.ok,'Admin login HTTP '+r.status);
    const cookie=String(r.headers.get('set-cookie')||'').split(';')[0];
    assert(cookie.includes('iob_admin='),'Admin cookie missing');

    const body=fs.readFileSync(xlsxPath);
    r=await fetch('http://127.0.0.1:3123/api/admin/products-import-preview',{
      method:'POST',
      headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','cookie':cookie,'origin':'http://127.0.0.1:3123','sec-fetch-site':'same-origin'},
      body
    });
    const preview=await r.json();
    assert(r.ok,'Excel preview HTTP '+r.status+' '+JSON.stringify(preview));
    assert(preview.rows&&preview.rows.length===1,'Excel preview row missing');
    assert(preview.rows[0].image==='https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png','Excel hyperlink Target was not extracted: '+preview.rows[0].image);

    // 4) Import one product, then run read-only server diagnostics and verify product count is unchanged.
    r=await fetch('http://127.0.0.1:3123/api/admin/products-import-excel',{
      method:'POST',
      headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','cookie':cookie,'origin':'http://127.0.0.1:3123','sec-fetch-site':'same-origin'},
      body
    });
    const imported=await r.json();
    assert(r.ok,'Excel import HTTP '+r.status+' '+JSON.stringify(imported));

    r=await fetch('http://127.0.0.1:3123/api/admin/products',{headers:{cookie}});
    const before=await r.json();
    assert(r.ok&&before.productCount>=1,'Admin products before diagnostics missing');

    r=await fetch('http://127.0.0.1:3123/api/admin/price-image-diagnostics?scope=price',{headers:{cookie}});
    const diag=await r.json();
    assert(r.ok,'Diagnostics HTTP '+r.status+' '+JSON.stringify(diag));
    const labDiag=(diag.rows||[]).find(x=>x.sku==='LAB-001');
    assert(labDiag&&labDiag.status==='ready','Imported image diagnostic was not ready: '+JSON.stringify(labDiag));

    r=await fetch('http://127.0.0.1:3123/api/admin/products',{headers:{cookie}});
    const after=await r.json();
    assert(r.ok,'Admin products after diagnostics HTTP '+r.status);
    assert(after.productCount===before.productCount,'Diagnostics changed product count: '+before.productCount+' -> '+after.productCount);

    console.log('PRICE IMAGE LAB TESTS: PASS');
    console.log(JSON.stringify({directImageBytes:direct.length,htmlFallbackBytes:pageImage.length,excelHyperlink:preview.rows[0].image},null,2));
  }finally{
    child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),sleep(2000)]);
    if(child.exitCode===null)child.kill('SIGKILL');
    if(process.exitCode)console.error(logs);
  }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
