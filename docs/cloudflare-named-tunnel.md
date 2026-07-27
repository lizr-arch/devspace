# Cloudflare Named Tunnel

Use a Cloudflare Named Tunnel when DevSpace needs a stable public MCP hostname
that survives `cloudflared` restarts. Cloudflare Quick Tunnels remain useful for
short smoke tests, but their generated hostname can change on every run.

This guide uses a remotely managed tunnel created in the Cloudflare dashboard.
The examples intentionally use placeholders. Never commit a real tunnel token,
Cloudflare account ID, Owner password, or the contents of
`~/.devspace/auth.json`.

## Current Reference Deployment

The current macOS DevSpace deployment uses these non-secret values:

| Setting       | Value                               |
| ------------- | ----------------------------------- |
| Domain        | `workspaceport.com`                 |
| Tunnel name   | `devspace-mac`                      |
| Public origin | `https://mcp.workspaceport.com`     |
| MCP endpoint  | `https://mcp.workspaceport.com/mcp` |
| Local service | `http://127.0.0.1:7676`             |

The Cloudflare account ID, tunnel ID, connector token, DevSpace Owner password,
and local configuration files are deliberately not recorded in Git. A second
machine should use a new tunnel and hostname such as
`mcp-windows.workspaceport.com`; it must not replace the current Mac route.

## Resulting Network Path

```text
MCP client
  -> https://mcp-mac.example.com/mcp
  -> Cloudflare edge
  -> outbound Cloudflare Tunnel
  -> http://127.0.0.1:7676
  -> DevSpace
```

The tunnel opens outbound connections only. DevSpace should continue listening
on the loopback interface rather than a public interface.

## Prerequisites

- A domain managed by Cloudflare DNS
- DevSpace running at `http://127.0.0.1:7676`
- A current `cloudflared` release
- Outbound TCP and UDP port `7844` permitted where possible

Install `cloudflared` on macOS with:

```bash
brew install cloudflared
cloudflared --version
```

