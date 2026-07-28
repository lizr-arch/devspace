# Web GPT Local Compatibility Testing

DevSpace includes a local-only MCP Apps host simulator for catching Workspace App
failures before a real ChatGPT/Web GPT smoke test.

## Fast paths

Run the automated browser gate:

```bash
npm run test:webgpt-local
```

Open the visual laboratory and keep it running:

```bash
npm run test:webgpt-local:ui
```

The second command builds the current source, starts an isolated DevSpace
instance on a random loopback port, opens `/app-test`, and keeps the instance
alive until `Ctrl+C`. It does not reuse or modify the production DevSpace
process, OAuth store, monitor history, workspaces, or MCP sessions.

The normal deployed service also serves `/app-test` on loopback after it has
been built and restarted. The route deliberately returns a non-success response
when the Host header is non-local or when Cloudflare/forwarding headers are
present.

## What the gate covers

The test host uses the official `@modelcontextprotocol/ext-apps/app-bridge`
implementation and a sandboxed iframe for each View. The automated suite checks:

1. current versioned Workspace App URI;
2. legacy fixed URI;
3. a previous-build fingerprint URI;
4. `ui/initialize` and `ui/notifications/initialized`;
5. complete tool input and tool result delivery;
6. repeated tool results in the same iframe;
7. generic fallback for a future/unknown tool;
8. error-result rendering;
9. host-context updates;
10. declarative CSP/resource-failure detection;
11. rejection of malformed template URIs;
12. 1, 4, 8, or 16 concurrent sandbox cards;
13. browser console, page-error, failed-request, and asset HTTP status gates;
14. local-only route enforcement.

The fault-injection scenario intentionally requests a CSP-forbidden
`example.invalid` script. The scenario passes only when the host observes that
failure while the real Workspace App bundle still initializes and renders.

## Test layers

Use the layers together; one passing layer does not prove the others.

| Layer | Command | Proves |
| --- | --- | --- |
| Source/unit | `npm run test:unit` | URI resolver, result normalization, telemetry, server policies |
| Local browser host | `npm run test:webgpt-local` | sandbox lifecycle, AppBridge, rendering, CSP/network/console, concurrency |
| Local service/OAuth | `node dist/cli.js doctor --live` | local HTTP, OAuth metadata and MCP transport |
| Public full loop | `node dist/cli.js doctor --public --full-loop` | Cloudflare, OAuth, tools/resources, public template/assets |
| Real Web GPT smoke | one fresh tool call in ChatGPT | ChatGPT's private host, connector cache, conversation UI |

## Honest boundary

The local host follows the public MCP Apps protocol and uses the official host
bridge, but it is not ChatGPT's private frontend. It cannot reproduce private
connector caching, rollout flags, account state, or a ChatGPT-only rendering
bug. A real Web GPT smoke test therefore remains the final acceptance gate,
but it should be short: reconnect/reload if required, call one card-producing
tool, and confirm the card is visible without `Failed to fetch template`.

## Browser selection

The automated gate uses an installed Chrome, Edge, or Chromium via
`playwright-core`. Override detection when needed:

```bash
DEVSPACE_TEST_BROWSER="/path/to/chromium" npm run test:webgpt-local
```
