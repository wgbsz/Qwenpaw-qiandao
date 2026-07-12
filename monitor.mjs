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
  throw new Error('Missing PLATFORM_URL, PLATFORM_EMAIL or PLATFORM_PASSWORD');
}

const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
let page = await context.newPage();

async function shot(name) {
  await page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    fullPage: true,
  }).catch(() => {});
}

async function firstVisible(locators, timeout = 2500) {
  for (const candidate of locators) {
    const locator = candidate.first();
    if (await locator.isVisible({ timeout }).catch(() => false)) return locator;
  }
  return null;
}

async function isLoggedOut() {
  const passwordField = page.locator('input[type="password"]').first();
  if (await passwordField.isVisible({ timeout: 1200 }).catch(() => false)) return true;

  const registerText = page.getByText('免费注册', { exact: true }).first();
  const loginText = page.getByText('登录', { exact: true }).first();
  return (
    await registerText.isVisible({ timeout: 1200 }).catch(() => false) &&
    await loginText.isVisible({ timeout: 1200 }).catch(() => false)
  );
}

async function login() {
  await shot('01-before-login');

  let passwordInput = await firstVisible([
    page.locator('input[type="password"]'),
    page.getByLabel(/密码|password/i),
    page.getByPlaceholder(/密码|password/i),
  ], 1500);

  // The deployment page initially shows a Login entry in the top-right corner.
  if (!passwordInput) {
    const loginEntry = await firstVisible([
      page.getByRole('link', { name: /^登录$/ }),
      page.getByRole('button', { name: /^登录$/ }),
      page.getByText('登录', { exact: true }),
      page.getByRole('link', { name: /log\s*in|sign\s*in/i }),
    ], 5000);

    if (!loginEntry) throw new Error('The Login entry was not found on the public page.');
    await loginEntry.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    passwordInput = await firstVisible([
      page.locator('input[type="password"]'),
      page.getByLabel(/密码|password/i),
      page.getByPlaceholder(/密码|password/i),
    ], 10000);
  }

  if (!passwordInput) {
    await shot('02-password-input-not-found');
    throw new Error('The password input was not found after opening the login page.');
  }

  // Scope all selectors to the actual form containing the password field. This avoids
  // clicking the separate Login item in the site header.
  const form = passwordInput.locator('xpath=ancestor::form[1]');
  const formExists = await form.count() > 0;
  const scope = formExists ? form : page.locator('body');

  const emailInput = await firstVisible([
    scope.locator('input[type="email"]'),
    scope.locator('input[name*="email" i]'),
    scope.locator('input[name*="account" i]'),
    scope.locator('input[name*="username" i]'),
    scope.getByLabel(/邮箱|email|账号/i),
    scope.getByPlaceholder(/邮箱|email|账号/i),
  ], 5000);

  if (!emailInput) {
    await shot('02-email-input-not-found');
    throw new Error('The email input was not found inside the login form.');
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);
  await shot('02-login-form-filled');

  const submit = await firstVisible([
    scope.locator('button[type="submit"]'),
    scope.getByRole('button', { name: /^登录$/ }),
    scope.getByRole('button', { name: /log\s*in|sign\s*in/i }),
    scope.locator('input[type="submit"]'),
  ], 5000);

  if (!submit) throw new Error('The submit button was not found inside the login form.');

  const originalUrl = page.url();
  await submit.click();

  // Wait for the login form to disappear or the URL to change. Do not treat the
  // temporary Loading page as a failed login.
  await Promise.race([
    passwordInput.waitFor({ state: 'hidden', timeout: 60000 }),
    page.waitForURL(url => url.toString() !== originalUrl, { timeout: 60000 }),
  ]).catch(() => {});

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !document.body.innerText.trim().match(/^加载中[.。．…]*$/), null, {
    timeout: 60000,
  }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot('03-after-login-submit');

  // The decisive check is whether the real login form is still visible.
  if (await passwordInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const errorText = await scope.locator('[role="alert"], .error, .ant-form-item-explain-error')
      .allTextContents().catch(() => []);
    throw new Error(`Login form is still visible after submission${errorText.length ? `: ${errorText.join(' ')}` : ''}.`);
  }

  console.log('Login form disappeared; continuing to the deployment page.');
}

async function button(pattern, timeout = 5000) {
  const locator = page.getByRole('button', { name: pattern }).first();
  return await locator.isVisible({ timeout }).catch(() => false) ? locator : null;
}

try {
  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  if (await isLoggedOut()) await login();

  // Always revisit the exact deployment URL after authentication.
  await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !document.body.innerText.includes('加载中...'), null, {
    timeout: 60000,
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await shot('04-deployment-page');

  if (await isLoggedOut()) {
    throw new Error('The deployment page is still logged out after login. The site may have rejected the credentials or require additional verification.');
  }

  let stopButton = await button(/停止运行/);
  if (!stopButton) {
    const startButton = await button(/启动运行|一键部署\s*QwenPaw/i, 10000);
    if (!startButton) {
      await shot('05-start-button-not-found');
      throw new Error('No Start, Deploy, or Stop button was found on the authenticated deployment page.');
    }

    console.log('Platform is stopped or not deployed; starting it now.');
    await startButton.click();

    await Promise.race([
      page.getByRole('button', { name: /停止运行/ }).first().waitFor({ state: 'visible', timeout: 180000 }),
      page.getByRole('button', { name: /打开\s*QwenPaw/i }).first().waitFor({ state: 'visible', timeout: 180000 }),
    ]).catch(() => {});
  } else {
    console.log('Platform is already running.');
  }

  await shot('05-platform-running');

  const openButton = await button(/打开\s*QwenPaw/i, 15000);
  if (!openButton) throw new Error('The Open QwenPaw button was not found after startup.');

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
