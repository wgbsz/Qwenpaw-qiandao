import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.env.PLATFORM_URL;
if (!url) throw new Error('请先设置 PLATFORM_URL');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
console.log('请在打开的浏览器中手动完成登录，回到部署页后在终端按回车。');
await new Promise(resolve => process.stdin.once('data', resolve));
await context.storageState({ path: 'auth.json' });
await browser.close();
console.log('已生成 auth.json。请勿提交到 GitHub；按 README 转为 GitHub Secret。');
