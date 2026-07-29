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
12. all 60 registered Workspace App tools, each with its own iframe handshake
    and non-empty card render;
13. 1, 4, 8, or 16 concurrent sandbox cards;
14. browser console, page-error, failed-request, and asset HTTP status gates;
15. local-only route enforcement.

The fault-injection scenario intentionally requests a CSP-forbidden
`example.invalid` script. The scenario passes only when the host observes that
failure while the real Workspace App bundle still initializes and renders.

The tool matrix uses synthetic local results. It exercises the real card
dispatcher and rendering bundle without performing production writes, deletes,
Git pushes, game input, or external application launches.

## Functional coverage contract

`src/tool-test-coverage.ts` maps every registered tool to its functional test
files and one of four safety modes:

- `isolated_read`: read-only checks that need no mutable fixture;
- `temp_workspace`: changes are restricted to a disposable temporary root;
- `local_bare_remote`: fetch, merge, and push use a local disposable Git remote;
- `mock_runtime`: external applications, capture jobs, games, and file-provider
  behavior use controlled test doubles.

`src/tool-test-coverage.test.ts` fails when a tool is added without an explicit
strategy, when a referenced functional test disappears, or when a dangerous
operation is mislabeled as read-only. `src/pi-tools.test.ts` adds direct
temporary-workspace coverage for the Pi-backed read, write, edit, grep, find,
list, and shell primitives.

## Test layers

Use the layers together; one passing layer does not prove the others.

| Layer               | Command                                        | Proves                                                                                               |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Source/unit         | `npm run test:unit`                            | URI resolver, result normalization, telemetry, server policies, 60-tool functional coverage contract |
| Local browser host  | `npm run test:webgpt-local`                    | sandbox lifecycle, AppBridge, 60-tool rendering, CSP/network/console, concurrency                    |
| Local service/OAuth | `node dist/cli.js doctor --live`               | local HTTP, OAuth metadata and MCP transport                                                         |
| Public full loop    | `node dist/cli.js doctor --public --full-loop` | Cloudflare, OAuth, tools/resources, public template/assets                                           |
| Real Web GPT smoke  | one fresh tool call in ChatGPT                 | ChatGPT's private host, connector cache, conversation UI                                             |

## Honest boundary

The local host follows the public MCP Apps protocol and uses the official host
bridge, but it is not ChatGPT's private frontend. It cannot reproduce private
connector caching, rollout flags, account state, or a ChatGPT-only rendering
bug. A real Web GPT smoke test therefore remains the final acceptance gate,
but it should be short: reconnect/reload if required, call one card-producing
tool, and confirm the card is visible without `Failed to fetch template`.

The 60-tool matrix proves local protocol and visual compatibility. It does not
claim that all destructive operations were replayed against a real project or
remote service; those operations are deliberately tested only in disposable or
mock environments.

## Browser selection

The automated gate uses an installed Chrome, Edge, or Chromium via
`playwright-core`. Override detection when needed:

```bash
DEVSPACE_TEST_BROWSER="/path/to/chromium" npm run test:webgpt-local
```
