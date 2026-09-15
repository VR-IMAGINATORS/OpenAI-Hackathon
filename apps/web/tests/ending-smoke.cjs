/* Optional browser smoke: all ending API/media responses are fake; no paid calls or real video decoding. */
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  // Native anchor downloads bypass Playwright request routing. Serve fixture bytes over HTTP.
  const downloadBytes = Buffer.from('fake-ending-video-download');
  const target = new URL(process.env.PLAYTEST_URL || 'http://127.0.0.1:5178');
  const fixtureServer = http.createServer((req, res) => {
    const url = new URL(req.url, target);
    if (url.pathname === '/api/play/ending/video' && url.searchParams.get('download') === '1') {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="call-to-the-past-${url.searchParams.get('playId')}.mp4"`,
      });
      return res.end(downloadBytes);
    }
    const proxy = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxy.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(proxy);
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      acceptDownloads: true,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let errorCode = null;
    let storyErrorCode = null;
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
          storyStatus: storyReady ? 'ready' : storyErrorCode ? 'failed' : 'generating',
          storyErrorCode,
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
    // Hold metadata loading so the video element can be inspected without real decoding.
    await page.route('**/api/play/ending/video?*', () => {});
    await page.goto(`http://127.0.0.1:${fixtureServer.address().port}/tests/ending-harness.html`);
    await page.getByRole('heading', { name: 'ノーマルエンド', exact: true }).waitFor();
    await page.getByText('エンディング動画を生成しています。', { exact: true }).waitFor();
    assert.equal(await page.locator('.ending-ready-notice').count(), 0);
    const arrow = page.getByRole('img', { name: 'to be continued', exact: true });
    await arrow.waitFor();
    assert(
      await arrow.evaluate(async (img) => {
        await img.decode();
        return img.naturalWidth > 0;
      }),
    );
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('.ending-download').count(), 0);
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
    assert.equal(await page.locator('.ending-download').count(), 0);
    assert(
      await arrow.isVisible(),
      'the result footer remains visible when video generation fails',
    );
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
    const readyNotice = page.locator('.ending-ready-notice');
    await readyNotice.waitFor();
    assert.match(await readyNotice.innerText(), /リザルト動画ができました/);
    assert.equal(await video.getAttribute('controls'), '');
    assert.equal(await video.getAttribute('playsinline'), '');
    assert.equal(await video.getAttribute('autoplay'), null);
    const downloadLink = page.getByRole('link', { name: '動画をダウンロード', exact: true });
    await downloadLink.waitFor();
    const downloadBounds = await downloadLink.boundingBox();
    assert(
      downloadBounds.height >= 44 && downloadBounds.width <= 390,
      'download fits a touch screen',
    );
    const previousUrl = page.url();
    const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
    assert.equal(download.suggestedFilename(), `call-to-the-past-${first}.mp4`);
    assert.equal(await download.failure(), null);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), downloadBytes);
    assert.equal(page.url(), previousUrl, 'saving keeps the result on screen');
    assert.equal(await page.getByRole('heading', { name: '赤い印の約束' }).count(), 0);
    await page.getByText('食器縛り', { exact: true }).waitFor();
    const readyGets = gets;
    await page.waitForTimeout(2300);
    assert(await readyNotice.isVisible(), 'completion notice remains until acknowledged');
    assert.equal(gets, readyGets, 'ready should stop polling');
    const dismissNotice = page.getByRole('button', {
      name: '動画の生成完了を確認して閉じる',
      exact: true,
    });
    const dismissBounds = await dismissNotice.boundingBox();
    assert(dismissBounds.width >= 44 && dismissBounds.height >= 44, 'check button is touch-sized');
    await page.screenshot({ path: 'artifacts/ending-ready-confirm-mobile.png', fullPage: true });
    await dismissNotice.click();
    assert.equal(await readyNotice.count(), 0, 'check button dismisses the notice');
    await page.getByRole('button', { name: 'リザルトを折りたたむ', exact: true }).click();
    await page.getByRole('button', { name: 'リザルトを開く', exact: true }).click();
    assert.equal(await readyNotice.count(), 0, 'acknowledged notice stays dismissed on re-render');
    await page.reload();
    await page.locator('video').waitFor();
    await readyNotice.waitFor();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate((id) => window.renderEnding(id, 'en'), first);
    const englishDismiss = page.getByRole('button', {
      name: 'Acknowledge video completion and close',
      exact: true,
    });
    await englishDismiss.waitFor();
    await page.getByRole('link', { name: 'Download video', exact: true }).waitFor();
    const noticeBounds = await readyNotice.boundingBox();
    assert(
      noticeBounds.x >= 0 && noticeBounds.x + noticeBounds.width <= 320,
      'notice fits a narrow phone',
    );
    await englishDismiss.focus();
    await englishDismiss.press('Space');
    assert.equal(await readyNotice.count(), 0, 'check button supports keyboard acknowledgement');
    await page.evaluate((id) => window.renderEnding(id), first);
    await page.setViewportSize({ width: 390, height: 844 });
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
    const footer = await page.evaluate(() => {
      const ending = document.querySelector('.ending-video');
      const arrow = ending.querySelector('.ending-continued');
      return {
        last: ending.querySelector('.ending-body').lastElementChild === arrow,
        top: arrow.getBoundingClientRect().top,
        width: arrow.getBoundingClientRect().width,
        right: arrow.getBoundingClientRect().right,
        contentRight: ending.querySelector('.ending-details').getBoundingClientRect().right,
        detailsBottom: ending.querySelector('.ending-details').getBoundingClientRect().bottom,
      };
    });
    assert(footer.last && footer.top >= footer.detailsBottom, 'arrow follows all result content');
    assert(Math.abs(footer.width - 390 * 0.4) < 1, 'arrow is two fifths of the mobile viewport');
    assert(
      Math.abs(footer.right - footer.contentRight) < 1,
      'arrow aligns with the result right edge',
    );
    await video.evaluate((element) => {
      window.__videoPauses = 0;
      element.pause = () => window.__videoPauses++;
    });
    await page.getByRole('button', { name: 'リザルトを折りたたむ', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__videoPauses), 1, 'collapse pauses the video');
    assert(await page.getByRole('heading', { name: 'ノーマルエンド', exact: true }).isVisible());
    assert(await page.locator('.ending-count').isVisible());
    for (const selector of [
      '.ending-body',
      '.ending-tag',
      '.ending-story',
      '.ending-status',
      'video',
      '.ending-download',
      '.ending-continued',
    ]) {
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} folds away`);
    }
    const expand = page.getByRole('button', { name: 'リザルトを開く', exact: true });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: 'artifacts/ending-collapsed-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'collapsed heading and toggle fit a narrow phone',
    );
    await expand.press('Enter');
    assert(await arrow.isVisible(), 'expanding restores the footer');
    assert(await video.isVisible(), 'expanding restores the video');
    assert(await page.locator('.ending-tag').isVisible(), 'expanding restores the tag');
    await page.setViewportSize({ width: 390, height: 844 });
    await video.evaluate((element) => element.dispatchEvent(new Event('error')));
    await page.getByRole('button', { name: '動画を読み直す', exact: true }).waitFor();
    assert(await downloadLink.isVisible(), 'a playback error does not prevent downloading');
    await page.getByRole('button', { name: '動画を読み直す', exact: true }).click();
    await video.waitFor();
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
    // Text failure is independent: keep polling the video and retain diagnostics after completion.
    storyReady = false;
    storyErrorCode = 'ENDING_STORY_INVALID_TAG_EVIDENCE';
    status = 'generating';
    await page.reload();
    await page.getByText(/動画の制作は続けています/).waitFor();
    const textFailedGets = gets;
    await page.getByText('不具合報告用の情報', { exact: true }).click();
    await page.getByText(storyErrorCode, { exact: true }).waitFor();
    await page.getByText(first, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'リザルトを折りたたむ', exact: true }).click();
    status = 'ready';
    await readyNotice.waitFor();
    await dismissNotice.click();
    assert.equal(await readyNotice.count(), 0, 'notice can be acknowledged while result is folded');
    assert.equal(
      await page.locator('video').isVisible(),
      false,
      'notice preserves collapsed details',
    );
    await page.getByRole('button', { name: 'リザルトを開く', exact: true }).click();
    await page.locator('video').waitFor();
    assert(gets > textFailedGets, 'text failure must not stop video polling');
    await page.getByText(storyErrorCode, { exact: true }).waitFor();
    assert.equal(await page.locator('.ending-tag').count(), 0);
    await page.reload();
    await page.locator('video').waitFor();
    await dismissNotice.click();
    await page.getByText('不具合報告用の情報', { exact: true }).click();
    await page.getByText(storyErrorCode, { exact: true }).waitFor();
    status = 'failed';
    errorCode = 'ENDING_DIRECTION_INVALID_RESPONSE';
    await page.reload();
    await page.getByText('不具合報告用の情報', { exact: true }).click();
    await page.getByText(storyErrorCode, { exact: true }).waitFor();
    await page.getByText(errorCode, { exact: true }).waitFor();
    storyErrorCode = null;
    responseCode = 401;
    await page.reload();
    await page.getByText('動画を閲覧する認証が失効しました。', { exact: true }).waitFor();
    assert.equal(await page.locator('.ending-tag').count(), 0);
    assert.equal(await page.locator('.ending-download').count(), 0);
    responseCode = 200;
    status = 'ready';
    retainUntil = new Date(Date.now() + 1300).toISOString();
    await page.reload();
    await page.locator('video').waitFor();
    await page.getByText('エンディング動画の閲覧期限が切れました。', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('.ending-download').count(), 0);
    assert.equal(await page.locator('.ending-tag').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Ending browser smoke passed: text before video, 40-tag labels, mobile layout, disabled-video polling, manual video, MP4 download, reload, replay, auth, expiry. Media/API are fake.',
    );
  } finally {
    await browser?.close();
    fixtureServer.closeAllConnections();
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
