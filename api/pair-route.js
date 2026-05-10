// ============================================================
//  APEX-MD · Web Pairing Route  (QR + Pairing Code)
//  Mounted at /pair  (no auth needed)
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const pino     = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { encodeSession } = require('../lib/session');

// ── Shared state ──────────────────────────────────────────────
let S = { status:'idle', mode:null, qrData:null, code:null, sessionId:null, error:null, sock:null, dir:null };

function reset() {
  if (S.sock)  { try { S.sock.end(); } catch(_){} }
  if (S.dir)   { try { fs.rmSync(S.dir,{recursive:true,force:true}); } catch(_){} }
  S = { status:'idle', mode:null, qrData:null, code:null, sessionId:null, error:null, sock:null, dir:null };
}

async function mkSock(dir) {
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version }          = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({level:'silent'})) },
    printQRInTerminal: false,
    logger: pino({level:'silent'}),
    browser: ['APEX-MD','Chrome','120.0.0'],
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

async function handleOpen(dir) {
  await new Promise(r => setTimeout(r, 2500));
  S.sessionId = encodeSession(dir);
  S.status    = 'paired';
  try { fs.rmSync(dir,{recursive:true,force:true}); } catch(_){}
}

// ════════════════════════════════════════════════════════════
//  GET /pair  — full HTML page (QR + Pairing Code tabs)
// ════════════════════════════════════════════════════════════
router.get('/', (_req, res) => {
  res.setHeader('Content-Type','text/html');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>APEX-MD · Pair</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#141414;border:1px solid #222;border-radius:16px;padding:36px;width:100%;max-width:480px;text-align:center}
.logo{font-size:2.2rem;margin-bottom:6px}
h1{font-size:1.35rem;font-weight:700;color:#fff;margin-bottom:4px}
.sub{font-size:.85rem;color:#555;margin-bottom:26px}
.tabs{display:flex;gap:8px;margin-bottom:22px}
.tab{flex:1;padding:11px;border-radius:10px;border:1px solid #222;background:#1a1a1a;color:#555;font-size:.88rem;font-weight:600;cursor:pointer;transition:all .2s}
.tab.active{background:#25D366;color:#000;border-color:#25D366}
.panel{display:none}.panel.active{display:block}
.lbl{font-size:.72rem;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:7px;text-align:left}
input{width:100%;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:12px 15px;color:#fff;font-size:.95rem;outline:none;transition:border .2s}
input:focus{border-color:#25D366}
input::placeholder{color:#3a3a3a}
.btn{width:100%;background:#25D366;color:#000;border:none;border-radius:8px;padding:13px;font-size:.95rem;font-weight:700;cursor:pointer;margin-top:13px;transition:background .2s}
.btn:hover{background:#1db954}.btn:disabled{background:#222;color:#555;cursor:not-allowed}
.btn-ghost{background:transparent;border:1px solid #2a2a2a;color:#555;margin-top:8px}
.btn-ghost:hover{border-color:#444;color:#888;background:transparent}

/* QR */
.qr-box{display:none;margin-top:18px;text-align:center}
.qr-box .ql{font-size:.75rem;color:#25D366;font-weight:600;margin-bottom:10px}
#qrEl{display:inline-flex;align-items:center;justify-content:center;background:#fff;border-radius:10px;padding:14px}
.qr-hint{font-size:.75rem;color:#555;margin-top:8px}
.qr-exp{font-size:.72rem;color:#f59e0b;margin-top:5px;min-height:16px}

/* Code */
.code-box{display:none;margin-top:18px;background:#0f0f0f;border:2px solid #25D366;border-radius:12px;padding:20px}
.code-box .cl{font-size:.72rem;color:#25D366;font-weight:600;margin-bottom:8px}
.code-num{font-size:2.3rem;font-weight:900;letter-spacing:10px;color:#fff;font-family:monospace}
.code-hint{font-size:.75rem;color:#555;margin-top:9px;line-height:1.65}

/* Session */
.sess-box{display:none;margin-top:18px;background:#091509;border:2px solid #25D366;border-radius:12px;padding:20px;text-align:left}
.sess-box .sl{font-size:.8rem;color:#25D366;font-weight:700;margin-bottom:9px}
textarea{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:7px;padding:9px;color:#777;font-size:.65rem;font-family:monospace;resize:none;height:72px;outline:none}
.cp-btn{width:100%;background:#25D366;color:#000;border:none;border-radius:7px;padding:10px;font-weight:700;cursor:pointer;margin-top:9px;font-size:.88rem}
.cp-btn:hover{background:#1db954}
.steps{font-size:.73rem;color:#3a3a3a;margin-top:9px;line-height:1.75}
.steps b{color:#555}

.st{font-size:.82rem;color:#555;margin-top:12px;min-height:18px}
.st.g{color:#25D366}.st.r{color:#f87171}.st.y{color:#f59e0b}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #333;border-top-color:#25D366;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:5px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>APEX-MD · Pair Your Bot</h1>
  <p class="sub">Get your SESSION_ID in seconds</p>

  <div class="tabs">
    <div class="tab active" id="t-qr"   onclick="sw('qr')">📷 QR Code</div>
    <div class="tab"        id="t-code" onclick="sw('code')">🔑 Pairing Code</div>
  </div>

  <!-- QR panel -->
  <div class="panel active" id="p-qr">
    <p style="font-size:.82rem;color:#555;margin-bottom:14px">Click to generate a QR code,<br>then scan it with WhatsApp.</p>
    <button class="btn" id="qrBtn" onclick="startQR()">Generate QR Code</button>
    <div class="qr-box" id="qrBox">
      <div class="ql">WhatsApp → Linked Devices → Link a Device → scan</div>
      <div id="qrEl"></div>
      <div class="qr-hint">QR refreshes automatically</div>
      <div class="qr-exp" id="qrExp"></div>
    </div>
  </div>

  <!-- Code panel -->
  <div class="panel" id="p-code">
    <div class="lbl">Your WhatsApp number</div>
    <input id="numIn" type="tel" placeholder="2348012345678  (no + sign)" maxlength="20"/>
    <button class="btn" id="codeBtn" onclick="doCode()">Get Pairing Code</button>
    <div class="code-box" id="codeBox">
      <div class="cl">YOUR PAIRING CODE</div>
      <div class="code-num" id="codeNum">----</div>
      <div class="code-hint">WhatsApp → ⋮ Menu → Linked Devices → Link a Device<br>→ <b>"Link with phone number instead"</b> → enter code</div>
    </div>
  </div>

  <!-- Session result (shared) -->
  <div class="sess-box" id="sessBox">
    <div class="sl">✅ Paired! Your SESSION_ID:</div>
    <textarea id="sessText" readonly></textarea>
    <button class="cp-btn" onclick="cp()">📋 Copy SESSION_ID</button>
    <div class="steps">
      <b>Next:</b> Render → apex-md-api → <b>Environment</b><br>
      → set <b>SESSION_ID</b> = paste → <b>Save Changes</b><br>
      → auto-redeploys → bot is live ⚡
    </div>
  </div>

  <div class="st" id="st"></div>
  <button class="btn btn-ghost" id="rstBtn" onclick="rst()" style="display:none">↺ Start Over</button>
</div>

<script>
let poll=null, qrTimer=null, qrObj=null, qrExp=0;

function st(m,c){const e=document.getElementById('st');e.innerHTML=m;e.className='st '+(c||'');}
function show(id){document.getElementById(id).style.display='block';}
function hide(id){document.getElementById(id).style.display='none';}

function sw(t){
  ['qr','code'].forEach(x=>{
    document.getElementById('t-'+x).classList.toggle('active',x===t);
    document.getElementById('p-'+x).classList.toggle('active',x===t);
  });
  rst(true);
}

async function rst(silent){
  clearInterval(poll);clearInterval(qrTimer);poll=qrTimer=null;
  if(!silent) await fetch('/pair/reset',{method:'POST'}).catch(()=>{});
  ['qrBox','codeBox','sessBox'].forEach(hide);
  document.getElementById('qrEl').innerHTML='';
  if(qrObj){try{qrObj.clear();}catch(_){}qrObj=null;}
  document.getElementById('qrBtn').disabled=false;
  document.getElementById('qrBtn').textContent='Generate QR Code';
  document.getElementById('codeBtn').disabled=false;
  document.getElementById('codeBtn').textContent='Get Pairing Code';
  hide('rstBtn'); st('');
}

function renderQR(data){
  const el=document.getElementById('qrEl');
  el.innerHTML='';
  qrObj=new QRCode(el,{text:data,width:210,height:210,colorDark:'#000',colorLight:'#fff',correctLevel:QRCode.CorrectLevel.M});
  clearInterval(qrTimer);
  qrExp=Date.now()+60000;
  qrTimer=setInterval(()=>{
    const s=Math.max(0,Math.round((qrExp-Date.now())/1000));
    document.getElementById('qrExp').textContent=s>0?'Expires in '+s+'s':'Refreshing...';
  },1000);
}

function startPoll(){
  poll=setInterval(async()=>{
    try{
      const d=await(await fetch('/pair/status')).json();
      if(d.status==='paired'&&d.sessionId){
        clearInterval(poll);clearInterval(qrTimer);
        document.getElementById('sessText').value=d.sessionId;
        show('sessBox'); hide('qrBox'); hide('codeBox');
        show('rstBtn');
        st('✅ Bot paired successfully!','g');
      } else if(d.status==='error'){
        clearInterval(poll);clearInterval(qrTimer);
        st('❌ '+(d.error||'Error'),'r');
        document.getElementById('qrBtn').disabled=false;
        document.getElementById('codeBtn').disabled=false;
        show('rstBtn');
      } else if(d.qrData){
        renderQR(d.qrData);
      }
    }catch(_){}
  },2000);
}

async function startQR(){
  document.getElementById('qrBtn').disabled=true;
  document.getElementById('qrBtn').innerHTML='<span class="spin"></span>Connecting...';
  st('<span class="spin"></span>Starting connection...','y');
  try{
    const d=await(await fetch('/pair/qr',{method:'POST'})).json();
    if(!d.ok){st('❌ '+d.error,'r');document.getElementById('qrBtn').disabled=false;return;}
    show('qrBox');
    if(d.qrData) renderQR(d.qrData);
    st('<span class="spin"></span>Waiting for scan...','y');
    startPoll();
  }catch(e){st('❌ '+e.message,'r');document.getElementById('qrBtn').disabled=false;}
}

async function doCode(){
  const num=document.getElementById('numIn').value.replace(/[^0-9]/g,'');
  if(!num||num.length<10){st('Enter a valid number','r');return;}
  document.getElementById('codeBtn').disabled=true;
  document.getElementById('codeBtn').innerHTML='<span class="spin"></span>Requesting...';
  st('<span class="spin"></span>Getting code...','y');
  try{
    const d=await(await fetch('/pair/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:num})})).json();
    if(!d.ok){st('❌ '+d.error,'r');document.getElementById('codeBtn').disabled=false;return;}
    document.getElementById('codeNum').textContent=d.code;
    show('codeBox');
    st('<span class="spin"></span>Waiting for you to enter the code...','y');
    startPoll();
  }catch(e){st('❌ '+e.message,'r');document.getElementById('codeBtn').disabled=false;}
}

function cp(){
  navigator.clipboard.writeText(document.getElementById('sessText').value).then(()=>{
    const b=document.querySelector('.cp-btn');
    b.textContent='✅ Copied!';
    setTimeout(()=>b.textContent='📋 Copy SESSION_ID',2500);
  });
}
</script>
</body>
</html>`);
});

// ════════════════════════════════════════════════════════════
//  POST /pair/qr
// ════════════════════════════════════════════════════════════
router.post('/qr', async (_req, res) => {
  reset(); S.status='waiting'; S.mode='qr';
  const dir = '/tmp/apex-pair-' + Date.now();
  fs.mkdirSync(dir,{recursive:true}); S.dir=dir;
  try {
    const sock = await mkSock(dir); S.sock=sock;
    const firstQR = await new Promise((resolve,reject) => {
      const t = setTimeout(()=>reject(new Error('QR timeout')),20000);
      sock.ev.on('connection.update', async u => {
        const {connection,qr,lastDisconnect} = u;
        if (qr) {
          S.qrData=qr;
          if (!S._gotFirstQR) { S._gotFirstQR=true; clearTimeout(t); resolve(qr); }
        }
        if (connection==='open') await handleOpen(dir);
        if (connection==='close') {
          const c=lastDisconnect?.error?.output?.statusCode;
          if (S.status!=='paired') { S.status='error'; S.error='Disconnected ('+c+')'; }
        }
      });
    });
    res.json({ok:true,qrData:firstQR});
  } catch(err) {
    S.status='error'; S.error=err.message;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch(_){}
    res.json({ok:false,error:err.message});
  }
});

// ════════════════════════════════════════════════════════════
//  POST /pair/request
// ════════════════════════════════════════════════════════════
router.post('/request', async (req,res) => {
  const {number} = req.body;
  if (!number) return res.json({ok:false,error:'number required'});
  reset(); S.status='waiting'; S.mode='code';
  const dir = '/tmp/apex-pair-' + Date.now();
  fs.mkdirSync(dir,{recursive:true}); S.dir=dir;
  try {
    const sock = await mkSock(dir); S.sock=sock;
    const code = await new Promise((resolve,reject) => {
      const t = setTimeout(()=>reject(new Error('Timeout')),20000);
      sock.ev.on('connection.update', async u => {
        const {connection,qr,lastDisconnect} = u;
        if ((qr||connection==='connecting') && !sock.authState.creds.registered) {
          clearTimeout(t);
          try {
            await new Promise(r=>setTimeout(r,2500));
            const raw = await sock.requestPairingCode(String(number).replace(/[^0-9]/g,''));
            const fmt = raw?.match(/.{1,4}/g)?.join('-') || raw;
            S.code=fmt; resolve(fmt);
          } catch(e) { reject(e); }
        }
        if (connection==='open') await handleOpen(dir);
        if (connection==='close') {
          const c=lastDisconnect?.error?.output?.statusCode;
          if (S.status!=='paired') { S.status='error'; S.error='Disconnected ('+c+')'; }
        }
      });
    });
    res.json({ok:true,code});
  } catch(err) {
    S.status='error'; S.error=err.message;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch(_){}
    res.json({ok:false,error:err.message});
  }
});

// ════════════════════════════════════════════════════════════
//  GET /pair/status
// ════════════════════════════════════════════════════════════
router.get('/status', (_req,res) => {
  res.json({status:S.status, sessionId:S.sessionId, qrData:S.qrData, error:S.error});
});

// ════════════════════════════════════════════════════════════
//  POST /pair/reset
// ════════════════════════════════════════════════════════════
router.post('/reset', (_req,res) => { reset(); res.json({ok:true}); });

module.exports = router;
