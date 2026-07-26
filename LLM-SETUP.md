# LLM Setup Guide — DevSpace 一键部署指南

> **目标读者**：在新机器上协助部署 DevSpace 的 ChatGPT、Codex、Claude
> 等模型。
>
> **目标**：完成本地 DevSpace、独立 Cloudflare Named Tunnel、OAuth 和
> ChatGPT MCP Connector 的配置。不得复用其他机器的密码、token 或 Tunnel。

本文提供跨平台公共流程和 Windows 快速路径。Cloudflare 的完整配置、安全及
故障排查说明见
[`docs/cloudflare-named-tunnel.md`](./docs/cloudflare-named-tunnel.md)。

## 安全边界

开始前必须遵守：

- 每台独立 DevSpace 机器使用独立 Tunnel、子域名和 Connector。
- `DEVSPACE_ALLOWED_ROOTS` 只允许确实需要访问的目录。
- 不得读取、复制或提交 `~/.devspace/auth.json`。
- 不得把 Cloudflare Tunnel token 或 Owner password 发到聊天中。
- DevSpace 和 Tunnel 上游都绑定 `127.0.0.1`，不开放公网监听端口。
- 公网 URL 使用有效 TLS；不得用 `curl -k` 绕过证书验证。

当前 Mac 已占用：

```text
Tunnel: devspace-mac
Origin: https://mcp.workspaceport.com
MCP:    https://mcp.workspaceport.com/mcp
```

新 Windows 机器应使用：

```text
Tunnel: devspace-windows
Origin: https://mcp-windows.workspaceport.com
MCP:    https://mcp-windows.workspaceport.com/mcp
```

创建 Windows 配置时不得修改或替换现有 `devspace-mac` Route。

## 1. 环境预检

DevSpace 需要 Node `>=20.12 <27`，推荐 Node 22 LTS。

在 PowerShell 中检查：

```powershell
node --version
npm --version
git --version
cloudflared.exe --version
```

