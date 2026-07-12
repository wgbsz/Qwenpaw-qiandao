import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const artifactDir = path.resolve('artifacts');
fs.mkdirSync(artifactDir, { recursive: true });

function loadConfig() {
  const p = process.env.CONFIG_PATH || 'config.json';
  const fallback = 'config.example.json';
  const config = JSON.parse(fs.readFileSync(fs.existsSync(p) ? p : fallback, 'utf8'));
  config.platformUrl = process.env.PLATFORM_URL || config.platformUrl;
  config.command = process.env.WAKEUP_COMMAND || config.command;
  if (!config.platformUrl || config.platformUrl.includes('请替换')) {
    throw new Error('缺少 PLATFORM_URL（部署页面完整 URL）');
  }
  return config;
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(artifactDir, `${Date.now()}-${name}.png`), fullPage: true }).catch(() => {});
}

async function visibleByText(page, text) {
  const loc = page.getByRole('button', { name: text, exact: false }).first();
  return (await loc.count()) > 0 && await loc.isVisible().catch(() => false) ? loc : null;
}

const config = loadConfig();
const authPath = process.env.AUTH_FILE || 'auth.json';
const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const context = await browser.newContext(fs.existsSync(authPath) ? { storageState: authPath } : {});
let page = await context.newPage();

try {
  await page.goto(config.platformUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigationMs });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await screenshot(page, 'deployment-page');

  const stopButton = await visibleByText(page, config.selectors.runningButtonText);
  if (stopButton) {
    console.log('检测结果：平台正在运行。');
  } else {
    const startButton = await visibleByText(page, config.selectors.startButtonText);
    if (!startButton) throw new Error('未找到“运行中”或“启动运行”按钮，可能登录失效或页面文本/选择器已变化。');
    console.log('检测结果：平台已停止，正在启动。');
    await startButton.click();
    await page.getByRole('button', { name: config.selectors.runningButtonText, exact: false })
      .waitFor({ state: 'visible', timeout: config.timeouts.startupMs });
    console.log('平台已进入运行状态。');
  }

  const openButton = page.getByRole('button', { name: config.selectors.openButtonText, exact: false }).first();
  await openButton.waitFor({ state: 'visible', timeout: 30000 });

  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await openButton.click();
  const popup = await popupPromise;
  if (popup) page = popup;
  await page.waitForLoadState('domcontentloaded', { timeout: config.timeouts.navigationMs }).catch(() => {});

  const input = page.locator(config.selectors.chatInput).filter({ visible: true }).last();
  await input.waitFor({ state: 'visible', timeout: config.timeouts.navigationMs });
  await input.click();
  if (await input.getAttribute('contenteditable') === 'true') await input.fill(config.command);
  else await input.fill(config.command);
  await screenshot(page, 'command-filled');
  await input.press('Enter');
  console.log(`已发送命令：${config.command}`);

  // 这里无法可靠获知远端 shell 的真实退出码；等待页面由“忙碌”恢复，并保留最长等待兜底。
  const busy = page.locator('[aria-busy="true"], button:has-text("停止生成"), button:has-text("Stop")').first();
  if (await busy.isVisible({ timeout: 10000 }).catch(() => false)) {
    await busy.waitFor({ state: 'hidden', timeout: config.timeouts.commandMs }).catch(() => {});
  } else {
    await page.waitForTimeout(Math.min(30000, config.timeouts.commandMs));
  }
  await screenshot(page, 'command-finished');
  console.log('命令等待阶段结束，正在退出（关闭浏览器会话，不停止平台运行）。');
} catch (error) {
  await screenshot(page, 'error');
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
