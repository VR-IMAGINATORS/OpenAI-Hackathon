/* All auth responses are fake. No OpenAI login or inference is performed. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let enabled = true,
      state = { status: 'disconnected' },
      logoutCount = 0;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let status = 200,
        body = {};
      if (path === '/api/bootstrap')
        body = {
          ai: {
            mode: 'live',
            ...(enabled ? { playerLogin: 'codex', provider: 'codex' } : { provider: 'api' }),
          },
        };
      else if (path === '/api/session') {
        status = 401;
        body = { error: { code: 'AUTH_REQUIRED' } };
      } else if (path === '/api/codex/status') body = state;
      else if (path === '/api/codex/login')
        body = state = {
          status: 'pending',
          userCode: 'DEMO-0000',
          verificationUrl: 'https://auth.openai.com/codex/device',
        };
      else if (path === '/api/codex/logout') {
        logoutCount++;
        body = state = { status: 'disconnected' };
      } else if (path !== '/api/auth') throw new Error(`Unexpected request: ${path}`);
      await route.fulfill({ status, json: body });
    });
    await page.goto(process.env.PLAYTEST_URL || 'http://127.0.0.1:5182');
    const login = page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true });
    await login.waitFor();
    await page
      .getByText(
        'Voice, photo understanding and game decisions use your account without API keys.',
        { exact: false },
      )
      .waitFor();
    const difficulty = page.locator('.difficulty-card').first();
    assert.equal(await difficulty.isDisabled(), true);
    await login.click();
    await page.getByText('DEMO-0000', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Open OpenAI verification' }).getAttribute('href'),
      'https://auth.openai.com/codex/device',
    );
    await page.reload();
    await page.getByText('DEMO-0000', { exact: true }).waitFor();
    state = { status: 'ready', model: 'gpt-5.6-luna' };
    await page.getByText('Connected. Choose a difficulty to start.', { exact: false }).waitFor();
    assert.equal(await difficulty.isEnabled(), true);
    await page.getByRole('button', { name: 'Sign out / change account' }).click();
    await login.waitFor();
    assert.equal(logoutCount, 1);
    assert.equal(await difficulty.isDisabled(), true);
    await page.getByRole('combobox').selectOption('ja');
    await page.getByRole('button', { name: 'ChatGPTでログイン', exact: true }).click();
    await page.getByText('DEMO-0000', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    fs.mkdirSync('runs/codex-login-smoke', { recursive: true });
    await page.screenshot({ path: 'runs/codex-login-smoke/pending-mobile.png', fullPage: true });
    state = { status: 'failed' };
    await page.getByText('接続に失敗したか、期限が切れました。', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'ChatGPTでログイン', exact: true }).click();
    await page.getByText('DEMO-0000', { exact: true }).waitFor();
    assert.equal(logoutCount, 2);
    await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
    await page.getByRole('button', { name: 'ChatGPTでログイン', exact: true }).waitFor();
    enabled = false;
    await page.reload();
    await page.locator('.difficulty-card:enabled').first().waitFor();
    assert.equal(await page.locator('.codex-login').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Codex login UI smoke passed (fake auth): gating, pending/reload, ready, logout, failure/retry, cancel, Japanese/mobile, API mode.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
