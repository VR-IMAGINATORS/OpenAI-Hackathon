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
    async function enterCall(english = false) {
      const begin = page.getByRole('button', {
        name: english ? 'Begin experience' : '体験を始める',
        exact: true,
      });
      const answer = page.getByRole('button', {
        name: english ? 'Answer' : '応答する',
        exact: true,
      });
      await begin.or(answer).first().waitFor();
      if (await begin.isVisible()) {
        await begin.click();
        await page.getByRole('button', { name: 'Skip', exact: true }).click();
      }
      await page
        .getByRole('button', { name: english ? 'Answer' : '応答する', exact: true })
        .click();
    }
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__sent = [];
      navigator.mediaDevices.getUserMedia = async () => {
        window.__micCalls = (window.__micCalls || 0) + 1;
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
      window.__mediaPlays = [];
      window.__mediaPauses = [];
      HTMLMediaElement.prototype.play = async function () {
        window.__mediaPlays.push(this.src);
        if (window.__blockMedia) throw new DOMException('blocked', 'NotAllowedError');
      };
      const pause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        window.__mediaPauses.push(this.src);
        return pause.call(this);
      };
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
    let assetBytes,
      assetReads = 0;
    let feedVersion = 1,
      removed = [];
    let feedMessages = [
      {
        id: 'message-1',
        createdOrder: 1,
        updatedVersion: 1,
        side: 'assistant',
        kind: 'result',
        text: '扉が開いた！',
        assetIds: [],
        imageSlot: {
          status: 'generating',
          assetId: null,
          errorCode: null,
          deadline: new Date(Date.now() + 150000).toISOString(),
        },
        relatedCommandSeq: 1,
        liveGeneration: 1,
      },
    ];
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
        assert.ok(['ja', 'en'].includes(body.locale));
        state.locale = body.locale;
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
      if (url.pathname === '/api/play/assets/scene-1') {
        assetReads++;
        if (assetReads > 1) await new Promise((resolve) => setTimeout(resolve, 350));
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: assetBytes });
      }
      if (url.pathname === '/api/play/feed')
        return respond(route, {
          playId: 'play-one',
          locale: 'ja',
          version: feedVersion,
          reset: Number(url.searchParams.get('after')) === 0,
          upserts: feedMessages,
          removedIds: removed,
          retainUntil: null,
        });
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
        if (body.event.delta)
          feedMessages.push({
            id: 'user-1',
            createdOrder: 2,
            updatedVersion: ++feedVersion,
            side: 'user',
            kind: 'transcript',
            text: body.event.delta,
            assetIds: [],
            imageSlot: null,
            relatedCommandSeq: null,
            liveGeneration: 1,
          });
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
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:5182');
    await page.getByRole('combobox').selectOption('ja');
    await page.getByLabel('参加の合言葉').fill('demo');
    await page.getByRole('button', { name: '合言葉で参加' }).click();
    await page.getByRole('button', { name: '体験を始める', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    const metadata = await page
      .locator('video')
      .evaluate((v) => ({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }));
    assert.ok(metadata.duration > 0 && metadata.width > 0, 'supplied mp4 decodes');
    assert.equal(await page.evaluate(() => window.__micCalls || 0), 0);
    assert.equal(createIds.length, 0);
    assert.equal(liveIds.length, 0);
    await page.locator('video').evaluate((v) => v.dispatchEvent(new Event('ended')));
    await page.getByRole('dialog', { name: '未来からの着信' }).waitFor();
    await page.getByText('Calling', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      window.__mediaPlays.some((s) => s.endsWith('incoming-call.mp3')),
    );
    assert.equal(createIds.length, 0);
    assert.equal(liveIds.length, 0);
    assert.equal(await page.evaluate(() => window.__micCalls || 0), 0);
    await page.screenshot({ path: 'artifacts/incoming-call-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '応答する', exact: true }).click();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    assert.equal(createIds.length, 1);
    assert.equal(liveIds.length, 1);
    assert.ok(
      await page.evaluate(() => window.__mediaPauses.some((s) => s.endsWith('incoming-call.mp3'))),
    );
    assert.equal(await page.locator('.incoming-overlay').count(), 0);
    hasPlay = false;
    await page.reload();
    await page.getByRole('combobox').selectOption('ja');
    await page.evaluate(() => (window.__blockMedia = true));
    await page.getByRole('button', { name: '体験を始める', exact: true }).click();
    await page.getByRole('button', { name: '動画を再生', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: '着信音を再生', exact: true }).waitFor();
    await page.evaluate(() => (window.__blockMedia = false));
    await page.getByRole('button', { name: '着信音を再生', exact: true }).click();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(liveIds.length, 1, 'skip and media retry never connect AI');
    assert.deepEqual(pageErrors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'artifacts/incoming-call-desktop.png', fullPage: true });
    console.log(
      'PASS opening: actual MP4 metadata, ended/Skip, ringtone lifecycle, no mic/game/AI before Answer, autoplay fallback, mobile/desktop. Voice provider and media playback mocked.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
