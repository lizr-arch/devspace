# Local Coach Bridge

`Local Coach Bridge` is DevSpace's Phase 1 path for users who want help from
ChatGPT web or another external coach without depending on MCP access,
developer mode, public tunnels, or OAuth.

The goal is simple:

- keep code access local
- extract only the minimum task-scoped context
- let the user decide what leaves the machine
- keep the bridge read-only

This is `Option A` from the non-Pro scheme: manual context-pack bridging.

## What It Does

`devspace coach-pack` builds a bounded markdown pack from one approved local
repo. The pack contains selected file excerpts with:

- repo-relative paths
- line ranges
- selection reasons

`devspace coach-ingest` parses a coach reply back into structured local next
steps such as:

- diagnosis
- referenced files
- suggested next reads
- patch plan
- verification commands

## What It Does Not Do

This feature does **not** mean:

- ChatGPT can directly access your local repo
- non-Pro users now have MCP through DevSpace
- DevSpace auto-applies coach advice
- DevSpace uploads the full repository
- DevSpace runs shell commands through the external coach

The correct promise is narrower:

> Non-Pro users can manually provide a task-scoped, bounded, read-only code
> context pack to an external coach.

## Quickstart

Generate a pack:

```bash
devspace coach-pack ^
  --path D:\Code\git\devspace ^
  --task "Explain delegate / user_proxy / orchestrator_v2 request flow" ^
  --budget 4000 ^
  --out coach_pack.md
```

This writes:

- `coach_pack.md`
- `coach_pack.manifest.json`

Then:

1. Paste `coach_pack.md` into ChatGPT or another coach.
2. Save the coach reply to a markdown file such as `coach_reply.md`.
3. Parse the reply locally:

```bash
devspace coach-ingest coach_reply.md
```

Or write the structured summary to JSON:

```bash
devspace coach-ingest coach_reply.md --out coach_summary.json
```

## Safety Defaults

Phase 1 is intentionally strict.

- Reads are limited to approved roots.
- The pack builder uses hard ceilings for files, lines, and total characters.
- Sensitive paths are omitted instead of included with partial secret masking.
- Pack summaries redact sensitive path details instead of exposing exact secret
  file locations.
- Common irrelevant directories such as `.git`, `node_modules`, `dist`,
  `build`, `target`, and `vendor` are skipped.
- Repo-local `.devspaceignore` exclusions are respected.
- `AGENTS.md` and normal repo docs may be included when relevant, but repo-
  external skills are not packaged by default.
- The manifest stores metadata only. It does not store code bodies.
- `coach-ingest` parses text only. It does not write the workspace.

The output pack itself is only persisted when you explicitly choose an `--out`
path.

## Failure Behavior

Expected failure behavior in Phase 1:

- Outside approved roots: fail closed.
- Sensitive file match: omit from the pack and record a redacted omission.
- Hard budget reached: keep the output bounded and mark that expansion approval
  is required.
- Weak result set: emit a small pack and narrow the next task instead of
  silently expanding scope.

## Example Workflow

1. Run `devspace coach-pack` with one concrete question.
2. Review the generated pack locally before sharing it.
3. Paste the pack into ChatGPT web.
4. Ask the coach for diagnosis, patch plan, risks, and verification steps.
5. Save the reply.
6. Run `devspace coach-ingest`.
7. Review the structured output and perform local implementation manually.

## FAQ

### Do I need ChatGPT Pro?

No. This bridge exists for cases where direct MCP access is unavailable or
uncertain.

### Do I need MCP access?

No. The bridge is a local CLI flow, not a connector flow.

### Do I need a public tunnel or OAuth?

No. Those are required for the normal MCP connector path, not for this manual
bridge path.

### Does DevSpace upload my whole repo?

No. Only the generated pack is shared, and the user chooses whether to share
it.

### Can the coach modify local files through this bridge?

No. Phase 1 is read-only. The coach can suggest actions; DevSpace does not
apply them automatically.
