import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const platformUrl = process.env.PLATFORM_URL;
const email = process.env.PLATFORM_EMAIL;
const password = process.env.PLATFORM_PASSWORD;
const command = process.env.WAKEUP_COMMAND || '/opt/komari/wakeup.sh';

if (!platformUrl || !email || !password) {
  throw new Error('缺少 PLATFORM_URL、PLATFORM_EMAIL 或 PLATFORM_PASSWORD');
}

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
let page = await context.newPage();

async function shot(name) {
  await page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    fullPage: true,
  }).catch(() => {});
}

async function firstVisible(candidates, timeout = 3000) {
  for (const locator of candidates) {
    if (await locator.first().isVisible({ timeout }).catch(() => false)) return locator.first();
  }
  return null;
}

async function loginIfNeeded() {
  await shot('01-page-opened');

  const emailInput = await firstVisible([
    page.getByLabel(/邮箱|email/i),
    page.getByPlaceholder(/邮箱|email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[name*="account" i]'),
  ]);

  if (!emailInput) {
    console.log('当前页面未发现邮箱输入框，可能已经登录。');
    return;
  }

  const passwordInput = await firstVisible([
    page.getByLabel(/密码|password/i),
    page.getByPlaceholder(/密码|password/i),
    page.locator('input[type="password"]'),
  ]);
  if (!passwordInput) throw new Error('找到邮箱输入框，但没有找到密码输入框。');

  await emailInput.fill(email);
  await passwordInput.fill(password);
  await shot('02-login-form-filled');

  const loginButton = await firstVisible([
    page.getByRole('button', { name: /登录|log in|login|sign in/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ]);
  if (!loginButton) throw new Error('没有找到登录按钮。');

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
    loginButton.click(),
  ]);
  await page.waitForTimeout(5000);

  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
    await shot('login-failed');
    throw new Error('登录后仍停留在登录页。请检查邮箱、密码，或确认是否存在验证码/MFA。');
  }

  await shot('03-login-success');
  console.log('邮箱登录完成。');
}

async function buttonByText(text) {
  const button = page.getByRole('button', { name: text, exact: false }).first();
  return await button.isVisible({ timeout: 5000 }).catch(() => false) ? button : null;
}

try {
  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loginIfNeeded();

  // 登录后重新访问目标部署页，避免停留在首页或回调页。
  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await shot('04-platform-after-login');

  let runningButton = await buttonByText('停止运行');
  if (!runningButton) {
    const startButton = await buttonByText('启动运行');
    if (!startButton) {
      await shot('platform-status-not-found');
      throw new Error('未找到“停止运行”或“启动运行”按钮。可能登录失败、URL错误或页面已改版。');
    }

    console.log('平台已停止，正在启动。');
    await startButton.click();
    await page.getByRole('button', { name: '停止运行', exact: false }).first()
      .waitFor({ state: 'visible', timeout: 180000 });
  } else {
    console.log('平台已经处于运行状态。');
  }

  await shot('05-platform-running');

  const openButton = page.getByRole('button', { name: /打开\s*QWENPAW/i }).first();
  await openButton.waitFor({ state: 'visible', timeout: 30000 });

  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await openButton.click();
  const popup = await popupPromise;
  if (popup) page = popup;

  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot('06-qwenpaw-opened');

  const input = await firstVisible([
    page.locator('textarea'),
    page.locator('[contenteditable="true"]'),
    page.getByRole('textbox'),
  ], 10000);
  if (!input) throw new Error('进入QwenPaw后未找到消息输入框。');

  await input.fill(command);
  await shot('07-command-filled');
  await input.press('Enter');
  console.log(`已发送命令: ${command}`);

  const busy = page.locator('[aria-busy="true"], button:has-text("停止生成"), button:has-text("Stop")').first();
  if (await busy.isVisible({ timeout: 10000 }).catch(() => false)) {
    await busy.waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {});
  } else {
    await page.waitForTimeout(30000);
  }

  await shot('08-command-finished');
  console.log('执行完成，关闭浏览器会话；不会停止平台。');
} catch (error) {
  await shot('99-error');
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
