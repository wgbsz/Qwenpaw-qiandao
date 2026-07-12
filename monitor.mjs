import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const platformUrl = process.env.PLATFORM_URL;
const email = process.env.PLATFORM_EMAIL;
const password = process.env.PLATFORM_PASSWORD;
const command = process.env.WAKEUP_COMMAND || '/opt/komari/wakeup.sh';
if (!platformUrl || !email || !password) throw new Error('Missing PLATFORM_URL, PLATFORM_EMAIL or PLATFORM_PASSWORD');

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
let page = await context.newPage();

async function shot(name) {
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
}

async function visible(list, timeout = 2500) {
  for (const item of list) {
    const locator = item.first();
    if (await locator.isVisible({ timeout }).catch(() => false)) return locator;
  }
  return null;
}

async function login() {
  await shot('01-before-login');

  // The public deployment page first shows a top-right Login link. Click it before looking for inputs.
  const loginEntry = await visible([
    page.getByRole('link', { name: /^登录$/ }),
    page.getByRole('button', { name: /^登录$/ }),
    page.getByText('登录', { exact: true }),
    page.getByRole('link', { name: /log\s*in|sign\s*in/i }),
    page.getByRole('button', { name: /log\s*in|sign\s*in/i }),
  ], 4000);

  if (loginEntry) {
    await loginEntry.click();
    await page.waitForTimeout(1500);
  }

  // Some login pages default to verification-code login; try switching to password login.
  const passwordTab = await visible([
    page.getByText(/密码登录|账号密码|password login/i),
    page.getByRole('tab', { name: /密码|password/i }),
  ], 1200);
  if (passwordTab) {
    await passwordTab.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const emailInput = await visible([
    page.getByLabel(/邮箱|email|账号/i),
    page.getByPlaceholder(/邮箱|email|账号/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[name*="account" i]'),
    page.locator('input[name*="username" i]'),
  ], 5000);

  if (!emailInput) {
    await shot('02-login-form-not-found');
    throw new Error('Clicked Login but no email/account input was found. The site may use verification code or third-party login.');
  }

  const passwordInput = await visible([
    page.getByLabel(/密码|password/i),
    page.getByPlaceholder(/密码|password/i),
    page.locator('input[type="password"]'),
  ], 3000);
  if (!passwordInput) {
    await shot('02-password-input-not-found');
    throw new Error('No password input was found. The account may require email verification-code login instead of password login.');
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);
  await shot('02-login-form-filled');

  const submit = await visible([
    page.getByRole('button', { name: /^登录$/ }),
    page.getByRole('button', { name: /登录|log\s*in|sign\s*in/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ], 3000);
  if (!submit) throw new Error('Login submit button was not found.');

  await submit.click();
  await page.waitForTimeout(5000);
  await shot('03-after-login-submit');

  const stillLoggedOut = await page.getByText('免费注册', { exact: true }).isVisible().catch(() => false);
  const passwordStillVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  if (stillLoggedOut || passwordStillVisible) {
    throw new Error('Login did not succeed. Check credentials and whether verification code, CAPTCHA or MFA is required.');
  }
}

async function getButton(pattern, timeout = 5000) {
  const locator = page.getByRole('button', { name: pattern }).first();
  return await locator.isVisible({ timeout }).catch(() => false) ? locator : null;
}

try {
  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const loggedOut = await page.getByText('免费注册', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
  if (loggedOut) await login();

  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await shot('04-deployment-page');

  let stopButton = await getButton(/停止运行/);
  if (!stopButton) {
    let startButton = await getButton(/启动运行|一键部署\s*QwenPaw/i);
    if (!startButton) {
      await shot('05-start-button-not-found');
      throw new Error('No Start/Deploy or Stop button found after login. Check PLATFORM_URL and login status.');
    }

    console.log('Platform is stopped or not deployed; starting it now.');
    await startButton.click();
    await page.waitForTimeout(2000);

    // Wait for either the running control or the Open QwenPaw control.
    await Promise.race([
      page.getByRole('button', { name: /停止运行/ }).first().waitFor({ state: 'visible', timeout: 180000 }),
      page.getByRole('button', { name: /打开\s*QwenPaw/i }).first().waitFor({ state: 'visible', timeout: 180000 }),
    ]).catch(() => {});
  }

  await shot('05-platform-running');

  const openButton = await getButton(/打开\s*QwenPaw/i, 15000);
  if (!openButton) throw new Error('Platform started, but Open QwenPaw button was not found.');

  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await openButton.click();
  const popup = await popupPromise;
  if (popup) page = popup;

  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot('06-qwenpaw-opened');

  const input = await visible([
    page.locator('textarea'),
    page.locator('[contenteditable="true"]'),
    page.getByRole('textbox'),
  ], 10000);
  if (!input) throw new Error('QwenPaw opened, but the command input was not found.');

  await input.fill(command);
  await shot('07-command-filled');
  await input.press('Enter');
  console.log(`Command sent: ${command}`);

  const busy = page.locator('[aria-busy="true"], button:has-text("停止生成"), button:has-text("Stop")').first();
  if (await busy.isVisible({ timeout: 10000 }).catch(() => false)) {
    await busy.waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {});
  } else {
    await page.waitForTimeout(30000);
  }
  await shot('08-command-finished');
} catch (error) {
  await shot('99-error');
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
