/* Optional browser smoke test. PLAYWRIGHT_MODULE may point to an installed Playwright runtime.
   Run against Vite on PLAYTEST_URL (default http://127.0.0.1:5178).
   All /api responses and WebRTC/media devices are fake; no AI calls are made. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
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
    let capacityFull = false,
      createFailure = false,
      liveFailures = 0;
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
      automaticActions: true,
      generation: 0,
      status: 'briefing',
      title: '閉ざされた研究室',
      briefing:
        '未来の私は、研究室に閉じ込められている。身近な道具の写真と、あなたの声を届けてほしい。',
      obstacle: { title: '動かない扉', index: 0, count: 3 },
      situation: 'ドアノブが外れ、扉を引くことができない。代わりにつかめるものはないだろうか。',
      actionsRemaining: 4,
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
        state.inputRevision++;
        state.proposal = {
          revision: 1,
          inputRevision: state.inputRevision,
          items: [{ name: '吸盤フック', photoId: 'photo', inventoryId: null }],
          usage: '扉の平らな面に吸盤を付けて、取っ手にする。',
          summary: '吸盤の吸着力を使い、扉を手前に引く。',
        };
      }
      if (url.pathname === '/api/play/commands/poll') {
        return respond(route, {
          generation: state.generation,
          controlEpoch: epoch,
          acknowledgedThrough: body.ackThrough,
          commands: [
            {
              seq: 1,
              generation: state.generation,
              controllerEpoch: epoch,
              type: 'session.commentary.append',
              event_id: 'core-result',
              delegation_id: null,
              content: '扉が開いた！',
              messageId: 'message-1',
            },
          ],
        });
      }
      if (url.pathname === '/api/play/events') {
        state.transcript += body.event.delta || '';
        return respond(route, { accepted: true }, 202);
      }
      if (url.pathname === '/api/play/actions') {
        actionIds.push(body.actionId);
        if (failAction) {
          failAction = false;
          return route.abort('failed');
        }
        state.actionsRemaining--;
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
    await page.getByLabel('参加の合言葉').fill('demo');
    await page.getByRole('button', { name: '合言葉で参加' }).click();
    await page.getByRole('button', { name: '音声接続・体験開始' }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__sent.some((e) => e.event_id === 'core-result'));
    await page.getByRole('button', { name: /状況を聞いたら、プレイ開始/ }).click();
    await page.evaluate(() =>
      window.__emit({
        type: 'session.input_transcript.delta',
        event_id: 'speech-1',
        delta: 'これで扉を開けて',
        start_ms: 1000,
        end_ms: 2000,
      }),
    );
    await page.waitForTimeout(1700);
    assert.equal(state.transcript, 'これで扉を開けて');
    assert.equal(await page.locator('.commit-action').count(), 0);
    assert.equal(await page.getByRole('button', { name: /この内容で実行/ }).count(), 0);
    const sent = await page.evaluate(() =>
      window.__sent.filter((e) => e.event_id === 'core-result'),
    );
    assert.equal(sent.length, 1, 'replayed poll command sent only once');
    assert.deepEqual(
      Object.keys(sent[0]).sort(),
      ['type', 'event_id', 'delegation_id', 'content'].sort(),
      'strip internal outbox metadata',
    );
    assert.deepEqual(pageErrors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/core-p2-mobile.png', fullPage: true });
    console.log(
      'PASS: core automatic action UI, 202 events, ordered poll deduplication, provider payload, mobile layout. Fake API/media only.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
