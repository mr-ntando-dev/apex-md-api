// ============================================================
//  APEX-MD API  ·  api/pair-route.js
//
//  The API is stateless — it has no Baileys socket and cannot
//  generate QR codes or pairing codes directly.
//
//  Pairing is done through the BOT repo (apex-md-bot).
//  This route serves a helpful redirect page explaining that.
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>APEX-MD · Pairing</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0d0d0d;color:#f0f0f0;min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;
        padding:40px 32px;max-width:480px;width:100%;text-align:center}
  .logo{font-size:3rem;margin-bottom:12px}
  h1{font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:8px}
  .sub{font-size:.9rem;color:#888;margin-bottom:28px}
  .badge{display:inline-block;background:#2a2a2a;border-radius:8px;
         padding:16px 20px;margin-bottom:24px;font-size:.85rem;color:#aaa;text-align:left;width:100%}
  .badge b{color:#f0f0f0}
  .link{display:block;margin-top:20px;padding:12px 24px;background:#25d366;
        color:#000;border-radius:8px;text-decoration:none;font-weight:600;font-size:.95rem}
  .link:hover{background:#1ebe5d}
  code{background:#0d0d0d;border-radius:4px;padding:2px 6px;font-size:.82rem;color:#25d366}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>APEX-MD Pairing</h1>
  <p class="sub">This is the stateless REST API service.</p>
  <div class="badge">
    <p style="margin-bottom:10px">Pairing (QR code / pairing code) is handled by the <b>bot</b>, not the API.</p>
    <p>The bot runs on your <b>panel or VPS</b>.</p>
    <p style="margin-top:10px">To pair:</p>
    <ol style="margin-top:8px;padding-left:18px;line-height:1.8">
      <li>Clone <code>apex-md-bot</code> on your panel</li>
      <li>Set your <code>.env</code> variables</li>
      <li>Run <code>npm start</code> and scan the QR code</li>
    </ol>
  </div>
  <a class="link" href="https://github.com/mr-ntando-dev/apex-md-bot" target="_blank">
    → Go to apex-md-bot on GitHub
  </a>
</div>
</body>
</html>`);
});

module.exports = router;
