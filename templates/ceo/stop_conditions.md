# Stop Conditions

## DONE Conditions
The system stops with DONE status when:
- All acceptance criteria are met
- All tests pass
- No blocking issues remain
- Coach GPT confirms completion

## BLOCKED Conditions
The system stops with BLOCKED status when:
- External resources are missing
- Required tools are unavailable
- Environment cannot support the task
- Dependencies cannot be resolved

## NEED_USER Conditions
The system stops with NEED_USER status when:
- Architecture change is required
- Scope expansion is needed
- New dependencies must be introduced
- Real API keys or accounts are needed
- Large code deletion is proposed
- Frozen contract needs modification
- Two consecutive failures occur
- Coach proposes multiple long-term directions
- Critical local resources are missing
- Tests cannot run for unknown reasons

## SAFETY_STOP Conditions
The system stops with SAFETY_STOP status when:
- About to delete large number of files
- About to modify forbidden scope
- About to execute dangerous commands
- About to bypass tests or acceptance criteria
- About to commit or publish externally
- Security conflict detected

## BUDGET_STOP Conditions
The system stops with BUDGET_STOP status when:

| Budget Type | Limit |
|-------------|-------|
| Max Rounds | 10 |
| Max Consecutive Failures | 3 |
| Max Runtime | 3600 seconds |
| Max File Changes | 50 |
| Max Test Retries | 5 |
