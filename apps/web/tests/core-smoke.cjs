/* Optional browser smoke test. PLAYWRIGHT_MODULE may point to an installed Playwright runtime.
   Run against Vite on PLAYTEST_URL (default http://127.0.0.1:5178).
   All /api responses and WebRTC/media devices are fake; no AI calls are made. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync('scenarios/mobile-playtest.json', 'utf8'));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'ja-JP',
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
      obstacle: { title: scenario.obstacles[0].title.ja, index: 0, count: 3 },
      situation: scenario.obstacles[0].situationDisplay.ja,
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
      if (url.pathname === '/api/play/ending') {
        assert.equal(url.searchParams.get('playId'), 'play-one');
        return respond(route, { error: { code: 'ENDING_NOT_FOUND' } }, 404);
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
        if (body.voiceState === 'connected' && state.status === 'briefing')
          state.status = 'playing';
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
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:5178');
    await page.getByRole('button', { name: 'Join', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('combobox').inputValue(),
      'en',
      'English is the default even in a Japanese browser',
    );
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.getByRole('combobox').selectOption('ja');
    await page.getByRole('button', { name: '合言葉で参加', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
    await page.getByRole('combobox').selectOption('en');
    await page.getByRole('button', { name: 'Join', exact: true }).waitFor();
    await page.getByRole('combobox').selectOption('ja');
    await page.getByLabel('参加の合言葉').fill('demo');
    await page.getByRole('button', { name: '合言葉で参加' }).click();
    await enterCall();
    await page.getByText('音声で会話できます', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__sent.some((e) => e.event_id === 'opening-1'));
    assert.equal(state.status, 'playing');
    async function assertMessengerLayout() {
      assert.equal(await page.locator('main').count(), 1);
      assert.equal(await page.locator('.play-actions, .play-header, .play-story').count(), 0);
      const layout = await page.evaluate(() => {
        const app = document.querySelector('.messenger-app').getBoundingClientRect();
        const composer = document.querySelector('.messenger-composer').getBoundingClientRect();
        const feed = document.querySelector('.chat-messages').getBoundingClientRect();
        return {
          fits: app.left >= 0 && app.right <= innerWidth + 1 && app.bottom <= innerHeight + 1,
          composerInside: composer.top >= app.top && composer.bottom <= app.bottom + 1,
          feedVisible: feed.height > 70 && feed.bottom <= composer.top + 1,
          noPageScroll: document.documentElement.scrollHeight <= innerHeight + 1,
        };
      });
      assert.deepEqual(layout, {
        fits: true,
        composerInside: true,
        feedVisible: true,
        noPageScroll: true,
      });
    }
    await assertMessengerLayout();
    await page.getByText('現在の目標', { exact: true }).waitFor();
    await page.getByText('残り時間', { exact: true }).waitFor();
    await page.getByText('残り行動回数', { exact: true }).waitFor();
    assert.equal(await page.locator('.messenger-clock strong').innerText(), '05:00');
    await page.screenshot({ path: 'artifacts/messenger-active-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    await assertMessengerLayout();
    await page.setViewportSize({ width: 1280, height: 900 });
    await assertMessengerLayout();
    await page.screenshot({ path: 'artifacts/messenger-active-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.__sent.some((e) => e.event_id === 'core-result'));
    assert.equal(await page.getByRole('button', { name: /状況を聞いたら、プレイ開始/ }).count(), 0);
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
    await page.locator('.chat-user').getByText('これで扉を開けて', { exact: true }).waitFor();
    await page.getByText('未来から画像を受信中…', { exact: true }).waitFor();
    assert.equal(await page.locator('.proposal-panel').count(), 0);
    feedMessages[0].imageSlot.status = 'failed';
    feedMessages[0].imageSlot.errorCode = 'SCENE_RECEIVE_FAILED';
    feedMessages[0].updatedVersion = ++feedVersion;
    await page.getByText('未来から画像の受信に失敗しました', { exact: true }).waitFor();
    removed = ['user-1'];
    feedMessages = feedMessages.filter((m) => m.id !== 'user-1');
    feedVersion++;
    await page.waitForTimeout(650);
    assert.equal(await page.locator('.chat-user').count(), 0);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    const cameraChoice = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '撮影', exact: true }).click();
    await (await cameraChoice).setFiles({ name: 'camera.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: '撮り直す・取り消す', exact: true }).click();
    const libraryChoice = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: '写真ライブラリ / PCのファイルから選ぶ', exact: true })
      .click();
    await (await libraryChoice).setFiles({ name: 'tool.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('heading', { name: 'この写真を送りますか？' }).waitFor();
    assert.equal(photoIds.length, 0, 'photo is not sent before preview confirmation');
    assert.equal(await page.locator('.messenger-composer .messenger-draft').count(), 1);
    await assertMessengerLayout();
    await page.screenshot({ path: 'artifacts/messenger-draft-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'この写真を送信', exact: true }).click();
    await page.getByRole('button', { name: '写真の送信を再試行', exact: true }).waitFor();
    await page.getByRole('button', { name: '写真の送信を再試行', exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(photoIds.length, 2);
    assert.equal(
      await page.locator('.messenger-composer img').count(),
      0,
      'sent photos leave the composer',
    );
    assert.equal(
      await page.locator('.messenger-attachments').count(),
      0,
      'only unsent drafts appear above the composer',
    );
    assetBytes = Buffer.from(
      await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        return c.toDataURL('image/jpeg').split(',')[1];
      }),
      'base64',
    );
    feedMessages[0].imageSlot = {
      ...feedMessages[0].imageSlot,
      status: 'ready',
      assetId: 'scene-1',
      errorCode: null,
    };
    feedMessages[0].updatedVersion = ++feedVersion;
    await page.locator('.chat-image').waitFor();
    assert.equal(assetReads, 1, 'private asset fetched with owner header');
    assert.ok((await page.locator('.chat-image').getAttribute('src')).startsWith('blob:'));
    feedMessages.push({
      id: 'result-without-voice',
      createdOrder: 3,
      updatedVersion: ++feedVersion,
      side: 'assistant',
      kind: 'result',
      text: '音声が届かなくても残る結果',
      assetIds: [],
      imageSlot: null,
      relatedCommandSeq: 99,
      liveGeneration: 1,
    });
    await page.getByText('音声が届かなくても残る結果', { exact: true }).waitFor();
    await page
      .getByText('音声を送信できなかったため、文章でお届けします。', { exact: true })
      .waitFor();
    // Late image growth keeps the newest message visible, while user scrolling pauses following.
    for (let i = 0; i < 7; i++)
      feedMessages.push({
        id: 'scroll-' + i,
        createdOrder: 10 + i,
        updatedVersion: ++feedVersion,
        side: 'assistant',
        kind: 'system',
        text: ('追加の会話 ' + i + ' ').repeat(20),
        assetIds: i === 6 ? ['scene-1'] : [],
        imageSlot: null,
        relatedCommandSeq: null,
        liveGeneration: 1,
      });
    await page.locator('[data-message-id="scroll-6"] img').waitFor();
    await page.waitForTimeout(450);
    const bottomGap = () =>
      page.locator('.chat-messages').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
    assert.ok((await bottomGap()) < 3, 'late image and new messages follow to bottom');
    await page.locator('.chat-messages').hover();
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(250);
    assert.ok((await bottomGap()) > 200, 'user can scroll back into history');
    const readingTop = await page.locator('.chat-messages').evaluate((e) => e.scrollTop);
    feedMessages.push({
      id: 'scroll-late',
      createdOrder: 18,
      updatedVersion: ++feedVersion,
      side: 'assistant',
      kind: 'system',
      text: '後から届いた画像',
      assetIds: ['scene-1'],
      imageSlot: null,
      relatedCommandSeq: null,
      liveGeneration: 1,
    });
    await page.locator('[data-message-id="scroll-late"] img').waitFor();
    await page.waitForTimeout(450);
    assert.ok(
      Math.abs((await page.locator('.chat-messages').evaluate((e) => e.scrollTop)) - readingTop) <
        5,
      'late image does not jump away from history being read',
    );
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(250);
    assert.ok((await bottomGap()) < 3, 'scrolling back to bottom resumes following');
    await page.getByRole('button', { name: 'プレイを終了', exact: true }).click();
    assert.ok(
      (await page.locator('.chat-image').count()) >= 1,
      'images remain readable after call end',
    );
    assert.deepEqual(pageErrors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/core-p2-mobile.png', fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: 'もう一度プレイ', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ja', 'Japanese play restored');
    await page.getByRole('button', { name: 'もう一度プレイ', exact: true }).click();
    state = {
      ...state,
      status: 'briefing',
      title: 'The locked laboratory',
      briefing: 'Your future self needs your help.',
      obstacle: { ...state.obstacle, title: scenario.obstacles[0].title.en },
      inputRevision: 0,
      actionsRemaining: 4,
    };
    await page.getByRole('combobox').selectOption('en');
    await enterCall(true);
    await page.getByText('Voice connected', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Begin the escape', exact: false }).count(),
      0,
    );
    assert.equal(await page.getByRole('combobox').count(), 0, 'locale is fixed during play');
    await page.reload();
    await page.getByRole('button', { name: 'Reconnect here', exact: false }).waitFor();
    assert.equal(
      await page.locator('html').getAttribute('lang'),
      'en',
      'locale restored from state',
    );
    assert.deepEqual(pageErrors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'English mobile layout',
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'English PC layout',
    );
    await page.screenshot({ path: 'artifacts/core-p3-en-restored.png', fullPage: true });

    // Exercise the actual HUD across the warning boundary using authoritative mock state.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('Current objective', { exact: true }).waitFor();
    await page.getByText('Time left', { exact: true }).waitFor();
    await page.getByText('Actions left', { exact: true }).waitFor();
    const objective = page.locator('.messenger-objective strong');
    assert.equal(await objective.innerText(), scenario.obstacles[0].title.en);
    const hudMetrics = await page.evaluate(() => {
      const objective = document.querySelector('.messenger-objective');
      const counters = document.querySelector('.messenger-counters');
      return {
        stacked: counters.getBoundingClientRect().top >= objective.getBoundingClientRect().bottom,
        objectiveSize: getComputedStyle(objective.querySelector('strong')).fontSize,
        numberSize: getComputedStyle(counters.querySelector('strong')).fontSize,
      };
    });
    assert.deepEqual(hudMetrics, { stacked: true, objectiveSize: '20px', numberSize: '24px' });
    await page.screenshot({ path: 'artifacts/hud-normal-en-mobile.png', fullPage: true });
    await page
      .locator('.messenger-info')
      .screenshot({ path: 'artifacts/hud-header-normal-en.png' });
    await page.setViewportSize({ width: 320, height: 568 });
    await assertMessengerLayout();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.ok(await objective.evaluate((e) => e.clientHeight > 26), 'long English objective wraps');
    await page.screenshot({ path: 'artifacts/hud-small-en-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.messenger-status').click();
    assert.equal(await page.locator('.messenger-info').getAttribute('open'), '');
    await page.getByText(state.situation, { exact: true }).waitFor();
    await page.locator('.messenger-status').press('Enter');
    assert.equal(await page.locator('.messenger-info').getAttribute('open'), null);
    await page.evaluate(() => {
      window.__clockWarnings = 0;
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === 'clock-warning-pulse') window.__clockWarnings++;
      });
    });
    state.remainingMs = 60_001;
    state.actionsRemaining = 3;
    await page.locator('.messenger-clock strong').getByText('01:01', { exact: true }).waitFor();
    assert.equal(
      await page.locator('.messenger-resource.is-urgent, .messenger-resource.is-caution').count(),
      0,
    );
    state.remainingMs = 60_000;
    state.actionsRemaining = 2;
    await page.locator('.messenger-clock.is-urgent').waitFor();
    await page.locator('.messenger-action-count.is-caution').waitFor();
    await page.waitForFunction(() => window.__clockWarnings === 1);
    assert.equal(await page.locator('.messenger-clock strong').innerText(), '01:00');
    assert.equal(await page.locator('.messenger-warning-icon').count(), 2);
    await page.waitForTimeout(1100);
    state.remainingMs = 59_000;
    await page.locator('.messenger-clock strong').getByText('00:59', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__clockWarnings),
      1,
      'ticks do not replay warning',
    );
    await page.screenshot({ path: 'artifacts/hud-warning-en-mobile.png', fullPage: true });
    await page.locator('.messenger-status').evaluate((e) => e.blur());
    await page
      .locator('.messenger-info')
      .screenshot({ path: 'artifacts/hud-header-warning-en.png' });
    state.actionsRemaining = 1;
    await page.locator('.messenger-action-count.is-urgent').waitFor();
    assert.equal(await page.locator('.messenger-action-count strong').innerText(), '1');
    state.obstacle = { ...state.obstacle, index: 1, title: scenario.obstacles[1].title.en };
    await objective.getByText('Open the door', { exact: true }).waitFor();
    assert.equal(await page.getByText(scenario.obstacles[0].title.en, { exact: true }).count(), 0);
    await page.reload();
    await page.locator('.messenger-clock.is-urgent').waitFor();
    assert.equal(
      await page.locator('.clock-warning-pulse').count(),
      0,
      'restoring a low timer does not animate',
    );
    // A fresh mount above the boundary with reduced motion still changes color and warning text.
    state.remainingMs = 61_000;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.locator('.messenger-clock strong').getByText('01:01', { exact: true }).waitFor();
    state.remainingMs = 58_000;
    await page.locator('.messenger-clock.is-urgent').waitFor();
    assert.equal(
      await page.locator('.messenger-clock').evaluate((e) => getComputedStyle(e).animationName),
      'none',
    );
    assert.match(
      await page.getByRole('status').filter({ hasText: 'One minute' }).innerText(),
      /One minute or less/,
    );
    state.status = 'expired';
    await page.getByText('Call ended', { exact: true }).first().waitFor();
    assert.equal(
      await page.locator('.messenger-counters').count(),
      0,
      'terminal state hides resources',
    );
    assert.deepEqual(pageErrors, []);
    console.log(
      'PASS: core automatic action UI, 202 events, ordered poll deduplication, provider payload, mobile layout, bilingual HUD, warning thresholds, single animation, restore and reduced motion. Fake API/media only.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
