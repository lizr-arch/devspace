# LLM Setup Guide — DevSpace 一键部署指南

> **目标读者**：在新机器上运行的大模型（ChatGPT、Claude、Hermes 等）。
> **目标**：阅读本文后，在本地完成 DevSpace 的安装、配置、启动，并连接到 ChatGPT Web。

---

## 1. 环境预检

在开始之前，确认以下工具已安装：

```bash
node --version     # 需要 >=20.12，推荐 22 LTS
npm --version
git --version
ngrok version      # 需要 ngrok v3，且已登录 (ngrok config add-authtoken)
```

如果没有 ngrok，去 https://ngrok.com/download 下载，然后用 `ngrok config add-authtoken <你的token>` 登录。

## 2. 克隆仓库

```bash
git clone https://github.com/lizr-arch/devspace.git
cd devspace
```

## 3. 安装依赖并编译

```bash
npm install
npm run build
```

编译产物在 `dist/` 目录。

## 4. 配置环境变量

项目里已有 `.env.example` 模板。复制并编辑：

```bash
cp .env.example .env
```

编辑 `.env`，关键配置项：

```env
HOST=127.0.0.1
PORT=7676
DEVSPACE_ALLOWED_ROOTS=/home/yourname/projects,/home/yourname/work
DEVSPACE_PUBLIC_BASE_URL=https://your-domain.ngrok-free.dev
DEVSPACE_TOOL_MODE=full
DEVSPACE_TOOL_NAMING=legacy
DEVSPACE_WIDGETS=changes
DEVSPACE_LOG_LEVEL=info
DEVSPACE_LOG_FORMAT=json
```

**重点说明**：
- `DEVSPACE_ALLOWED_ROOTS`：允许 ChatGPT 访问的本地目录，逗号分隔。必须是**绝对路径**。
- `DEVSPACE_PUBLIC_BASE_URL`：你的 ngrok 静态域名。去 https://dashboard.ngrok.com/cloud-edge/domains 申请一个免费的静态域名（如 `xxx.ngrok-free.dev`），填在这里。**不需要 `/mcp` 后缀**。

## 5. 首次初始化（生成 OAuth 密钥）

```bash
npx devspace init
```

交互式向导会问你：
- Project location → 直接回车（env 里已配）
- Port → 直接回车
- Public base URL → 直接回车

完成后会在 `~/.devspace/auth.json` 生成 Owner password。**记下这个密码**，ChatGPT 连接时需要。

## 6. 启动 ngrok 隧道

开一个新的终端窗口（或后台运行）：

```bash
ngrok http 7676 --url=你的静态域名.ngrok-free.dev
```

看到 `Forwarding https://xxx.ngrok-free.dev -> http://localhost:7676` 即成功。

## 7. 启动 DevSpace

```bash
node dist/cli.js serve
```

看到 `DevSpace server listening on http://127.0.0.1:7676` 即成功。

### 一键启动（Windows bat 脚本，可选）

创建 `start.bat`：

```bat
@echo off
cd /d <devspace-repo-path>
start "DevSpace" cmd /c "node dist\cli.js serve"
timeout /t 4 /nobreak >nul
start "ngrok" cmd /c "ngrok http 7676 --url=你的域名.ngrok-free.dev"
```

## 8. 验证

```bash
# 本地服务是否正常（应返回 401）
curl -s http://127.0.0.1:7676/mcp -w "%{http_code}"

# ngrok 隧道是否正常
curl -s http://127.0.0.1:4040/api/tunnels | grep public_url

# 公网访问（Windows SSL 问题加 -k）
curl -k -s https://你的域名.ngrok-free.dev/mcp -w "%{http_code}"
```

## 9. 连接 ChatGPT

1. 打开 ChatGPT → 设置 → Developer mode（需要 Plus/Pro 订阅）
2. 添加 Custom MCP Connector
3. URL 填：`https://你的域名.ngrok-free.dev/mcp`
4. ChatGPT 会自动跳转到 OAuth 审批页面
5. 输入你在步骤 5 记下的 **Owner password**
6. 授权完成，ChatGPT 即可调用 DevSpace 工具

## 10. 使用

在 ChatGPT 中说：

> "Open the workspace at /home/yourname/projects/my-repo"

ChatGPT 会调用 `open_workspace`，之后就能读写文件、搜索代码、执行命令。

如果只想让 ChatGPT **读代码、不修改**，启动时加：

```bash
DEVSPACE_READ_ONLY=1 node dist/cli.js serve
```

## 常见问题

| 问题 | 解决 |
|------|------|
| `Error: connect ECONNREFUSED 127.0.0.1:7676` | DevSpace 没启动，先执行步骤 7 |
| ngrok 报 `ERR_NGROK_3200` | 检查 DevSpace 是否在 7676 端口运行 |
| `curl` 公网 URL 返回 000 | Windows SSL 问题，用 `curl -k` 跳过证书校验 |
| OAuth 过期断开 | ChatGPT 会自动刷新 token。如果断了，在 ChatGPT MCP 设置里重新连接即可 |
| 域名被占用 | `taskkill /F /IM ngrok.exe`（Windows）或 `pkill ngrok`（Linux/Mac） |

---

## 开发模式（修改 DevSpace 源码时使用）

```bash
npm run dev     # 热重载开发服务器
npm test        # 运行测试
npm run build   # 编译
```
