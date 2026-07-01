# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through DevSpace.

ChatGPT-side developer mode access, MCP write permissions, and model/reasoning
tiers are controlled by OpenAI and can change independently of DevSpace. Verify
your current ChatGPT plan, workspace entitlements, and connector permissions in
ChatGPT itself before treating DevSpace as the blocker.

## Requirements

- Node `>=20.12 <27`; Node 22 LTS is recommended
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server

DevSpace does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

For Pinggy on Windows, prefer an explicit IPv4 SSH forward:

```bash
ssh -T -p 443 -R0:127.0.0.1:7676 qr@a.pinggy.io
```

Using `localhost:7676` can produce tunnel-side `502` errors when the local
service is listening on `127.0.0.1`.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

This same public origin is also used for DevSpace OAuth approval pages. Do not
point ChatGPT at a private-only URL unless the browser-facing OAuth endpoints
are reachable too.

If your tunnel assigns a fresh hostname each run, restart DevSpace with that
exact hostname so the host allowlist and OAuth metadata stay aligned. If the
hostname changes underneath a running DevSpace process, public requests may fail
with `Invalid Host`.

### Fast Verified Tunnel Path

One verified public HTTPS path is Cloudflare Quick Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
DEVSPACE_PUBLIC_BASE_URL="https://your-assigned.trycloudflare.com" npx @waishnav/devspace serve
npx @waishnav/devspace doctor --public
```

That sequence has been validated against DevSpace's public `/healthz`, OAuth
metadata, dynamic client registration, and Owner password approval page.

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Connect From ChatGPT Web

Use this flow when you want ChatGPT web to operate on your local machine through
DevSpace:

1. In ChatGPT web, enable developer mode.
2. Create a custom connector.
3. Enter your public DevSpace MCP URL:

```text
https://your-tunnel-host.example.com/mcp
```

4. Let ChatGPT start the OAuth flow.
5. Enter the DevSpace Owner password on the approval page.
6. Start a chat, attach the connector, and ask ChatGPT to open a project.

DevSpace does not pick the ChatGPT model or reasoning level. Choose the
strongest model and highest reasoning level available in ChatGPT before you
start the coding session.

For a fuller explanation of the network path and OAuth boundary, see
[ChatGPT Web Connection Path](./chatgpt-web-connection.md).

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
npx @waishnav/devspace doctor --live
npx @waishnav/devspace doctor --public
npx @waishnav/devspace doctor --public --full-loop
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, SQLite native dependency status, and
ChatGPT Web readiness details. `--live` also probes local health, OAuth
metadata, dynamic registration, and the Owner password approval page. `--public`
probes the configured public URL through your live tunnel or reverse proxy.
`--public --full-loop` additionally completes a real external OAuth flow and a
real `open_workspace` MCP call through that public URL.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
