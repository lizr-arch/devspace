<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

## Sponsors and Special Thanks

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>

<p>
  DevSpace is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

DevSpace requires Node `>=20.12 <27`. Node 22 LTS is recommended.

Install the DevSpace CLI:

```bash
npm install -g @waishnav/devspace
```

Then initialize and start the server:

```bash
devspace init
devspace serve
```

Or run it without a global install:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

During setup, DevSpace asks for:

- the local project folders ChatGPT is allowed to open through DevSpace
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or
  another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

For ChatGPT web, enable developer mode, create a custom connector, and point it
at that public `/mcp` URL. DevSpace then handles OAuth approval with the Owner
password page it serves from the same public base URL.

DevSpace does not choose the ChatGPT model or reasoning level for you. Pick the
strongest model and highest reasoning level available in ChatGPT before starting
the coding session.

OpenAI controls developer mode eligibility, MCP write permissions, and the
model picker on the ChatGPT side. Verify your current plan's developer mode and
connector tool permissions in ChatGPT before assuming the blocker is in
DevSpace.

If your MCP host can connect but should only inspect code, start DevSpace in
read-only mode:

```bash
DEVSPACE_READ_ONLY=1 devspace serve
```

This exposes `open_workspace`, `read`, `grep`, `glob`, and `ls`, while hiding
`write`, `edit`, and `bash`.

## Local Coach Bridge

DevSpace also supports a second path for code inspection when direct MCP access
is unavailable or inconvenient:

```bash
devspace coach-pack --path D:\Code\git\devspace --task "Explain delegate flow" --budget 4000 --out coach_pack.md
devspace coach-ingest coach_reply.md
```

This `Local Coach Bridge` flow is for non-Pro or non-MCP situations where you
still want an external coach to inspect a bounded slice of local code.

It does **not** require:

- ChatGPT Pro
- MCP access
- developer mode
- public tunnel
- OAuth

It does:

- keep extraction local
- build a bounded read-only markdown pack
- omit sensitive paths by default
- return a metadata-only manifest beside the pack
- parse a coach reply back into structured next steps

It does **not** give ChatGPT direct repo access, and it does not auto-apply
changes.

See [Local Coach Bridge](https://github.com/Waishnav/devspace/blob/main/docs/local-coach-bridge.md)
for the safety model, quickstart, and FAQ.

Run `devspace doctor --live` to verify the local HTTP and OAuth chain, then run
`devspace doctor --public` while your tunnel is active to verify the real public
URL ChatGPT will use.

Run `devspace doctor --public --full-loop` to go one step further: it performs
dynamic client registration, completes the Owner password OAuth flow, exchanges
an access token, initializes MCP over the public tunnel, lists tools, and calls
`open_workspace` as a real external client.

A verified quick path is Cloudflare Quick Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
DEVSPACE_PUBLIC_BASE_URL="https://your-assigned.trycloudflare.com" devspace serve
devspace doctor --public
```

If the tunnel hostname changes, restart DevSpace with the exact new public base
URL. Otherwise DevSpace may reject requests with `Invalid Host`.

If you use Pinggy over SSH on Windows, prefer:

```bash
ssh -T -p 443 -R0:127.0.0.1:7676 qr@a.pinggy.io
```

Using `localhost:7676` can lead to tunnel-side `502` responses when the local
service is bound only on IPv4.

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

In read-only mode, it can still open workspaces, read files, search code, and
inspect directories, but it cannot modify files or execute shell commands.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Documentation

- [Setup Guide](https://github.com/Waishnav/devspace/blob/main/docs/setup.md)
- [ChatGPT Web Connection Path](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-web-connection.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-coding-workflow.md)
- [Local Coach Bridge](https://github.com/Waishnav/devspace/blob/main/docs/local-coach-bridge.md)
- [Configuration Reference](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [Security Model](https://github.com/Waishnav/devspace/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/devspace/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav, the creator of [GitCMS](https://gitcms.dev/), a Git-backed CMS
for markdown sites.

I like building opinionated products, and DevSpace is another example of that.
I'm on a journey to build a single-person company doing multiple millions in
revenue. If you want to watch the failures, wins, lessons, and everything in
between, come hang out with me on [X](https://x.com/wshxnv).

## Local Development

For working on DevSpace itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
