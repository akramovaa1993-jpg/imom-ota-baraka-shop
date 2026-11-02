'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createSmsOtp}=require('../sms-otp');

const secret='test-only-sms-otp-secret-with-32-plus-characters';
const token='a'.repeat(64);
const phone='+998901234567';
const deviceId='android-test-device-123';
const digest=crypto.createHmac('sha256',secret).update(`mobile-checkout|${token}`).digest('hex');

function fixture(){
  const queries=[];let found=true;
  const pool={query:async(sql,params)=>{queries.push({sql:String(sql),params});return {rows:found&&params[0]===digest&&params[1]===phone&&params[2]===deviceId?[{ok:1}]:[]};}};
  const security={limiter:()=>((req,res,next)=>next()),asyncRoute:fn=>fn};
  const service=createSmsOtp({pool,security,otpSecret:secret,gatewayTokenDigest:'b'.repeat(64)});
  const routes=new Map();
  service.routes({post:(path,...handlers)=>routes.set(path,handlers.at(-1))});
  return {service,routes,queries,setFound:v=>{found=v;}};
}

test('mobile checkout OTP routes are registered with the app contract',()=>{
  const {routes}=fixture();
  for(const path of [
    '/api/mobile/checkout/otp/request',
    '/api/mobile/checkout/otp/verify',
    '/api/mobile/checkout/otp/restore',
    '/api/mobile/checkout/otp/logout'
  ]) assert.equal(typeof routes.get(path),'function',`missing ${path}`);
});

test('checkout proof is bound to phone and device and stored as keyed digest',async()=>{
  const {service,queries}=fixture();
  assert.equal(await service.validCheckoutProof(phone,deviceId,token),true);
  assert.equal(await service.validCheckoutProof('998901234567',deviceId,token),false);
  assert.equal(await service.validCheckoutProof(phone,'android-other-device',token),false);
  const q=queries[0];
  assert.match(q.sql,/token_hash=\$1 AND phone_e164=\$2 AND device_id=\$3 AND expires_at>NOW\(\)/);
  assert.equal(q.params[0],digest);
  assert.equal(q.params[1],phone);
  assert.equal(q.params[2],deviceId);
});

test('malformed or missing checkout proof never reaches the database',async()=>{
  const {service,queries}=fixture();
  assert.equal(await service.validCheckoutProof(phone,deviceId,'not-a-token'),false);
  assert.equal(await service.validCheckoutProof(phone,'bad',token),false);
  assert.equal(queries.length,0);
});

test('mock SMS checkout OTP request, verify, restore, proof validation and logout',async()=>{
  const challenges=new Map(),proofs=new Map(),devices=new Map();let smsMessage='';
  const pool={
    connect:async()=>({
      query:async(sql,p=[])=>{
        sql=String(sql);
        if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
        if(sql.includes('INSERT INTO otp_cooldowns')||sql.includes('UPDATE otp_cooldowns')||sql.includes("UPDATE sms_jobs SET status='expired'")||(sql.includes('UPDATE otp_challenges SET consumed_at=NOW()')&&sql.includes('WHERE phone_e164=')))return {rows:[]};
        if(sql.includes('SELECT resend_after FROM otp_cooldowns'))return {rows:[{resend_after:new Date(0)}]};
        if(sql.includes('INSERT INTO otp_challenges')){challenges.set(p[0],{challenge_id:p[0],phone_e164:p[1],purpose:p[2],verifier:p[3],expires_at:p[4],device_id:p[5],attempts:0});return {rows:[]};}
        if(sql.includes('INSERT INTO sms_jobs')){smsMessage=p[2];return {rows:[]};}
        if(sql.includes('SELECT * FROM otp_challenges')){const row=challenges.get(p[0]);return {rows:row&&row.phone_e164===p[1]&&row.purpose===p[2]&&row.device_id===p[3]?[row]:[]};}
        if(sql.includes('UPDATE otp_challenges SET attempts=attempts+1')){const row=challenges.get(p[0]);row.attempts++;return {rows:[{attempts:row.attempts}]};}
        if(sql.includes('UPDATE otp_challenges SET consumed_at=NOW(),verified_at=NOW()')){const row=challenges.get(p[0]);row.consumed_at=new Date();row.verified_at=new Date();return {rows:[]};}
        if(sql.includes('INSERT INTO mobile_checkout_proofs')){proofs.set(p[0],{phone:p[1],device:p[2],expires:Date.now()+300000});return {rows:[]};}
        if(sql.includes('INSERT INTO mobile_checkout_devices')){devices.set(p[0],{phone:p[1],device:p[2],expires:Date.now()+30*86400000,revoked:false});return {rows:[]};}
        if(sql.includes('SELECT 1 FROM mobile_checkout_devices')){const d=devices.get(p[0]);return {rows:d&&d.phone===p[1]&&d.device===p[2]&&!d.revoked&&d.expires>Date.now()?[{ok:1}]:[]};}
        if(sql.includes('UPDATE mobile_checkout_devices SET revoked_at')){const d=devices.get(p[0]);if(d&&d.phone===p[1]&&d.device===p[2])d.revoked=true;return {rows:[]};}
        throw new Error('Unhandled mocked SQL query');
      },release(){}
    }),
    query:async(sql,p=[])=>{
      if(String(sql).includes('FROM mobile_checkout_proofs')){const row=proofs.get(p[0]);return {rows:row&&row.phone===p[1]&&row.device===p[2]&&row.expires>Date.now()?[{ok:1}]:[]};}
      if(String(sql).includes('UPDATE mobile_checkout_devices SET revoked_at')){const d=devices.get(p[0]);if(d&&d.phone===p[1]&&d.device===p[2])d.revoked=true;return {rows:[]};}
      throw new Error('Unhandled mocked pool query');
    }
  };
  const security={limiter:()=>((req,res,next)=>next()),asyncRoute:fn=>fn};
  const service=createSmsOtp({pool,security,otpSecret:secret,gatewayTokenDigest:'b'.repeat(64)});
  const routes=new Map();service.routes({post:(path,...handlers)=>routes.set(path,handlers.at(-1))});
  async function call(path,body){const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(v){this.data=v;return this;}};await routes.get(path)({body},res);return res;}
  const requested=await call('/api/mobile/checkout/otp/request',{phone,deviceId});
  assert.equal(requested.statusCode,200);assert.equal(requested.data.expiresInSeconds,180);assert.equal(requested.data.resendAfterSeconds,60);
  const code=smsMessage.match(/: (\d{6})\./)?.[1];assert.ok(code,'mock gateway should capture the SMS body');
  const verified=await call('/api/mobile/checkout/otp/verify',{phone,deviceId,challengeId:requested.data.challengeId,code,rememberDevice:true});
  assert.equal(verified.statusCode,200);assert.match(verified.data.verificationToken,/^[a-f0-9]{64}$/);assert.equal(verified.data.expiresInSeconds,300);assert.match(verified.data.rememberedToken,/^[a-f0-9]{64}$/);assert.equal(verified.data.rememberExpiresInSeconds,30*86400);
  assert.equal(await service.validCheckoutProof(phone,deviceId,verified.data.verificationToken),true);
  const restored=await call('/api/mobile/checkout/otp/restore',{phone,deviceId,rememberedToken:verified.data.rememberedToken});
  assert.equal(restored.statusCode,200);assert.equal(restored.data.remembered,true);assert.equal(await service.validCheckoutProof(phone,deviceId,restored.data.verificationToken),true);
  const logout=await call('/api/mobile/checkout/otp/logout',{phone,deviceId,rememberedToken:verified.data.rememberedToken});
  assert.equal(logout.statusCode,200);
  const afterLogout=await call('/api/mobile/checkout/otp/restore',{phone,deviceId,rememberedToken:verified.data.rememberedToken});
  assert.equal(afterLogout.statusCode,403);
});
