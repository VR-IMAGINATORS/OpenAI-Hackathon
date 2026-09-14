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
    let errorCode = null;
    let storyReady = false;
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
          storyStatus: storyReady ? 'ready' : 'generating',
          errorCode,
          retainUntil,
          videoPath: status === 'ready' ? '/api/play/ending/video?playId=' + id : null,
          story: storyReady
            ? {
                title: id === first ? '赤い印の約束' : '次のプレイの結末',
                text: '序盤に示された印が、最後の行動の意味を変えた。',
                evaluation: '二つの仕掛けを解除した。',
                tagId: 'tableware_only',
                tagCatalogVersion: 1,
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
    await page.getByText('あなたらしい結末を振り返っています…', { exact: true }).waitFor();
    storyReady = true;
    await page.getByText('食器縛り', { exact: true }).waitFor();
    await page
      .getByText('序盤に示された印が、最後の行動の意味を変えた。', { exact: true })
      .waitFor();
    assert.equal(await page.locator('video').count(), 0, 'text is shown before video is ready');
    assert.equal(await page.getByRole('button', { name: '結果を見る' }).count(), 0);
    await page.screenshot({ path: 'artifacts/ending-tags-waiting-mobile.png', fullPage: true });
    status = 'failed';
    errorCode = 'ENDING_DIRECTION_INVALID_RESPONSE';
    await page.getByText('動画の演出を作る段階で失敗しました。', { exact: true }).waitFor();
    assert.equal(await page.getByText('食器縛り', { exact: true }).count(), 1);
    assert.equal(await page.locator('.ending-story').isVisible(), true);
    await page.reload();
    await page.getByText('食器縛り', { exact: true }).waitFor();
    await page.getByText('動画の演出を作る段階で失敗しました。', { exact: true }).waitFor();
    status = 'ready';
    errorCode = null;
    await page.reload();
    await page.locator('video').waitFor();
    const video = page.locator('video');
    assert.equal(await video.getAttribute('controls'), '');
    assert.equal(await video.getAttribute('playsinline'), '');
    assert.equal(await video.getAttribute('autoplay'), null);
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    await page.getByText('食器縛り', { exact: true }).waitFor();
    const readyGets = gets;
    await page.waitForTimeout(2300);
    assert.equal(gets, readyGets, 'ready should stop polling');
    await page.reload();
    await page.locator('video').waitFor();
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    await page.getByText('食器縛り', { exact: true }).waitFor();
    const bounds = await page.evaluate(() => {
      const tag = document.querySelector('.ending-tag').getBoundingClientRect();
      const video = document.querySelector('video').getBoundingClientRect();
      return {
        tagBottom: tag.bottom,
        videoTop: video.top,
        width: document.documentElement.scrollWidth,
      };
    });
    assert(bounds.tagBottom < bounds.videoTop, 'tag and text precede the video');
    assert(bounds.width <= 390, 'mobile result fits the viewport');
    status = 'failed';
    errorCode = 'ENDING_START_FRAME_HTTP_401';
    await page.evaluate((id) => window.renderEnding(id, 'en'), second);
    await page.getByRole('heading', { name: 'Normal ending', exact: true }).waitFor();
    await page.getByText('Tableware only', { exact: true }).waitFor();
    await page
      .getByText('The video could not be generated. Your game result is final.', { exact: true })
      .waitFor();
    await page
      .getByText('The generation service could not authorize the request.', { exact: true })
      .waitFor();
    await page.getByText('Information for reporting this issue', { exact: true }).click();
    await page.getByText('ENDING_START_FRAME_HTTP_401', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    const failedGets = gets;
    await page.waitForTimeout(2300);
    assert.equal(gets, failedGets);
    status = 'disabled';
    storyReady = false;
    errorCode = null;
    await page.reload();
    await page.getByText('この環境では動画生成を利用できません。', { exact: true }).waitFor();
    const disabledGets = gets;
    storyReady = true;
    await page.getByText('食器縛り', { exact: true }).waitFor();
    assert(gets > disabledGets, 'disabled video must still poll until text is ready');
    assert.equal(await page.locator('video').count(), 0);
    responseCode = 401;
    await page.reload();
    await page.getByText('動画を閲覧する認証が失効しました。', { exact: true }).waitFor();
    assert.equal(await page.locator('.ending-tag').count(), 0);
    responseCode = 200;
    status = 'ready';
    retainUntil = new Date(Date.now() + 1300).toISOString();
    await page.reload();
    await page.locator('video').waitFor();
    await page.getByText('エンディング動画の閲覧期限が切れました。', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('.ending-tag').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Ending browser smoke passed: text before video, 40-tag labels, mobile layout, disabled-video polling, manual video, reload, replay, auth, expiry. Media/API are fake.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
