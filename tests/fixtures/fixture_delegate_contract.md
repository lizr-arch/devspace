# Delegate Contract

## Authorization Date
2024-01-15

## Authorized Mode
delegate

## What User Proxy CAN Do
- Modify src/ directory
- Add new React components
- Run tests
- Install npm packages (except major version changes)

## What User Proxy CANNOT Do
- Modify package.json dependencies (major versions)
- Delete existing components
- Change project structure
- Use real API keys

## MUST Trigger NEED_USER When
- Need to change architecture
- Need to add new major dependency
- Need to delete multiple files
- Two consecutive failures
- Tests cannot run

## Acceptable Risk Level
medium

## Maximum Auto Scope
Single component modifications and tests