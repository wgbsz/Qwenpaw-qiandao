# QwenPaw 平台自动巡检脚本

此仓库使用 **GitHub Actions + Playwright** 自动完成：

1. 打开部署页面并使用已有登录状态；
2. 如果看到“停止运行”，认定平台已经运行；
3. 如果看到“启动运行”，点击启动并等待“停止运行”出现；
4. 点击“打开 QWENPAW”；
5. 在聊天输入框发送 `/opt/komari/wakeup.sh`；
6. 等待界面结束忙碌状态，随后关闭浏览器会话。**不会点击“停止运行”**。

> 仅用于您有权管理的平台。登录信息只放 GitHub Actions Secrets，切勿提交 `auth.json`。

## 还需要准备的内容

- 部署页面的完整 URL（截图中包含“启动运行/停止运行”“打开 QWENPAW”的页面）；
- 一次有效登录状态 `auth.json`；
- 如果页面按钮文字或输入框结构不同，需要调整 `config.example.json` 中的 selectors；
- 明确执行频率。默认 GitHub cron 为每 6 小时一次，分钟数为 17；GitHub 定时任务使用 UTC 且可能延迟。

## 本地生成登录状态

需要 Node.js 20+：

```bash
npm install
npx playwright install chromium
PLATFORM_URL='https://你的部署页地址' npm run auth
```

浏览器打开后手动登录并进入部署页，然后回到终端按回车，会生成 `auth.json`。

把文件编码为一行：

Linux：

```bash
base64 -w 0 auth.json
```

macOS：

```bash
base64 < auth.json | tr -d '\n'
```

将输出完整复制到 GitHub 仓库：**Settings → Secrets and variables → Actions → New repository secret**，创建：

- `STORAGE_STATE_B64`：上一步的 Base64；
- `PLATFORM_URL`：部署页面完整 URL。

## 上传到 GitHub

新建一个私有仓库，把本目录全部文件上传。进入 **Actions**，选择 `QwenPaw Platform Watchdog`，点击 **Run workflow** 做第一次测试。

运行结束后，在该次 Action 的 **Artifacts** 下载诊断截图。若提示找不到按钮或输入框，可依据截图修改 `config.example.json`。

## 修改执行频率

编辑 `.github/workflows/watchdog.yml`：

```yaml
schedule:
  - cron: "17 */6 * * *"
```

例如每天 UTC 02:30：

```yaml
schedule:
  - cron: "30 2 * * *"
```

## 重要限制

- GitHub Actions 不能保证精确到分钟触发；繁忙时可能延迟。
- 登录 Cookie 过期、出现验证码/MFA、平台改版后，需要重新生成登录状态或更新选择器。
- 网页通常不能直接证明 `/opt/komari/wakeup.sh` 的真实 shell 退出码。本脚本会等待聊天界面结束忙碌状态并截图；如 QwenPaw 有明确的“执行完成”文本，可进一步配置成精确等待。
- 默认等待命令最多 5 分钟，整个 Workflow 最多 15 分钟。
