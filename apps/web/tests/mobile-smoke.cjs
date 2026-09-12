/* Optional browser smoke test. PLAYWRIGHT_MODULE may point to an installed Playwright runtime.
   Run against Vite on PLAYTEST_URL (default http://127.0.0.1:5178).
   All /api responses and WebRTC/media devices are fake; no AI calls are made. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__sent = [];
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      HTMLMediaElement.prototype.play = async () => {};
      window.RTCPeerConnection = class extends EventTarget {
        iceGatheringState = 'complete'; connectionState = 'new'; localDescription = null;
        addTrack() {}
        createDataChannel(name) {
          if (name !== 'oai-events') throw new Error('Wrong Live data channel');
          const channel = { readyState: 'open', send: value => window.__sent.push(JSON.parse(value)), close() { this.readyState = 'closed'; }, onmessage: null };
          window.__emit = event => channel.onmessage?.({ data: JSON.stringify(event) });
          return channel;
        }
        async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
        async setLocalDescription(value) { this.localDescription = value; }
        async setRemoteDescription() { this.connectionState = 'connected'; window.__emit({ type: 'session.started' }); }
        close() { this.connectionState = 'closed'; }
      };
    });
    let owner = false;
    let failAction = true;
    const actionIds = [];
    let state = {
      id: 'test', generation: 0, status: 'briefing', title: '閉ざされた研究室', briefing: '未来の私は、研究室に閉じ込められている。身近な道具の写真と、あなたの声を届けてほしい。',
      obstacle: { title: '動かない扉', index: 0, count: 3 }, situation: 'ドアノブが外れ、扉を引くことができない。代わりにつかめるものはないだろうか。',
      actionsRemaining: 4, remainingMs: 300000, waitingRemainingMs: 60000, paused: false,
      maxPhotos: 2, photoCount: 0, inventory: [], proposal: null, inputRevision: 0, busy: false, voiceState: 'closed', transcript: '', lastResult: null, error: null,
    };
    const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const body = route.request().postDataJSON();
      if (url.pathname === '/api/bootstrap') return respond(route, { app: { stage: 'mobile-playtest', name: 'Call to Past' }, relay: { authMode: 'required', mode: 'live', reachable: true } });
      if (url.pathname === '/api/play/claim') { assert.equal(body.invite, 'a'.repeat(64)); owner = true; return respond(route, { ok: true }); }
      if (!owner) return respond(route, { error: { message: 'No owner' } }, 401);
      if (url.pathname === '/api/play/live') { assert.equal(body.passphrase, 'demo'); assert.equal(body.sdp, 'fake-offer'); state.generation++; return respond(route, { sdp: 'fake-answer', generation: state.generation, opening: {type:'session.commentary.append', event_id:'opening-'+state.generation, delegation_id:null, content:'聞こえる…？ 返事をしてくれる？'} }, 201); }
      if (url.pathname === '/api/play/heartbeat') { state.voiceState = body.voiceState; if (body.voiceState === 'closed') state.status = 'expired'; }
      if (url.pathname === '/api/play/start') state.status = 'playing';
      if (url.pathname === '/api/play/photos') {
        assert.ok(body.images[0].startsWith('/9j/'), 'Canvas emits JPEG base64');
        state.photoCount = body.images.length; state.inputRevision++;
        state.proposal = { revision: 1, inputRevision: state.inputRevision, items: [{ name: '吸盤フック', photoId: 'photo', inventoryId: null }], usage: '扉の平らな面に吸盤を付けて、取っ手にする。', summary: '吸盤の吸着力を使い、扉を手前に引く。' };
      }
      if (url.pathname === '/api/play/events') { state.transcript += body.event.delta || ''; return respond(route, { state, commands: [] }); }
      if (url.pathname === '/api/play/actions') {
        actionIds.push(body.actionId);
        if (failAction) { failAction = false; return route.abort('failed'); }
        state.actionsRemaining--; state.obstacle.index++; state.proposal = null; state.photoCount = 0;
        state.lastResult = { success: true, narrative: '吸盤はしっかり張りついた。扉を開けて、次の部屋へ進めた！' };
        return respond(route, { state, commands: [{ type: 'session.commentary.append', event_id: 'result', delegation_id: null, content: '扉が開いた！' }] });
      }
      if (url.pathname === '/api/play/end') state.status = 'expired';
      return respond(route, state);
    });
    await page.goto((process.env.PLAYTEST_URL || 'http://127.0.0.1:5178') + '/#invite=' + 'a'.repeat(64));
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).waitFor();
    assert.equal(new URL(page.url()).hash, '', 'invite removed');
    await page.getByLabel('接続用の合言葉').fill('demo');
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__sent.some(event => event.event_id.startsWith('opening-')));
    assert.equal(state.status, 'briefing');
    assert.equal(state.remainingMs, 300000, 'tutorial does not start the clock');
    assert.equal(await page.locator('.opening-scene img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.getByRole('button', { name: '撮影', exact: true }).isEnabled(), true);
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({path:'artifacts/mobile-tutorial.png',fullPage:true});

    await page.evaluate(() => window.__emit({ type: 'session.closed' }));
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).waitFor();
    await page.getByLabel('接続用の合言葉').fill('demo');
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    assert.equal(state.status, 'briefing', 'reconnect must not end the play');
    assert.equal(state.generation, 2);
    await page.waitForTimeout(1800);
    assert.equal((await page.evaluate(() => window.__sent)).filter(event=>event.event_id.startsWith('opening-')).length,1,'reconnect does not repeat greeting');
    await page.reload();
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).waitFor();
    assert.notEqual(state.status, 'expired', 'reload must preserve the play within recovery budget');
    await page.getByLabel('接続用の合言葉').fill('demo');
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForTimeout(1800);
    assert.equal((await page.evaluate(() => window.__sent)).filter(event=>event.event_id.startsWith('opening-')).length,0,'reload does not repeat greeting');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: tinyPng });
    await page.getByRole('heading', { name: '吸盤フック' }).waitFor();
    assert.equal(state.status,'briefing','can photograph before starting');
    assert.equal(state.remainingMs,300000);
    await page.getByRole('button', { name: /状況を聞いたら/ }).click();
    await page.getByRole('button', { name: 'この使い方で実行' }).waitFor();
    await page.evaluate(() => window.__emit({ type: 'session.input_transcript.delta', event_id: 'voice1', delta: '吸盤で扉を引こう', start_ms: 0, end_ms: 1000 }));
    await page.getByText('あなたの声をこう聞き取りました').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const buttons = await page.locator('.play-actions button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.ok(buttons.every(height => height >= 44));
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/mobile-playtest-390.png', fullPage: true });
    await page.getByRole('button', { name: 'この使い方で実行' }).click();
    await page.getByRole('button', { name: '結果を再確認' }).waitFor();
    await page.getByRole('button', { name: '結果を再確認' }).click();
    await page.getByText('吸盤はしっかり張りついた。扉を開けて、次の部屋へ進めた！').waitFor();
    assert.equal(actionIds.length, 2);
    assert.equal(actionIds[0], actionIds[1], 'unknown transport result reuses action ID');
    assert.equal(state.actionsRemaining, 3);
    assert.ok((await page.evaluate(() => window.__sent)).some(event => event.type === 'session.commentary.append'));
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'artifacts/mobile-playtest-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'プレイを終了', exact: true }).click();
    await page.getByRole('heading', { name: '接続を終了しました' }).waitFor();
    assert.deepEqual(pageErrors, []);
    console.log('PASS: fake Live connect/reconnect/reload, invite removal, start, JPEG upload, voice transcript, action retry idempotency, mobile/desktop layout, explicit end. No real API or physical device verification.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });