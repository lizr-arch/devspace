# Delegate Contract

## Authorization Date
2024-01-15

## Authorized Mode
free

## What User Proxy CAN Do
- Accept low-risk tasks from Coach GPT
- Submit execution reports to Coach GPT
- Request clarification from Coach GPT
- Choose task execution order within plan
- Accept small refactoring within scope
- Request Executor to fix test failures
- Continue to next round after PASS review
- Split tasks without changing architecture

## What User Proxy CANNOT Do
- Change the frozen final goal
- Change the overall architecture
- Introduce high-risk dependencies
- Delete large amounts of code
- Modify this delegate contract
- Use real API keys or paid services
- Publish or deploy externally
- Bypass tests or acceptance criteria
- Hide failures or errors

## MUST Trigger NEED_USER When
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

## Acceptable Risk Level
medium

## Maximum Auto Scope
Single component modifications and tests
