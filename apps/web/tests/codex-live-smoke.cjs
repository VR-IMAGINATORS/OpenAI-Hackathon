/* Fake auth, fake microphone and fake WebRTC; never invokes an AI provider. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let state = { state: 'disconnected' },
      stopped = 0,
      spoken = 0;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = state;
      if (path === '/api/auth') body = { ok: true };
      if (path === '/api/login')
        body = state = {
          state: 'pending',
          userCode: 'DEMO-0000',
          verificationUrl: 'https://auth.openai.com/codex/device',
        };
      if (path === '/api/start') {
        assert.equal(route.request().postDataJSON().sdp, 'v=0 offer');
        state = { state: 'connected', versionConfirmed: true, deadline: Date.now() + 60000 };
        body = { sdp: 'v=0 answer' };
      }
      if (path === '/api/speech') {
        spoken++;
        body = { accepted: true };
      }
      if (path === '/api/stop') {
        stopped++;
        body = state = { state: 'closed', processClosed: true, stopConfirmed: true };
      }
      await route.fulfill({ json: body });
    });
    await page.addInitScript(() => {
      window.__stopped = 0;
      window.__voiceModel = 'gpt-live-1';
      navigator.mediaDevices.getUserMedia = async () => ({
        getTracks: () => [{ stop: () => window.__stopped++ }],
      });
      HTMLMediaElement.prototype.play = async function () {};
      HTMLMediaElement.prototype.pause = function () {};
      window.RTCPeerConnection = class extends EventTarget {
        iceGatheringState = 'complete';
        connectionState = 'new';
        localDescription = null;
        addTrack() {}
        createDataChannel(name) {
          assertChannel(name);
          return (this.channel = { close() {} });
        }
        async createOffer() {
          return { type: 'offer', sdp: 'v=0 offer' };
        }
        async setLocalDescription(value) {
          this.localDescription = value;
        }
        async setRemoteDescription(value) {
          if (value.sdp !== 'v=0 answer') throw new Error('Bad answer');
          this.connectionState = 'connected';
          this.onconnectionstatechange?.();
          this.channel.onmessage?.({
            data: JSON.stringify({
              type: 'session.started',
              session: { model: window.__voiceModel },
            }),
          });
          this.channel.onmessage?.({
            data: JSON.stringify({
              type: 'session.output_transcript.delta',
              delta: 'PRIVATE_TRANSCRIPT',
            }),
          });
        }
        async getStats() {
          return new Map([['audio', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 1234 }]]);
        }
        close() {
          this.connectionState = 'closed';
        }
      };
      function assertChannel(name) {
        if (name !== 'oai-events') throw new Error('Bad channel');
      }
    });
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:4311');
    assert.equal(await page.locator('#start').isDisabled(), true);
    await page.locator('#login').click();
    await page.getByText('DEMO-0000').waitFor();
    state = { state: 'ready', deadline: Date.now() + 300000 };
    await page.locator('#start:enabled').waitFor();
    await page.locator('#start').click();
    await page.locator('#speech:enabled').waitFor();
    await page.locator('#speech').click();
    assert.equal(spoken, 1);
    await page.getByText('1234 bytes', { exact: true }).waitFor();
    assert.equal(await page.locator('#model').innerText(), 'gpt-live-1');
    assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_TRANSCRIPT/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    fs.mkdirSync('runs/codex-live-smoke', { recursive: true });
    await page.screenshot({ path: 'runs/codex-live-smoke/connected-mobile.png', fullPage: true });
    await page.locator('#stop').click();
    await page.locator('#login:enabled').waitFor();
    assert.ok(stopped > 0);
    assert.ok(await page.evaluate(() => window.__stopped > 0));
    await page.evaluate(() => (window.__voiceModel = 'gpt-realtime'));
    await page.locator('#login').click();
    await page.getByText('DEMO-0000').waitFor();
    state = { state: 'ready', deadline: Date.now() + 300000 };
    await page.locator('#start:enabled').waitFor();
    await page.locator('#start').click();
    await page.getByText('MODEL_MISMATCH', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'Voice probe UI passed: fake auth/WebRTC, microphone cleanup, SDP exchange, speech, metrics, redaction, model mismatch, mobile layout.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
