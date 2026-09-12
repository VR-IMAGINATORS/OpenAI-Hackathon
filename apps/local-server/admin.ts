import express from 'express';
import QRCode from 'qrcode';
import { baseApp, errorResponse, finishApp } from '../../packages/server/http.js';
import { AdminAccess, PlayAccess, originGuard } from './play-session.js';

const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Call to Past / スマホで参加</title>
<style>body{background:#091819;color:#e5f5ef;font:17px system-ui;margin:0;padding:36px}main{max-width:660px;margin:auto}h1{font-size:36px}p{line-height:1.8;color:#bdd1ca}button,a.link{display:inline-block;background:#b6efcc;color:#12342a;border:0;border-radius:12px;padding:16px 22px;cursor:pointer;font:inherit;margin:8px 8px 8px 0}button.secondary{background:#29413c;color:#fff}img{width:280px;max-width:100%;border-radius:18px}#message{white-space:pre-wrap;color:#f4d49b}a{color:#b6efcc;word-break:break-all}small{color:#9cb7ad}#qr{display:none}</style>
<main><small>CALL TO PAST / PLAYTEST</small><h1>スマホから、未来へ。</h1><p>QRをスマホのカメラで読み取ってください。参加は1台まで。マイクを許可し、身近な物を撮影して未来の自分を助けましょう。</p><p id="message" role="status">準備しています…</p><div id="qr"><img id="image" alt="スマホ参加用QRコード"><p><a id="join" target="_blank" rel="noreferrer">このPCでプレイする</a></p><small id="expiry"></small></div><p><button id="invite">招待QRを再発行</button><button class="secondary" id="reset">プレイを終了してやり直す</button></p><p><small>生成画像・動画は後続開発です。まず音声と写真で遊びを試します。</small></p></main>
<script>
const message=document.getElementById('message');
async function request(path,body){const r=await fetch('/api/admin/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error?.message||'操作に失敗しました');return j;}
async function display(value){const box=document.getElementById('qr');if(!value){box.style.display='none';message.textContent='招待が使用済みか期限切れです。必要なら再発行してください。';return;}document.getElementById('image').src=value.qr;document.getElementById('join').href=value.url;document.getElementById('expiry').textContent='有効期限: '+new Date(value.expiresAt).toLocaleTimeString();box.style.display='block';message.textContent='準備できました。スマホでQRを読み取ってください。';}
async function run(fn){try{await fn()}catch(e){message.textContent=e.message;}}
document.getElementById('invite').onclick=()=>run(async()=>display(await request('invite',{})));
document.getElementById('reset').onclick=()=>run(async()=>{await request('reset',{});await display(await request('invite',{}));});
run(async()=>{const p=new URLSearchParams(location.hash.slice(1));const token=p.get('admin');history.replaceState(null,'',location.pathname);if(token)await request('claim',{token});await display(await request('invite'));});
</script></html>`;
export function createAdminApp(access: PlayAccess, port: number) {
  const admin = new AdminAccess();
  const app = baseApp();
  app.use(
    originGuard(
      new Set(['127.0.0.1:' + port, 'localhost:' + port]),
      new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]),
    ),
  );
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/', (_req, res) => res.type('html').send(html));
  app.use(express.json({ limit: '2kb', inflate: false }));
  app.post('/api/admin/claim', admin.claim);
  app.use('/api/admin', admin.authorize);
  const render = async (value: ReturnType<PlayAccess['currentInvite']>) =>
    value && { ...value, qr: await QRCode.toDataURL(value.url, { margin: 2, width: 320 }) };
  app.get('/api/admin/invite', async (_req, res) => {
    res.json(await render(access.currentInvite()));
  });
  app.post('/api/admin/invite', async (_req, res) => {
    await access.expire();
    try {
      res.json(await render(access.issue()));
    } catch (e) {
      errorResponse(
        res,
        e instanceof Error && e.message === 'PLAY_OCCUPIED' ? 409 : 503,
        'INVITE_UNAVAILABLE',
        'プレイ中は先に終了してください。接続準備中は少し待ってください。',
      );
    }
  });
  app.post('/api/admin/reset', async (_req, res) => {
    await access.clear();
    res.json({ ok: true });
  });
  finishApp(app);
  return { app, initialToken: admin.initialToken };
}