Cloudflare also publishes packages and binaries for Linux, Windows, and macOS
in its [official download guide](https://developers.cloudflare.com/tunnel/downloads/).
On Windows, use the current executable or MSI that matches the machine's
architecture and run it from an Administrator terminal when installing the
system service.

## 1. Allocate One Hostname Per DevSpace Machine

Use a distinct hostname and tunnel for each independently operated DevSpace
machine:

| Machine             | Tunnel name        | Public hostname           | Local service           |
| ------------------- | ------------------ | ------------------------- | ----------------------- |
| macOS workstation   | `devspace-mac`     | `mcp-mac.example.com`     | `http://127.0.0.1:7676` |
| Windows workstation | `devspace-windows` | `mcp-windows.example.com` | `http://127.0.0.1:7676` |
| Linux workstation   | `devspace-linux`   | `mcp-linux.example.com`   | `http://127.0.0.1:7676` |

Do not reuse one tunnel token for unrelated DevSpace origins. Cloudflare
replicas are intended to provide failover for the same logical service; they do
not select the correct origin for independent workstations.

## 2. Create The Tunnel And Published Route

In the Cloudflare dashboard:

1. Open **Networking > Tunnels**.
2. Create a remotely managed tunnel such as `devspace-mac`.
3. Select the operating system for the DevSpace machine.
4. Copy the generated connector command, but treat its token as a secret.
5. Wait for the connector to become healthy.
6. Add a **Published application** route.
7. Set its hostname to `mcp-mac.example.com`.
8. Set its service URL to `http://127.0.0.1:7676`.

Use `127.0.0.1`, not `localhost`. A tunnel process that resolves `localhost` to
IPv6 first cannot reach a DevSpace listener bound only to IPv4.

Cloudflare automatically creates the DNS record for a published application
added through the dashboard. See Cloudflare's
[dashboard tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
and [routing reference](https://developers.cloudflare.com/tunnel/routing/) for
the current dashboard flow.

## 3. Store The Connector Token Outside The Repository

The dashboard command contains a token after `--token`. Copy only that token
into a private file on the target machine:

```bash
mkdir -p "$HOME/.config/cloudflared"
chmod 700 "$HOME/.config/cloudflared"
touch "$HOME/.config/cloudflared/devspace-mac.token"
chmod 600 "$HOME/.config/cloudflared/devspace-mac.token"
```

Open the token file in a local editor, paste the token as its only line, save
it, and then start the connector without placing the token in a process
argument:

```bash
cloudflared tunnel --no-autoupdate run \
  --token-file "$HOME/.config/cloudflared/devspace-mac.token"
```

Do not paste the generated `--token ...` command into issue reports, chat
messages, shell scripts, Git-tracked files, or service definitions. Rotate the
tunnel token in Cloudflare if it is exposed.

## 4. Configure DevSpace With The Stable Origin

Persist the public origin without `/mcp`:

```bash
devspace config set publicBaseUrl https://mcp-mac.example.com
```

Then restart DevSpace. The MCP client uses the endpoint with `/mcp`:

```text
https://mcp-mac.example.com/mcp
```

`publicBaseUrl` is also the OAuth issuer and the base for the approval,
registration, token, Workspace App, and short-lived artifact URLs. Changing it
requires a DevSpace restart. Existing MCP clients may also need to reconnect
and complete OAuth again.

## 5. Run `cloudflared` At Login On macOS

A per-user LaunchAgent avoids putting a root-owned daemon in front of a
user-owned DevSpace process. First create a private launcher outside the
repository:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.devspace/logs"
chmod 700 "$HOME/.local/bin"
```

Save the following as `~/.local/bin/start-devspace-cloudflared.sh`, replacing
`/Users/YOUR_USER` and the `cloudflared` path with absolute paths from the
target machine:

```bash
#!/bin/bash
set -euo pipefail

exec /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run \
  --token-file /Users/YOUR_USER/.config/cloudflared/devspace-mac.token
```

On an Intel Mac, Homebrew commonly installs `cloudflared` under
`/usr/local/bin` instead. Verify the actual path with:

```bash
command -v cloudflared
chmod 700 "$HOME/.local/bin/start-devspace-cloudflared.sh"
```

Save this LaunchAgent as
`~/Library/LaunchAgents/com.example.cloudflared-devspace.plist`, again replacing
`YOUR_USER` with the local account name:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.cloudflared-devspace</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USER/.local/bin/start-devspace-cloudflared.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/.devspace/logs/cloudflared.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/.devspace/logs/cloudflared.err.log</string>
</dict>
</plist>
```

Validate and load it:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.example.cloudflared-devspace.plist"
launchctl bootout "gui/$(id -u)/com.example.cloudflared-devspace" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.example.cloudflared-devspace.plist"
launchctl kickstart -k "gui/$(id -u)/com.example.cloudflared-devspace"
launchctl print "gui/$(id -u)/com.example.cloudflared-devspace"
```

Only one service-managed `cloudflared` instance for this tunnel should run on a
host. Stop any manually started duplicate after the LaunchAgent is healthy.

## 6. Run `cloudflared` At Boot On Windows

The Windows machine must have its own tunnel and hostname. For the current
`workspaceport.com` deployment, use:

| Setting       | Windows value                               |
| ------------- | ------------------------------------------- |
| Tunnel name   | `devspace-windows`                          |
| Public origin | `https://mcp-windows.workspaceport.com`     |
| MCP endpoint  | `https://mcp-windows.workspaceport.com/mcp` |
| Local service | `http://127.0.0.1:7676`                     |

Do not add the Windows process as a replica of `devspace-mac`: replicas all
serve the same logical route, while these two machines expose different
DevSpace origins.

### Install The Connector

1. Download the current Windows `cloudflared` executable or MSI from
   Cloudflare's [official downloads](https://developers.cloudflare.com/tunnel/downloads/).
2. Verify it from a new Command Prompt:

```bat
cloudflared.exe --version
```

3. In **Networking > Tunnels**, create `devspace-windows`.
4. Add the published route:

```text
mcp-windows.workspaceport.com -> http://127.0.0.1:7676
```

5. Select Windows in the tunnel's connector instructions.
6. Open **Command Prompt as Administrator** and run the service-install command
   generated by Cloudflare:

```bat
cloudflared.exe service install <TUNNEL_TOKEN>
```

Enter the real command only in the local Administrator terminal. Do not paste
it into an LLM chat, Git-tracked file, issue, or screenshot. Close the Command
Prompt after installation so the token is not retained in a long-lived
terminal session.

Cloudflare's official remote-tunnel service installer uses the tunnel token in
the Windows service configuration. Local administrators can therefore recover
it. Restrict administrator access and rotate the token immediately if it is
exposed. `cloudflared` 2025.4.0 and later also supports `--token-file` for
operators who maintain a hardened custom service definition; see Cloudflare's
[run-parameter reference](https://developers.cloudflare.com/tunnel/advanced/run-parameters/).

### Check And Restart The Service

From an Administrator Command Prompt:

```bat
sc.exe query cloudflared
sc.exe stop cloudflared
sc.exe start cloudflared
```

Only one `cloudflared` service may be installed on a Windows host. If another
Cloudflare Tunnel service already exists, do not uninstall or overwrite it
without first identifying its routes and owner.

The connector should become **Healthy** in the Cloudflare dashboard. A healthy
tunnel does not prove DevSpace is running, so continue with the local and
full-loop checks below.

### Configure And Start DevSpace

From the DevSpace checkout in PowerShell:

```powershell
node dist/cli.js config set publicBaseUrl https://mcp-windows.workspaceport.com
node dist/cli.js serve
```

Use a second PowerShell window for validation. The ChatGPT custom Connector
uses:

```text
https://mcp-windows.workspaceport.com/mcp
```

Give it a machine-specific name such as `DevSpaceWindows Cloudflare`. Complete
OAuth with that Windows DevSpace instance's Owner password; do not reuse or
copy the Mac's `~/.devspace/auth.json`.

### Update On Windows

Windows `cloudflared` installations do not automatically update. Stop the
service, upgrade or replace the executable using the original installation
method, and then start it again:

```bat
sc.exe stop cloudflared
sc.exe start cloudflared
cloudflared.exe --version
```

After updating DevSpace or `cloudflared`, rerun the full-loop public doctor.
Cloudflare maintains the current platform-specific update instructions in its
[update guide](https://developers.cloudflare.com/tunnel/downloads/update-cloudflared/).

## 7. Verify The Public OAuth And MCP Chain

First verify the local service:

```bash
devspace doctor --live
```

Then verify the public health endpoint and complete OAuth/MCP path:

```bash
curl -fsS https://mcp-mac.example.com/healthz
devspace doctor --public
devspace doctor --public --full-loop
```

The full-loop check is the important acceptance gate. It verifies dynamic OAuth
registration, Owner password approval, token exchange, MCP initialization,
`tools/list`, Workspace App resources and assets, and a real workspace call
through the public hostname.

For the safe Git integration release, `devspace_info` must report schema
`devspacemac-m4-safe-git-integration.2026-07-27`, a new Boot ID, the
non-sensitive Git policy summary, and 44 tools. The authenticated public
`tools/list` response must contain `git_fetch`, `git_merge`, and `git_push`.
Source code or a local build alone is not deployment evidence.

After a restart, also confirm recovery rather than checking only steady-state
health:

```bash
launchctl kickstart -k "gui/$(id -u)/com.example.cloudflared-devspace"
until curl -fsS https://mcp-mac.example.com/healthz >/dev/null; do
  sleep 1
done
devspace doctor --public --full-loop
```

On Windows PowerShell, use the Windows hostname and the checkout CLI:

```powershell
curl.exe -fsS https://mcp-windows.workspaceport.com/healthz
node dist/cli.js doctor --live
node dist/cli.js doctor --public
node dist/cli.js doctor --public --full-loop
```

Do not use `curl -k` or disable certificate verification. A TLS verification
failure is a real configuration or network problem that must be fixed.

## Updating Another Machine

Pull the current DevSpace code and documentation first:

```bash
git pull --ff-only origin main
npm install --include=dev
npm run build
```

Then upgrade the connector with the machine's package manager. On macOS:

```bash
brew upgrade cloudflared
launchctl kickstart -k "gui/$(id -u)/com.example.cloudflared-devspace"
```

On Windows, pull and rebuild from PowerShell, then verify the service:

```powershell
git pull --ff-only origin main
npm install --include=dev
npm run build
sc.exe query cloudflared
node dist/cli.js doctor --public --full-loop
```

Each machine must retain its own:

- narrow DevSpace `allowedRoots`
- DevSpace Owner password and OAuth state
- tunnel and tunnel token
- public hostname and `publicBaseUrl`
- service definition and log files

Do not copy `~/.devspace/auth.json` or a tunnel token between machines. Repeat
the full-loop public doctor after every hostname, token, connector, proxy, or
DevSpace version change.

## Migrating From Another Tunnel

Keep the old tunnel available until the new route passes its checks:

1. Start the Named Tunnel while the old tunnel still runs.
2. Verify `https://NEW_HOST/healthz`.
3. Set DevSpace `publicBaseUrl` to the new origin and restart DevSpace.
4. Run `devspace doctor --public --full-loop`.
5. Update the MCP client to `https://NEW_HOST/mcp` and reconnect OAuth.
6. Stop the old tunnel only after the new client connection succeeds.

Once `publicBaseUrl` changes, the old hostname is no longer a complete OAuth
rollback path. To roll back, restore the old public origin, restart DevSpace,
and reconnect the MCP client.

## Troubleshooting

### The Connector Is Degraded Or Reconnects

By default, current `cloudflared` versions test and automatically choose between
QUIC over UDP `7844` and HTTP/2 over TCP `7844`. Permit both protocols for the
best fallback behavior. Cloudflare documents the current endpoints in its
[firewall guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
and explains startup diagnostics in
[connectivity pre-checks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/).

If UDP is blocked but TCP `7844` works, let automatic fallback select HTTP/2 or
test it explicitly:

```bash
cloudflared tunnel --protocol http2 --no-autoupdate run \
  --token-file "$HOME/.config/cloudflared/devspace-mac.token"
```

Do not force HTTP/2 if the precheck says TCP `7844` is blocked. Fix the network
path or allow the protocol that succeeds.

### Cloudflare Returns `502`

Confirm DevSpace is healthy locally and the published route uses the IPv4
loopback address:

```bash
curl -fsS http://127.0.0.1:7676/healthz
```

The dashboard service URL must be:

```text
http://127.0.0.1:7676
```

### DevSpace Returns `Invalid Host`

The active public hostname and DevSpace `publicBaseUrl` do not match. Update the
configuration, restart DevSpace, and rerun the public doctor.

### ChatGPT Shows Old Tools Or An Old Workspace App

Reconnect the MCP connector after the service and public doctor are healthy.
Some clients retain a tool or app-resource snapshot for an existing chat. A new
chat can confirm whether the problem is client-side caching, but it is not a
substitute for the full-loop public doctor.

### Logs

For the macOS LaunchAgent above:

```bash
tail -n 200 "$HOME/.devspace/logs/cloudflared.err.log"
launchctl print "gui/$(id -u)/com.example.cloudflared-devspace"
```

Cloudflare normally maintains multiple outbound connections and reconnects
individual ones when necessary. Judge availability with repeated public probes
and the full-loop doctor, not a single connector log line.

For the production service, set `DEVSPACE_WIDGETS=review_only`. This preserves
rich diff, artifact, media, model, and capture review while avoiding Workspace
App metadata on ordinary tools. The tunnel hostname, route, OAuth settings, and
Cloudflare token do not need to change when switching this mode.
