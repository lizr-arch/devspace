# Coach Packets

## Contents

- kickoff packet
- follow-up packet
- local execution brief
- suggested read-only MCP surface

## Kickoff Packet

```markdown
Goal:

Repo/worktree or system scope:

Constraints:

Current state:
- ...

Key files:
- path:line - why it matters

Observed failures or unknowns:
- ...

Specific asks:
- Frame the problem.
- What are the highest-risk failure modes?
- Which design option is best and why?
- What must be true at done?
- What tests or checks are mandatory?
```

## Follow-Up Packet

```markdown
Goal recap:

Changes made:
- path:line - summary

Validation:
- command or check -> pass/fail

Open items or tradeoffs:
- ...

Specific asks:
- Is this enough to ship?
- What is still risky?
- What should change before the next round?
```

## Local Execution Brief

```markdown
Goal:

Accepted coach guidance:
- ...

Definition of done:
- ...

Out of scope:
- ...

Validation expectations:
- ...
```

## Suggested Read-Only MCP Surface

Use stable, small, read-only tools. Good defaults are:

- `read_repo_summary`
- `read_current_diff`
- `read_logs`
- `read_design_notes`
- `search_code`

Do not expose:

- shell execution
- write or edit tools
- destructive operations
- secret stores
- commit or push actions
