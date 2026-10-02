'use strict';

const crypto = require('node:crypto');

const PHONE_RE = /^\+998\d{9}$/;
const JOB_ID_RE = /^[a-f0-9]{32,64}$/;
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeEqual = (a,b) => {
  const x=Buffer.from(String(a||'')), y=Buffer.from(String(b||''));
  return x.length===y.length && x.length>0 && crypto.timingSafeEqual(x,y);
};

function createSmsOtp({pool,security,otpSecret,gatewayTokenDigest}){
  if(!pool) throw new Error('SMS OTP requires PostgreSQL');
  if(!security?.limiter) throw new Error('security limiter required');
  if(String(otpSecret||'').length<32) throw new Error('SMS_OTP_SECRET must contain at least 32 random characters');
  if(!/^[a-f0-9]{64}$/.test(String(gatewayTokenDigest||''))) throw new Error('SMS_GATEWAY_TOKEN_SHA256 must be a SHA-256 hex digest');

  const otpVerifier=(challengeId,phone,code)=>
    crypto.createHmac('sha256',otpSecret).update(`${challengeId}|${phone}|${code}`).digest('hex');

  async function init(){
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_gateways (
        gateway_id TEXT PRIMARY KEY,
        token_digest TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_jobs (
        job_id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','sent','delivered','failed','expired')),
        gateway_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        error_code TEXT
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS sms_jobs_claim_idx ON sms_jobs(status,expires_at,created_at)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_challenges (
        challenge_id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL,
        purpose TEXT NOT NULL,
        verifier TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resend_after TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_challenges(phone_e164,purpose,created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS otp_cooldowns (
      phone_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL,
      resend_after TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(phone_e164,purpose)
    )`);
    await pool.query(`
      INSERT INTO sms_gateways(gateway_id,token_digest,status)
      VALUES('primary-android-gateway',$1,'active')
      ON CONFLICT(gateway_id) DO UPDATE SET token_digest=EXCLUDED.token_digest
    `,[gatewayTokenDigest]);
  }

  async function requireGateway(req,res,next){
    const raw=String(req.get('authorization')||'');
    const token=raw.replace(/^Bearer\s+/i,'');
    if(token.length<32 || token.length>512) return res.status(401).json({error:'Gateway credential required'});
    const digest=sha256(token);
    if(!safeEqual(digest,gatewayTokenDigest)) return res.status(401).json({error:'Gateway credential invalid'});
    const r=await pool.query(
      "SELECT gateway_id FROM sms_gateways WHERE token_digest=$1 AND status='active' AND revoked_at IS NULL",
      [digest]
    );
    if(!r.rows[0]) return res.status(401).json({error:'Gateway credential invalid'});
    req.smsGatewayId=r.rows[0].gateway_id;
    await pool.query('UPDATE sms_gateways SET last_seen_at=NOW() WHERE gateway_id=$1',[req.smsGatewayId]);
    next();
  }

  async function claim(req,res){
    const limit=Math.max(1,Math.min(5,Number(req.body?.limit)||1));
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("UPDATE sms_jobs SET status='expired' WHERE status IN ('queued','claimed') AND expires_at<=NOW()");
      const r=await client.query(`
        SELECT job_id,phone_e164,message,expires_at
        FROM sms_jobs
        WHERE expires_at>NOW()
          AND (status='queued' OR (status='claimed' AND lease_expires_at<NOW()))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      `,[limit]);
      const ids=r.rows.map(x=>x.job_id);
      if(ids.length) await client.query(`
        UPDATE sms_jobs
        SET status='claimed',gateway_id=$1,claimed_at=NOW(),lease_expires_at=NOW()+INTERVAL '45 seconds'
        WHERE job_id=ANY($2::text[])
      `,[req.smsGatewayId,ids]);
      await client.query('COMMIT');
      res.set('Cache-Control','no-store');
      return res.json({jobs:r.rows.map(x=>({
        id:x.job_id, phone:x.phone_e164, message:x.message,
        expiresAt:new Date(x.expires_at).getTime()
      }))});
    }catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      throw e;
    }finally{client.release();}
  }

  async function ack(req,res){
    const id=String(req.params.id||'');
    if(!JOB_ID_RE.test(id)) return res.status(400).json({error:'Invalid job id'});
    const status=String(req.body?.status||'').toLowerCase();
    if(!['sent','delivered','failed','expired'].includes(status)) return res.status(400).json({error:'Invalid status'});
    const errorCode=req.body?.errorCode==null?null:String(req.body.errorCode).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,64)||null;
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT status,gateway_id FROM sms_jobs WHERE job_id=$1 FOR UPDATE',[id]);
      const row=r.rows[0];
      if(!row || row.gateway_id!==req.smsGatewayId){
        await client.query('ROLLBACK');
        return res.status(404).json({error:'Job not found'});
      }
      const terminal=new Set(['delivered','failed','expired']);
      if(row.status==='sent' && status==='delivered'){
        await client.query("UPDATE sms_jobs SET status='delivered',delivered_at=NOW(),error_code=$2 WHERE job_id=$1",[id,errorCode]);
      }else if(row.status==='claimed' && status==='delivered'){
        // A delivery callback can arrive even if the earlier SENT ACK was lost in transit.
        // DELIVERED is stronger evidence, so record both submission and delivery timestamps.
        await client.query(
          "UPDATE sms_jobs SET status='delivered',sent_at=COALESCE(sent_at,NOW()),delivered_at=NOW(),error_code=$2 WHERE job_id=$1",
          [id,errorCode]
        );
      }else if(row.status==='claimed' && ['sent','failed','expired'].includes(status)){
        const col=status==='sent'?'sent_at':status==='failed'?'failed_at':null;
        if(col) await client.query(`UPDATE sms_jobs SET status=$2,${col}=NOW(),error_code=$3 WHERE job_id=$1`,[id,status,errorCode]);
        else await client.query('UPDATE sms_jobs SET status=$2,error_code=$3 WHERE job_id=$1',[id,status,errorCode]);
      }else if(row.status===status || terminal.has(row.status) || row.status==='sent'){
        // Idempotent duplicate or stale/out-of-order ACK: preserve the authoritative state.
      }else{
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Invalid job state transition'});
      }
      const out=await client.query('SELECT status FROM sms_jobs WHERE job_id=$1',[id]);
      await client.query('COMMIT');
      return res.json({ok:true,status:out.rows[0].status});
    }catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      throw e;
    }finally{client.release();}
  }

  async function requestOtp(req,res){
    const phone=String(req.body?.phone||'').replace(/[\s()-]/g,'');
    if(!PHONE_RE.test(phone)) return res.status(400).json({error:'Telefon raqami noto‘g‘ri'});
    const purpose='register';
    const challengeId=crypto.randomBytes(24).toString('hex');
    const jobId=crypto.randomBytes(24).toString('hex');
    const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
    const verifier=otpVerifier(challengeId,phone,code);
    const expiresAt=new Date(Date.now()+3*60*1000);
    const message=`Zarbuloq tasdiqlash kodi: ${code}. Kodni hech kimga bermang.`;

    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO otp_cooldowns(phone_e164,purpose,resend_after)
        VALUES($1,$2,NOW())
        ON CONFLICT(phone_e164,purpose) DO NOTHING
      `,[phone,purpose]);
      const cooldown=await client.query(
        'SELECT resend_after FROM otp_cooldowns WHERE phone_e164=$1 AND purpose=$2 FOR UPDATE',
        [phone,purpose]
      );
      if(cooldown.rows[0] && new Date(cooldown.rows[0].resend_after)>new Date()){
        await client.query('ROLLBACK');
        return res.status(429).json({error:'Kodni qayta yuborish uchun biroz kuting'});
      }
      await client.query(
        "UPDATE otp_cooldowns SET resend_after=NOW()+INTERVAL '60 seconds' WHERE phone_e164=$1 AND purpose=$2",
        [phone,purpose]
      );
      await client.query(`
        UPDATE otp_challenges SET consumed_at=NOW()
        WHERE phone_e164=$1 AND purpose=$2 AND consumed_at IS NULL
      `,[phone,purpose]);
      await client.query(`
        UPDATE sms_jobs SET status='expired',error_code='superseded'
        WHERE phone_e164=$1 AND status IN ('queued','claimed') AND expires_at>NOW()
      `,[phone]);
      await client.query(`
        INSERT INTO otp_challenges(challenge_id,phone_e164,purpose,verifier,expires_at,resend_after)
        VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '60 seconds')
      `,[challengeId,phone,purpose,verifier,expiresAt]);
      await client.query(`
        INSERT INTO sms_jobs(job_id,phone_e164,message,status,expires_at)
        VALUES($1,$2,$3,'queued',$4)
      `,[jobId,phone,message,expiresAt]);
      await client.query('COMMIT');
    }catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      throw e;
    }finally{client.release();}

    res.set('Cache-Control','no-store');
    return res.json({ok:true,challengeId,expiresIn:180,resendAfter:60});
  }

  async function verifyOtp(req,res){
    const challengeId=String(req.body?.challengeId||'');
    const phone=String(req.body?.phone||'').replace(/[\s()-]/g,'');
    const code=String(req.body?.code||'').trim();
    if(!/^[a-f0-9]{48}$/.test(challengeId)||!PHONE_RE.test(phone)||!/^\d{6}$/.test(code)){
      return res.status(400).json({error:'Tasdiqlash ma’lumotlari noto‘g‘ri'});
    }
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT * FROM otp_challenges WHERE challenge_id=$1 AND phone_e164=$2 FOR UPDATE',[challengeId,phone]);
      const row=r.rows[0];
      if(!row || row.consumed_at || new Date(row.expires_at)<=new Date()){
        await client.query('ROLLBACK');
        return res.status(400).json({error:'Kod yaroqsiz yoki muddati tugagan'});
      }
      if(Number(row.attempts)>=5){
        await client.query('ROLLBACK');
        return res.status(400).json({
          error:'Urinishlar limiti tugadi. Yangi kod so‘rang.',
          attemptsRemaining:0
        });
      }
      const expected=otpVerifier(challengeId,phone,code);
      if(!safeEqual(expected,row.verifier)){
        const failed=await client.query(
          'UPDATE otp_challenges SET attempts=attempts+1 WHERE challenge_id=$1 RETURNING attempts',
          [challengeId]
        );
        const attempts=Number(failed.rows[0]?.attempts||0);
        await client.query('COMMIT');
        return res.status(400).json({
          error:attempts>=5?'Urinishlar limiti tugadi. Yangi kod so‘rang.':'Tasdiqlash kodi noto‘g‘ri',
          attemptsRemaining:Math.max(0,5-attempts)
        });
      }
      await client.query('UPDATE otp_challenges SET consumed_at=NOW() WHERE challenge_id=$1',[challengeId]);
      await client.query('COMMIT');
      return res.json({ok:true,phoneVerified:true});
    }catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      throw e;
    }finally{client.release();}
  }

  function routes(app){
    const asyncRoute=security.asyncRoute || (fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next));
    app.post('/api/sms-gateway/jobs/claim',security.limiter('sms-gateway-claim',30),asyncRoute(requireGateway),asyncRoute(claim));
    app.post('/api/sms-gateway/jobs/:id/ack',security.limiter('sms-gateway-ack',120),asyncRoute(requireGateway),asyncRoute(ack));
    app.post('/api/auth/otp/request',security.limiter('otp-request-ip',8,10*60*1000),asyncRoute(requestOtp));
    app.post('/api/auth/otp/verify',security.limiter('otp-verify-ip',20,10*60*1000),asyncRoute(verifyOtp));
  }

  return {init,routes};
}

module.exports={createSmsOtp};
