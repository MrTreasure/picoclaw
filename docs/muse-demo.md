# Muse 截图复现与演示边界

## 已截取的页面

| 图片 | 真实页面 | 数据 |
| --- | --- | --- |
| `screenshots/muse-sessions.webp` | `/sessions` | 两段预置 Muse 历史会话 |
| `screenshots/muse-chat.webp` | `/?session_id=...` | 真实 Markdown 与表格渲染 |
| `screenshots/muse-mobile.webp` | 同一会话的移动窗口 | PWA 页面，不是原生 APK |
| `screenshots/muse-skills.webp` | `/agent/skills` | 两个独立编写的演示 Skill |

这些截图由编译后的真实 Launcher 和内嵌前端提供，未伪造 API 响应、网关运行状态或模型结果。模型未配置，网关不启动；对话文字是预置样例。会话页保留了 Codex 未连接时的提示，展示可继续阅读 Muse 历史的降级状态。

## 从源码复现

在仓库根目录执行，Go 版本以 `go.mod` 为准：

```sh
pnpm --dir web/frontend install --frozen-lockfile
pnpm --dir web/frontend run build:backend
mkdir -p build
CGO_ENABLED=0 go build -o build/picoclaw-launcher ./web/backend
pnpm --dir web/frontend exec playwright install chromium
pnpm --dir web/frontend run screenshots:readme
```

如果本机已编译 Launcher 或安装兼容 Chromium，可使用：

```sh
MUSE_LAUNCHER_BINARY=/path/to/picoclaw-launcher \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium \
pnpm --dir web/frontend run screenshots:readme
```

## 脚本如何隔离数据

1. 为每次运行建立独立的 `.cache/readme-captures/<随机 ID>/`。
2. 将 `docs/examples/readme-demo.json` 的虚构对话写入该目录的工作区。
3. 为临时 Launcher 使用独立 `PICOCLAW_HOME`、配置和演示 Skills 目录，只监听 `127.0.0.1:18809`。
4. 创建临时登录凭据，不读取密码本或生产配置，不调用在线模型。
5. 禁止浏览器连接此分支的宿主机 Codex 接口，避免读取真实线程；不浏览生产静态页目录。
6. 截图后关闭浏览器与临时进程。截图进入 `docs/screenshots/`；运行文件留在被 Git 忽略的 `.cache/` 中。

截图不证明模型效果、真实 Codex 审批、离线冷启动、通知可靠性或 Android 原生客户端行为。这些行为需在各自已配置的环境验收。
