/* Optional browser smoke test. PLAYWRIGHT_MODULE may point to an installed Playwright runtime.
   Run against Vite on PLAYTEST_URL (default http://127.0.0.1:5178).
   All /api responses and WebRTC/media devices are fake; no AI calls are made. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const artifactDir = process.env.SMOKE_ARTIFACT_DIR || `artifacts/smoke-${Date.now()}`;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    async function enterCall(english = false) {
      const begin = page.getByRole('button', {
        name: english
          ? 'Standard Pro Plan 5 min · 1,000 credits'
          : 'スタンダードProプラン 5分 · 1,000クレジット',
        exact: true,
      });
      const answer = page.getByRole('button', {
        name: english ? 'Answer' : '応答する',
        exact: true,
      });
      const skip = page.getByRole('button', { name: 'Skip', exact: true });
      const ready = begin.and(page.locator(':enabled'));
      await ready.or(answer).or(skip).first().waitFor();
      if (await ready.isVisible()) {
        await begin.click();
      }
      await skip.or(answer).first().waitFor();
      if (await skip.isVisible()) await skip.click();
      await page
        .getByRole('button', { name: english ? 'Answer' : '応答する', exact: true })
        .click();
    }
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__sent = [];
      navigator.mediaDevices.getUserMedia = async () => {
        if (window.__denyMic) throw new DOMException('denied', 'NotAllowedError');
        return {
          getTracks: () => [
            {
              stop() {
                window.__stopped = (window.__stopped || 0) + 1;
              },
            },
          ],
        };
      };
      HTMLMediaElement.prototype.play = async () => {};
      window.RTCPeerConnection = class extends EventTarget {
        iceGatheringState = 'complete';
        connectionState = 'new';
        localDescription = null;
        addTrack() {}
        createDataChannel(name) {
          if (name !== 'oai-events') throw new Error('Wrong Live data channel');
          const channel = {
            readyState: 'open',
            send: (value) => window.__sent.push(JSON.parse(value)),
            close() {
              this.readyState = 'closed';
            },
            onmessage: null,
          };
          window.__emit = (event) => channel.onmessage?.({ data: JSON.stringify(event) });
          return channel;
        }
        async createOffer() {
          return { type: 'offer', sdp: 'fake-offer' };
        }
        async setLocalDescription(value) {
          this.localDescription = value;
        }
        async setRemoteDescription() {
          this.connectionState = 'connected';
          window.__emit({ type: 'session.started' });
        }
        close() {
          this.connectionState = 'closed';
        }
      };
    });
    let capacityFull = true,
      createFailure = true,
      liveFailures = 2;
    const createIds = [],
      liveIds = [];
    let owner = false;
    let hasPlay = false,
      creates = 0,
      epoch = 1,
      controller = null,
      failPhoto = true;
    const photoIds = [];
    const envelope = () => ({
      state,
      lifecycle: state.status === 'expired' ? 'terminal' : 'active',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      recoveryExpiresAt: null,
    });
    let failAction = true;
    const actionIds = [];
    let state = {
      id: 'test',
      locale: 'ja',
      generation: 0,
      status: 'briefing',
      title: '閉ざされた研究室',
      briefing:
        '未来の私は、研究室に閉じ込められている。身近な道具の写真と、あなたの声を届けてほしい。',
      obstacle: { title: '動かない扉', index: 0, count: 3 },
      situation: 'ドアノブが外れ、扉を引くことができない。代わりにつかめるものはないだろうか。',
      creditsRemaining: 1000,
      initialCredits: 1000,
      lastCreditCharge: null,
      actionsUsed: 0,
      remainingMs: 300000,
      waitingRemainingMs: 60000,
      paused: false,
      maxPhotos: 2,
      photoCount: 0,
      inventory: [],
      proposal: null,
      inputRevision: 0,
      busy: false,
      voiceState: 'closed',
      transcript: '',
      lastResult: null,
      error: null,
    };
    const respond = (route, body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const body = route.request().postDataJSON();
      if (url.pathname === '/api/bootstrap')
        return respond(route, {
          app: { stage: 'hosted-multiplayer', name: 'Call to Past' },
          auth: { required: true },
          ai: { mode: 'live' },
        });
      if (url.pathname === '/api/auth') {
        assert.equal(body.passphrase, 'demo');
        owner = true;
        return respond(route, { ok: true });
      }
      if (!owner) return respond(route, { error: { message: 'No owner' } }, 401);
      if (url.pathname === '/api/session')
        return respond(route, {
          authenticated: true,
          playId: hasPlay ? 'play-one' : null,
          lifecycle: hasPlay ? 'active' : null,
          expiresAt: null,
        });
      if (url.pathname === '/api/plays') {
        if (capacityFull)
          return respond(
            route,
            {
              error: {
                code: 'PLAY_CAPACITY',
                message: '現在満員です。少し待って再試行してください。',
              },
            },
            409,
          );
        createIds.push(body.requestId);
        if (createFailure) {
          createFailure = false;
          return route.abort('failed');
        }
        creates++;
        hasPlay = true;
        controller = body.clientId;
        return respond(route, { ...envelope(), playId: 'play-one', controlEpoch: epoch }, 201);
      }
      if (url.pathname === '/api/play/ending') {
        assert.equal(url.searchParams.get('playId'), 'play-one');
        return respond(route, { error: { code: 'ENDING_NOT_FOUND' } }, 404);
      }
      assert.equal(route.request().headers()['x-play-id'], 'play-one');
      if (url.pathname === '/api/play/control') {
        assert.equal(body.takeover, true);
        controller = body.clientId;
        epoch++;
        return respond(route, { ...envelope(), controlEpoch: epoch });
      }
      if (route.request().method() !== 'GET') {
        if (route.request().headers()['x-client-id'] !== controller)
          return respond(
            route,
            { error: { code: 'CONTROL_BUSY', message: '別の画面で接続中です。' } },
            409,
          );
        assert.equal(route.request().headers()['x-client-id'], controller);
        assert.equal(route.request().headers()['x-control-epoch'], String(epoch));
      }
      if (url.pathname === '/api/play/live') {
        assert.ok(body.requestId);
        liveIds.push(body.requestId);
        if (liveFailures-- > 0) return route.abort('failed');
        assert.equal(body.passphrase, undefined);
        assert.equal(body.sdp, 'fake-offer');
        state.generation++;
        return respond(
          route,
          {
            sdp: 'fake-answer',
            generation: state.generation,
            opening:
              state.generation > 1
                ? null
                : {
                    type: 'session.commentary.append',
                    event_id: 'opening-' + state.generation,
                    delegation_id: null,
                    content: '聞こえる…？ 返事をしてくれる？',
                  },
          },
          201,
        );
      }
      if (url.pathname === '/api/play/heartbeat') {
        state.voiceState = body.voiceState;
      }
      if (url.pathname === '/api/play/start') state.status = 'playing';
      if (url.pathname === '/api/play/photos') {
        photoIds.push(body.requestId);
        if (failPhoto) {
          failPhoto = false;
          return route.abort('failed');
        }
        assert.ok(body.images[0].startsWith('/9j/'), 'Canvas emits JPEG base64');
        state.photoCount = body.images.length;
        if (body.images.length) {
          state.creditsRemaining -= body.images.length * 100;
          state.lastCreditCharge = {
            sequence: (state.lastCreditCharge?.sequence ?? 0) + 1,
            kind: 'photo',
            amount: body.images.length * 100,
          };
        }
        state.inputRevision++;
        state.proposal = {
          revision: 1,
          inputRevision: state.inputRevision,
          items: [{ name: '吸盤フック', photoId: 'photo', inventoryId: null }],
          usage: '扉の平らな面に吸盤を付けて、取っ手にする。',
          summary: '吸盤の吸着力を使い、扉を手前に引く。',
        };
      }
      if (url.pathname === '/api/play/events') {
        state.transcript += body.event.delta || '';
        return respond(route, { ...envelope(), commands: [] });
      }
      if (url.pathname === '/api/play/actions') {
        actionIds.push(body.actionId);
        if (failAction) {
          failAction = false;
          return route.abort('failed');
        }
        state.actionsUsed++;
        state.obstacle.index++;
        state.proposal = null;
        state.photoCount = 0;
        state.lastResult = {
          success: true,
          narrative: '吸盤はしっかり張りついた。扉を開けて、次の部屋へ進めた！',
        };
        return respond(route, {
          ...envelope(),
          commands: [
            {
              type: 'session.commentary.append',
              event_id: 'result',
              delegation_id: null,
              content: '扉が開いた！',
            },
          ],
        });
      }
      if (url.pathname === '/api/play/end') state.status = 'expired';
      return respond(route, { ...envelope(), commands: [] });
    });
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:5178');
    await page.getByRole('combobox').selectOption('ja');
    await page.getByLabel('参加の合言葉').fill('demo');
    await page.getByRole('button', { name: 'スタンダードProプラン 5分 · 1,000クレジット' }).click();
    await page.evaluate(() => (window.__denyMic = true));
    await enterCall();
    await page.getByRole('alert').filter({ hasText: 'マイクを許可' }).waitFor();
    assert.equal(createIds.length, 0, 'microphone refusal does not reserve');
    await page.evaluate(() => (window.__denyMic = false));
    await enterCall();
    await page.getByRole('alert').filter({ hasText: '現在満員' }).waitFor();
    assert.equal(liveIds.length, 0, 'full server does not create Live');
    capacityFull = false;
    await enterCall();
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).click();
    assert.equal(createIds[0], createIds[1], 'unknown create retains request ID');
    assert.equal(liveIds[0], liveIds[1]);
    assert.equal(liveIds[1], liveIds[2], 'manual Live retry keeps request ID');
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      window.__sent.some((event) => event.event_id.startsWith('opening-')),
    );
    assert.equal(state.status, 'briefing');
    assert.equal(state.remainingMs, 300000, 'tutorial does not start the clock');
    assert.equal(
      await page
        .locator('.opening-scene img')
        .evaluate((img) => img.complete && img.naturalWidth > 0),
      true,
    );
    assert.equal(await page.getByRole('button', { name: '撮影', exact: true }).isEnabled(), true);
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: `${artifactDir}/mobile-tutorial.png`, fullPage: true });

    await page.evaluate(() => window.__emit({ type: 'session.closed' }));
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).waitFor();
    await page.getByRole('button', { name: '音声を接続 / 再開する' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    assert.equal(state.status, 'briefing', 'reconnect must not end the play');
    assert.equal(state.generation, 2);
    await page.waitForTimeout(1800);
    assert.equal(
      (await page.evaluate(() => window.__sent)).filter((event) =>
        event.event_id.startsWith('opening-'),
      ).length,
      1,
      'reconnect does not repeat greeting',
    );
    await page.reload();
    await page.getByRole('button', { name: 'この画面で再接続' }).waitFor();
    assert.notEqual(
      state.status,
      'expired',
      'reload must preserve the play within recovery budget',
    );
    await page.getByRole('button', { name: 'この画面で再接続' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForTimeout(1800);
    assert.equal(
      (await page.evaluate(() => window.__sent)).filter((event) =>
        event.event_id.startsWith('opening-'),
      ).length,
      0,
      'reload does not repeat greeting',
    );
    const stoppedBefore = await page.evaluate(() => window.__stopped || 0);
    controller = 'another-tab';
    await page.evaluate(() =>
      window.__emit({
        type: 'session.input_transcript.delta',
        event_id: 'old-controller',
        delta: 'test',
        start_ms: 0,
        end_ms: 1,
      }),
    );
    await page.getByRole('button', { name: 'この画面で再接続' }).waitFor();
    assert.ok(
      (await page.evaluate(() => window.__stopped || 0)) > stoppedBefore,
      'lost controller closes microphone',
    );
    await page.getByRole('button', { name: 'この画面で再接続' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.photo-button').disabled);
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=',
      'base64',
    );
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: tinyPng });
    await page.getByRole('button', { name: '写真の送信を再試行' }).click();
    assert.equal(photoIds[0], photoIds[1]);
    await page.getByRole('heading', { name: '吸盤フック' }).waitFor();
    assert.equal(state.status, 'briefing', 'can photograph before starting');
    assert.equal(state.remainingMs, 300000);
    await page.getByRole('button', { name: /状況を聞いたら/ }).click();
    await page.getByRole('button', { name: 'この使い方で実行' }).waitFor();
    await page.evaluate(() =>
      window.__emit({
        type: 'session.input_transcript.delta',
        event_id: 'voice1',
        delta: '吸盤で扉を引こう',
        start_ms: 0,
        end_ms: 1000,
      }),
    );
    await page.getByText('あなたの声をこう聞き取りました').waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const buttons = await page
      .locator('.play-actions button')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    assert.ok(buttons.every((height) => height >= 44));
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: `${artifactDir}/mobile-playtest-390.png`, fullPage: true });
    await page.getByRole('button', { name: 'この使い方で実行' }).click();
    await page.getByRole('button', { name: '結果を再確認' }).waitFor();
    await page.getByRole('button', { name: '結果を再確認' }).click();
    await page.getByText('吸盤はしっかり張りついた。扉を開けて、次の部屋へ進めた！').waitFor();
    assert.equal(actionIds.length, 2);
    assert.equal(actionIds[0], actionIds[1], 'unknown transport result reuses action ID');
    assert.equal(state.creditsRemaining, 900);
    assert.ok(
      (await page.evaluate(() => window.__sent)).some(
        (event) => event.type === 'session.commentary.append',
      ),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `${artifactDir}/mobile-playtest-desktop.png`, fullPage: true });
    await page.getByRole('button', { name: 'プレイを終了', exact: true }).click();
    await page.getByRole('heading', { name: '接続を終了しました' }).waitFor();
    assert.equal(creates, 1, 'reload does not reserve another slot');
    await page.getByRole('button', { name: 'もう一度プレイ' }).waitFor();
    owner = false;
    await page.reload();
    await page
      .getByRole('button', { name: 'Standard Pro Plan 5 min · 1,000 credits', exact: true })
      .waitFor();
    assert.deepEqual(pageErrors, []);
    console.log(
      'PASS: fake Live connect/reconnect/reload, passphrase authentication, control takeover, same-ID photo retry, start, JPEG upload, voice transcript, action retry idempotency, mobile/desktop layout, explicit end. No real API or physical device verification.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
