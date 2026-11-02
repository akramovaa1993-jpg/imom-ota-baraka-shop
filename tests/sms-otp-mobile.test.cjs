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
  assert.match(q.sql,/token_hash=\\$1 AND phone_e164=\\$2 AND device_id=\\$3 AND expires_at>NOW\\(\\)/);
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
