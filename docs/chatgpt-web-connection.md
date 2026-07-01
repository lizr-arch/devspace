# ChatGPT Web Connection Path

This is the real DevSpace path for using ChatGPT web as a local coding partner.

## Supported End-To-End Flow

DevSpace is built around this network path:

1. Run DevSpace on your machine.
2. Put a public HTTPS URL in front of that local server.
3. In ChatGPT web, enable developer mode and create a custom connector.
4. Point the connector at your public DevSpace `/mcp` URL.
5. Let ChatGPT start the OAuth flow and approve it with the DevSpace Owner
   password page.
6. Ask ChatGPT to call `open_workspace` inside one of your allowed local roots.

In practice the chain looks like this:

```text
ChatGPT web
  -> public https://your-host.example.com/mcp
  -> DevSpace on localhost
  -> OAuth approval page on the same public base URL
  -> approved access token
  -> open_workspace / read / edit / bash
```

The important detail is that DevSpace uses the same public origin for both the
MCP endpoint and the built-in OAuth approval flow.

## What DevSpace Controls

DevSpace is responsible for:

- the approved local roots ChatGPT may open
- the MCP tools ChatGPT can call
- the OAuth protected resource metadata
- the OAuth authorization metadata
- the Owner password approval page
- access-token verification on later MCP calls

After approval, DevSpace becomes the policy boundary around your local machine.

## What ChatGPT Controls

ChatGPT controls:

- which model is used in the conversation
- which reasoning level is selected
- when to call a tool
- when to ask for extra confirmation based on connector permissions

DevSpace cannot force ChatGPT web to use a specific model or the highest
reasoning tier. If you want the strongest available reasoning, choose it in
ChatGPT before starting the session.

As of June 30, 2026, OpenAI's current help docs describe the model picker in
terms such as `Instant`, `Thinking`, and `Pro`, with configurable thinking
effort depending on plan. Use the highest reasoning option available on your
plan inside ChatGPT itself.

## Current OpenAI Plan And Mode Limits

OpenAI's current docs also matter for whether this workflow is even allowed, but
those rules are product-controlled and can change separately from DevSpace.

The practical rule is:

- verify your current ChatGPT plan and workspace entitlements in ChatGPT
- verify developer mode is available on the account you will actually use
- verify the connected app has the tool permissions you expect
- do not assume a DevSpace misconfiguration until `doctor --live` and
  `doctor --public` are clean

If you want ChatGPT web to read, edit, and run code through DevSpace, the key
external prerequisite is not just the tunnel and OAuth flow. It is also the
current ChatGPT account, mode, and connector policy.

## Public HTTPS Tunnel Vs Secure MCP Tunnel

For DevSpace as implemented today, the supported ChatGPT web path is a normal
public HTTPS URL in front of DevSpace.

That is why setup asks for `DEVSPACE_PUBLIC_BASE_URL` and why the value must be
the public origin without `/mcp`.

## Why Secure MCP Tunnel Is Different

OpenAI Secure MCP Tunnel is useful when you want OpenAI products to reach a
private MCP server without exposing the MCP listener itself to the public
internet.

OpenAI's current Secure MCP Tunnel docs say the tunnel can preserve upstream
OAuth metadata, but the auth server itself is not automatically tunneled.
DevSpace currently uses its own built-in OAuth approval pages at the same
`DEVSPACE_PUBLIC_BASE_URL`. If you hide DevSpace completely behind Secure MCP
Tunnel and do not also make those browser-facing OAuth endpoints reachable,
connector discovery may work while the OAuth approval step still fails.

So the safe rule is:

- Use a public HTTPS tunnel or reverse proxy for DevSpace when connecting from
  ChatGPT web today.
- Treat Secure MCP Tunnel as an advanced path that still needs a reachable OAuth
  authorization server consistent with `DEVSPACE_PUBLIC_BASE_URL`.

## Minimal ChatGPT Web Checklist

1. Start DevSpace with a public base URL.
2. Confirm `https://your-host.example.com/mcp` is reachable.
3. Confirm the same public origin can serve the OAuth well-known endpoints.
4. Confirm your ChatGPT plan and mode support the full MCP workflow you want.
5. In ChatGPT web, enable developer mode.
6. Create a connector pointing to the public `/mcp` URL.
7. Approve the Owner password page.
8. Choose ChatGPT's highest reasoning option available on your plan.
9. Start a new chat, attach the connector, and ask ChatGPT to open a project.

## Verified Quick Tunnel Path

One validated public HTTPS path is:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
DEVSPACE_PUBLIC_BASE_URL="https://your-assigned.trycloudflare.com" npx @waishnav/devspace serve
npx @waishnav/devspace doctor --public
```

The important detail is that DevSpace must be restarted with the exact assigned
public hostname. If the hostname changes but DevSpace still uses the old value,
the server may reject public requests with `Invalid Host`.

## Local Verification

Run:

```bash
npx @waishnav/devspace doctor --live
npx @waishnav/devspace doctor --public
npx @waishnav/devspace doctor --public --full-loop
```

This probes the local DevSpace server for:

- `/healthz`
- OAuth protected-resource metadata
- OAuth authorization-server metadata
- dynamic client registration
- the rendered Owner password page

It does not prove that your public tunnel or ChatGPT account plan is correct,
but it does prove that the local DevSpace HTTP and OAuth chain is internally
wired the way ChatGPT expects.

`doctor --public` goes one step further and probes the configured public URL
through your live tunnel or reverse proxy.

`doctor --public --full-loop` goes further again: it behaves like a real
external MCP client by registering an OAuth client, completing the Owner
password approval, exchanging a token, initializing MCP, listing tools, and
calling `open_workspace` through the public tunnel.

## Pinggy Note

If you use a free Pinggy tunnel, you may see a browser caution page before the
proxied site. DevSpace's public doctor probe automatically sends
`X-Pinggy-No-Screen: true` for Pinggy URLs so non-browser checks reach DevSpace
directly.

On Windows, prefer:

```bash
ssh -T -p 443 -R0:127.0.0.1:7676 qr@a.pinggy.io
```

Using `localhost:7676` can produce tunnel-side `502` responses if the local
DevSpace server is bound only on IPv4.
