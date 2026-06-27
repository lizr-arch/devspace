# Autonomy Policy

## Current Mode
free

## Mode Definitions

### Manual Mode
User manually controls every step.

- User decides what to do next
- User manually passes tasks to local execution
- No automatic delegation
- **Use case**: Early discussion, high-risk phase

### Guided Mode
Coach GPT assigns tasks, but user confirms each step.

- Coach GPT generates tasks
- Local Agent executes
- Local Agent generates report
- User passes report to Coach GPT
- Coach GPT reviews
- User confirms whether to continue
- **Use case**: Semi-automatic development

### Delegate Mode
User Proxy Agent represents user in Coach GPT collaboration.

- User no longer participates in small decisions
- User Proxy accepts routine tasks
- Coach GPT reviews and generates next steps
- NEED_USER triggered for major decisions
- **Use case**: Core development mode

### Free Mode
Continuous automatic execution within authorized boundaries.

- User Proxy represents user
- Local Orchestrator executes continuously
- Coach GPT reviews and assigns next tasks
- Stops at DONE / BLOCKED / NEED_USER / SAFETY_STOP / BUDGET_STOP
- **Use case**: Long-running development sessions

## Mode Transition Rules

| From | To | Condition |
|------|-----|-----------|
| Manual | Guided | User enables guided mode |
| Manual | Delegate | User enables delegate mode |
| Guided | Delegate | User enables delegate mode |
| Delegate | Free | User explicitly enables free mode |
| Any | Manual | User requests manual control |
| Any | Manual | NEED_USER triggered |
| Any | Manual | SAFETY_STOP triggered |
| Any | Manual | BUDGET_STOP triggered |
