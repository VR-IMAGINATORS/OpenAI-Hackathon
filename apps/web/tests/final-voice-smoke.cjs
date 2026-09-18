/* Browser regression with fake API/audio. Run with node --import tsx;
   PLAYWRIGHT_MODULE may point to an existing Playwright installation. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const { FinalVoicePlayback } = await import('../../local-server/final-voice-playback.ts');
  const playback = new FinalVoicePlayback(() => performance.now());
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__peerClosed = 0;
      window.__micStopped = false;
      window.__sent = [];
      const track = {
        enabled: true,
        stop() {
          window.__micStopped = true;
        },
      };
      navigator.mediaDevices.getUserMedia = async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      });
      // Playback activity is injected by the test; no real microphone or AI.
      window.AudioContext = class {
        constructor() {
          throw new Error('Mock analysis');
        }
      };
      window.RTCPeerConnection = class extends EventTarget {
        iceGatheringState = 'complete';
        addTrack() {}
        createDataChannel() {
          return (window.__channel = this.channel =
            {
              readyState: 'open',
              send(value) {
                window.__sent.push(JSON.parse(value));
              },
              close() {},
            });
        }
        async createOffer() {
          return { type: 'offer', sdp: 'fake-offer' };
        }
        async setLocalDescription(value) {
          this.localDescription = value;
        }
        async setRemoteDescription() {
          this.channel.onmessage({ data: JSON.stringify({ type: 'session.started' }) });
        }
        close() {
          window.__peerClosed++;
        }
      };
    });
    const state = {
      id: 'final-voice',
      locale: 'ja',
      automaticActions: true,
      generation: 1,
      status: 'playing',
      title: 'Final voice',
      briefing: '',
      situation: '',
      obstacle: { title: 'Door', index: 0, count: 3 },
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
      voiceState: 'connected',
      transcript: '',
      lastResult: null,
      error: null,
    };
    let lifecycle = 'active';
    const envelope = () => ({
      playId: state.id,
      state,
      lifecycle,
      controlEpoch: 1,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      recoveryExpiresAt: null,
    });
    const received = [];
    const command = {
      seq: 1,
      type: 'session.commentary.append',
      event_id: 'result-1',
      delegation_id: 'delegation-1',
      content: 'The paper band is cut.',
    };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      // Same evaluation order as the real server, using a clock that keeps advancing.
      if (state.status === 'won' && performance.now() >= playback.closingAt) lifecycle = 'terminal';
      let data;
      if (path === '/api/bootstrap')
        data = {
          app: { stage: 'hosted-multiplayer' },
          ai: { mode: 'mock' },
          auth: { required: false },
        };
      else if (path === '/api/session') data = { authenticated: true, playId: state.id };
      else if (['/api/play/state', '/api/play/control', '/api/play/heartbeat'].includes(path))
        data = envelope();
      else if (path === '/api/play/live')
        data = {
          sdp: 'fake-answer',
          generation: 1,
          initialization: [
            {
              type: 'session.instructions.append',
              event_id: 'init',
              delegation_id: null,
              content: 'Act as the game companion.',
            },
          ],
        };
      else if (path === '/api/play/events') {
        received.push(route.request().postDataJSON().event);
        data = { accepted: true };
      } else if (path === '/api/play/commands/poll')
        data = {
          generation: 1,
          controlEpoch: 1,
          acknowledgedThrough: 0,
          serverNow: Date.now(),
          commands: received.some((e) => e.type === 'session.delegation.created') ? [command] : [],
          state,
        };
      else if (path === '/api/play/voice-activity') data = { accepted: true };
      else if (path === '/api/play/feed')
        data = {
          playId: state.id,
          version: 0,
          reset: true,
          upserts: [],
          removedIds: [],
          retainUntil: null,
        };
      else if (path === '/api/play/ending')
        data = {
          playId: state.id,
          status: 'not_applicable',
          outcome: null,
          story: null,
        };
      else throw new Error('Unexpected API route: ' + path);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    });
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:5181');
    await page.getByRole('button', { name: 'この画面で再接続', exact: true }).click();
    const label = page.locator('.messenger-call strong');
    await label.filter({ hasText: '音声で会話できます' }).waitFor();
    assert.equal((await page.evaluate(() => window.__sent))[0].type, 'session.instructions.append');
    await page.evaluate(() => {
      for (const event of [
        {
          type: 'session.input_transcript.delta',
          event_id: 'input-1',
          delta: 'Cut the paper band.',
          start_ms: 0,
          end_ms: 100,
        },
        {
          type: 'session.delegation.created',
          event_id: 'delegate-1',
          offset_ms: 100,
          delegation: { id: 'delegation-1', type: 'delegation', target: 'client' },
        },
      ])
        window.__channel.onmessage({ data: JSON.stringify(event) });
    });
    await page.waitForFunction(() => window.__sent.some((c) => c.event_id === 'result-1'));
    assert.deepEqual(
      received.map((e) => e.type),
      ['session.input_transcript.delta', 'session.delegation.created'],
    );
    assert.equal(
      (await page.evaluate(() => window.__sent.filter((c) => c.event_id === 'result-1'))).length,
      1,
    );
    let sequence = 0;
    const report = (output) =>
      playback.report({
        generation: 1,
        sequence: ++sequence,
        input: 'unknown',
        inputStopped: true,
        output,
        playbackReady: true,
      });
    state.status = 'won';
    playback.start(1, 0);
    report('active');
    await label.filter({ hasText: '最後の音声を再生中（マイク停止）' }).waitFor();
    assert.equal(await page.evaluate(() => window.__micStopped), true);
    assert.equal(await page.evaluate(() => window.__peerClosed), 0);
    report('quiet');
    await page.waitForTimeout(1000);
    report('quiet');
    assert.equal(await label.textContent(), '最後の音声を再生中（マイク停止）');
    // Keep telemetry fresh while waiting for the server and UI polling cycles.
    const reports = setInterval(() => report('quiet'), 500);
    try {
      await label.getByText('通話終了', { exact: true }).waitFor({ timeout: 5000 });
    } finally {
      clearInterval(reports);
    }
    assert.equal(lifecycle, 'terminal');
    assert.equal(await page.evaluate(() => window.__peerClosed), 1);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: initialization, transcript/delegation forwarding, result delivery once, final playback and one peer close. API/audio mocked.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
