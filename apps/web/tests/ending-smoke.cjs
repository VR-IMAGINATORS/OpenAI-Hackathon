/* Optional browser smoke: all ending API/media responses are fake; no paid calls or real video decoding. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let status = 'generating',
      gets = 0,
      responseCode = 200;
    let retainUntil = new Date(Date.now() + 600000).toISOString();
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    await page.route('**/api/play/ending?*', (route) => {
      gets++;
      const id = new URL(route.request().url()).searchParams.get('playId');
      return route.fulfill({
        status: responseCode,
        contentType: 'application/json',
        body: JSON.stringify({
          playId: id,
          outcome: 'normal',
          clearedCount: 2,
          status,
          errorCode: null,
          retainUntil,
          videoPath: status === 'ready' ? '/api/play/ending/video?playId=' + id : null,
          story:
            status === 'ready' || status === 'failed'
              ? {
                  title: id === first ? '赤い印の約束' : '次のプレイの結末',
                  text: '序盤に示された印が、最後の行動の意味を変えた。',
                  evaluation: '二つの仕掛けを解除した。',
                }
              : null,
        }),
      });
    });
    // Hold metadata loading so the HTML video can be inspected without fabricating playable content.
    await page.route('**/api/play/ending/video?*', () => {});
    await page.goto(
      (process.env.PLAYTEST_URL || 'http://127.0.0.1:5178') + '/tests/ending-harness.html',
    );
    await page.getByRole('heading', { name: 'ノーマルエンド', exact: true }).waitFor();
    await page.getByText('エンディング動画を生成しています。', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    status = 'ready';
    await page.locator('video').waitFor();
    const video = page.locator('video');
    assert.equal(await video.getAttribute('controls'), '');
    assert.equal(await video.getAttribute('playsinline'), '');
    assert.equal(await video.getAttribute('autoplay'), null);
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    await page.getByRole('button', { name: '結果を見る' }).click();
    await page.getByRole('heading', { name: '赤い印の約束' }).waitFor();
    const readyGets = gets;
    await page.waitForTimeout(2300);
    assert.equal(gets, readyGets, 'ready should stop polling');
    await page.reload();
    await page.locator('video').waitFor();
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    await page.locator('video').dispatchEvent('ended');
    await page.getByRole('heading', { name: '赤い印の約束' }).waitFor();
    await page.screenshot({ path: 'artifacts/ending-mobile.png', fullPage: true });
    status = 'failed';
    await page.evaluate((id) => window.renderEnding(id, 'en'), second);
    await page.getByRole('heading', { name: 'Normal ending', exact: true }).waitFor();
    await page
      .getByText('The video could not be generated. Your game result is final.', { exact: true })
      .waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    const failedGets = gets;
    await page.waitForTimeout(2300);
    assert.equal(gets, failedGets);
    responseCode = 401;
    await page.reload();
    await page.getByText('動画を閲覧する認証が失効しました。', { exact: true }).waitFor();
    responseCode = 200;
    status = 'ready';
    retainUntil = new Date(Date.now() + 1300).toISOString();
    await page.reload();
    await page.locator('video').waitFor();
    await page.getByText('エンディング動画の閲覧期限が切れました。', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Ending browser smoke passed: mobile layout, state polling, manual video, reveal, reload, replay, auth, expiry. Media/API are fake.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