如果缺少 `cloudflared`，从 Cloudflare
[官方下载页](https://developers.cloudflare.com/tunnel/downloads/)
安装与当前 Windows 机器架构匹配的版本。不要从第三方下载二进制文件。

## 2. 克隆或更新仓库

首次安装：

```powershell
git clone https://github.com/lizr-arch/devspace.git
Set-Location devspace
```

已有 checkout：

```powershell
Set-Location <DEVSPACE_REPO_PATH>
git status -sb
git pull --ff-only origin main
```

如果工作区有未提交变更，不要 reset、stash 或覆盖；先报告给用户。

## 3. 安装依赖并构建

```powershell
npm install --include=dev
npm run build
npm run typecheck
```

构建产物位于 `dist/`。

## 4. 初始化 DevSpace

运行：

```powershell
node dist/cli.js init
```

设置：

- Project roots：当前 Windows 机器允许访问的绝对路径。
- Port：通常为 `7676`。
- Public base URL：`https://mcp-windows.workspaceport.com`，不带 `/mcp`。

初始化会在当前 Windows 用户的 DevSpace 配置目录生成 OAuth Owner
password。用户必须在本机保存密码，不得让模型读取或输出它。

也可以在初始化后持久化稳定域名：

```powershell
node dist/cli.js config set publicBaseUrl https://mcp-windows.workspaceport.com
```

## 5. 创建独立 Windows Tunnel

这一步需要用户登录 Cloudflare Dashboard：

1. 打开 **Networking > Tunnels**。
2. 创建 `devspace-windows`，不要向 `devspace-mac` 添加 Replica。
3. 添加 Published application Route：

```text
Hostname: mcp-windows.workspaceport.com
Service:  http://127.0.0.1:7676
```

4. 选择 Windows Connector。
5. 在本机以管理员身份打开 **Command Prompt**。
6. 只在本地终端运行 Cloudflare 生成的命令：

```bat
cloudflared.exe service install <TUNNEL_TOKEN>
```

不要把真实命令或 token 粘贴到聊天、代码、文档或截图。安装后关闭该管理员
终端。Tunnel token 泄漏后必须立即在 Cloudflare 旋转。

检查 Windows 服务：

```bat
sc.exe query cloudflared
```

Cloudflare Dashboard 中应显示 Tunnel 为 **Healthy**。如果该机器已经存在
另一个 `cloudflared` 服务，不得直接覆盖；先确认它所属的 Tunnel 和 Route。

详细 Windows 安装、更新和安全说明见
[`docs/cloudflare-named-tunnel.md`](./docs/cloudflare-named-tunnel.md#6-run-cloudflared-at-boot-on-windows)。

## 6. 启动 DevSpace

回到普通 PowerShell：

```powershell
Set-Location <DEVSPACE_REPO_PATH>
node dist/cli.js serve
```

DevSpace 应监听：

```text
http://127.0.0.1:7676
```

不要改为 `0.0.0.0`。Cloudflare Tunnel 在同一台机器通过 IPv4 loopback
访问它。

## 7. 完整验证

使用第二个 PowerShell 窗口：

```powershell
Set-Location <DEVSPACE_REPO_PATH>
curl.exe -fsS http://127.0.0.1:7676/healthz
node dist/cli.js doctor --live
curl.exe -fsS https://mcp-windows.workspaceport.com/healthz
node dist/cli.js doctor --public
node dist/cli.js doctor --public --full-loop
```

必须以 `doctor --public --full-loop` 成功作为公网验收。单独看到 Tunnel
Healthy、`healthz` 返回成功或 OAuth 页面可以打开，都不等于完整 MCP 链路
已经通过。

如果 TLS 验证失败，不得添加 `-k`。检查系统时间、DNS、证书、代理或网络
拦截。

## 8. 创建 ChatGPT Connector

在 ChatGPT Developer mode 中新建：

```text
Name: DevSpaceWindows Cloudflare
URL:  https://mcp-windows.workspaceport.com/mcp
Auth: DevSpace 提供的 OAuth
```

OAuth 页面由用户亲自输入该 Windows 实例的 Owner password。不要在聊天中
发送密码。

连接后新建聊天，加载 `DevSpaceWindows Cloudflare` 并依次验证：

```text
devspace_info
list_workspaces
```

如果需要打开项目，再调用 `open_workspace`。不得用 Windows Connector
操作 Mac 的 `mcp.workspaceport.com`，也不得让旧 ngrok Connector 转发到
新 Connector。

## 9. 更新 Windows 机器

更新 DevSpace：

```powershell
Set-Location <DEVSPACE_REPO_PATH>
git status -sb
git pull --ff-only origin main
npm install --include=dev
npm run build
npm run typecheck
node dist/cli.js doctor --live
node dist/cli.js doctor --public --full-loop
```

如果存在未提交变更，停止更新并报告；不得执行 `git reset --hard`。

Windows `cloudflared` 不会自动更新。在管理员 Command Prompt 中停止服务，
使用原来的安装方式更新，然后重新启动：

```bat
sc.exe stop cloudflared
sc.exe start cloudflared
cloudflared.exe --version
```

更新 `cloudflared`、DevSpace、Tunnel Route、token 或域名后，都要重新运行
完整公网 doctor。

## 常见问题

| 问题                          | 处理                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:7676` | DevSpace 未启动，先运行 `node dist/cli.js serve`。                  |
| Cloudflare `502`              | 确认本地 `healthz` 成功，Route 必须指向 `http://127.0.0.1:7676`。   |
| `Invalid Host`                | `publicBaseUrl` 与实际域名不一致；修正后重启 DevSpace。             |
| Tunnel `Down`                 | 检查 `sc.exe query cloudflared`、网络和 Cloudflare Dashboard 日志。 |
| Tunnel `Degraded`             | 检查出站 UDP/TCP `7844`；允许自动 QUIC/HTTP2 fallback。             |
| OAuth 失败                    | 确认 Connector URL 带 `/mcp`，而 `publicBaseUrl` 不带 `/mcp`。      |
| ChatGPT 显示旧工具            | 重新连接 Connector；服务健康后用新聊天验证工具快照。                |
| 已存在 `cloudflared` 服务     | 不得覆盖；先识别现有 Tunnel，独立机器应使用独立 Route。             |

## 开发模式

修改 DevSpace 源码时：

```powershell
npm run dev
npm test
npm run test:mcp
npm run build
```

自动测试不能替代真实 `doctor --public --full-loop` 和 ChatGPT Connector
验收。
