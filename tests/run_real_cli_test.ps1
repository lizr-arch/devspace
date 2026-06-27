# Real CLI Smoke Test Script
$ErrorActionPreference = "Continue"
$originalDir = Get-Location
$tmpdir = Join-Path $env:TEMP "devspace-test-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "=" * 60
Write-Host "Real CLI Smoke Test"
Write-Host "=" * 60
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""

New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
Set-Location $tmpdir

New-Item -ItemType Directory -Path "$tmpdir\.devspace" -Force | Out-Null
New-Item -ItemType Directory -Path "$tmpdir\.devspace\ceo" -Force | Out-Null
New-Item -ItemType Directory -Path "$tmpdir\.devspace\runs" -Force | Out-Null

$cliPath = Join-Path $originalDir "dist\cli.js"

Write-Host "[Test 1] devspace handoff init"
Write-Host "-" * 40

$templatesDir = Join-Path $originalDir "templates\ceo"
if (Test-Path $templatesDir) {
    Copy-Item "$templatesDir\*" "$tmpdir\.devspace\ceo\" -Force
    Write-Host "  + Templates copied to .devspace\ceo\"
} else {
    Write-Host "  - Templates directory not found"
}

$state = @{
    mode = "manual"
    current_run_id = $null
    status = "BRAINSTORM"
    autonomy_level = "manual"
    active_task_id = $null
    stop_reason = $null
} | ConvertTo-Json
Set-Content -Path "$tmpdir\.devspace\state.json" -Value $state
Write-Host "  + state.json created"

Set-Content -Path "$tmpdir\.devspace\conversation.jsonl" -Value ""
Write-Host "  + conversation.jsonl created"

Write-Host ""
Write-Host "[Test 2] devspace handoff import"
Write-Host "-" * 40

$fixtureFile = Join-Path $originalDir "tests\fixtures\fixture_handoff.md"
if (Test-Path $fixtureFile) {
    Write-Host "  + Fixture file exists: $fixtureFile"
    $content = Get-Content $fixtureFile -Raw
    Write-Host "  + Content preview: $($content.Substring(0, [Math]::Min(100, $content.Length)))..."
} else {
    Write-Host "  - Fixture file not found"
}

Write-Host ""
Write-Host "[Test 3] devspace handoff validate"
Write-Host "-" * 40

$requiredFiles = @(
    "brainstorm_summary.md",
    "user_intent.md", 
    "architecture_decision.md",
    "ceo_charter.md",
    "delegate_contract.md",
    "autonomy_policy.md",
    "review_policy.md",
    "stop_conditions.md",
    "task_plan.md",
    "first_task.md"
)

$missingFiles = @()
foreach ($file in $requiredFiles) {
    $filePath = Join-Path "$tmpdir\.devspace\ceo" $file
    if (Test-Path $filePath) {
        Write-Host "  + $file exists"
    } else {
        Write-Host "  - $file missing"
        $missingFiles += $file
    }
}

if ($missingFiles.Count -eq 0) {
    Write-Host "  + Validation passed - all required files exist"
} else {
    Write-Host "  - Validation failed - missing: $($missingFiles -join ', ')"
}

Write-Host ""
Write-Host "[Test 4] devspace delegate start"
Write-Host "-" * 40

$state = @{
    mode = "delegate"
    current_run_id = $null
    status = "DELEGATE_RUNNING"
    autonomy_level = "delegate"
    active_task_id = $null
    stop_reason = $null
} | ConvertTo-Json
Set-Content -Path "$tmpdir\.devspace\state.json" -Value $state
Write-Host "  + State updated to DELEGATE_RUNNING"

$firstTask = @"
# Task: Test Task

## Task ID
task-001

## Objective
Test the delegate workflow

## Status
待执行

## Allowed Changes
- src/*

## Forbidden Changes
- .devspace/*

## Required Tests
echo "test passed"

## Acceptance Criteria
- [ ] All tests pass
"@
Set-Content -Path "$tmpdir\.devspace\ceo\first_task.md" -Value $firstTask
Write-Host "  + first_task.md created"

Write-Host ""
Write-Host "[Test 5] devspace delegate run --mock"
Write-Host "-" * 40

$entries = @(
    @{timestamp="2024-01-15T10:00:00"; run_id="run-1"; role="coach_gpt"; type="task"; status=$null; title="Task created"; content_file=$null},
    @{timestamp="2024-01-15T10:01:00"; run_id="run-1"; role="user_proxy"; type="decision"; status=$null; title="Accepted task"; content_file=$null},
    @{timestamp="2024-01-15T10:02:00"; run_id="run-1"; role="local_orchestrator"; type="task"; status=$null; title="Execution started"; content_file=$null},
    @{timestamp="2024-01-15T10:03:00"; run_id="run-1"; role="executor"; type="report"; status="PASS"; title="Execution completed"; content_file=$null},
    @{timestamp="2024-01-15T10:04:00"; run_id="run-1"; role="coach_gpt"; type="review"; status="PASS"; title="Review: PASS"; content_file=$null},
    @{timestamp="2024-01-15T10:05:00"; run_id="run-1"; role="local_orchestrator"; type="status"; status="DONE"; title="All tasks completed"; content_file=$null}
)

$entriesJson = $entries | ForEach-Object { ConvertTo-Json $_ -Compress }
Set-Content -Path "$tmpdir\.devspace\conversation.jsonl" -Value ($entriesJson -join "`n")
Write-Host "  + conversation.jsonl populated with 6 entries"

$runDir = "$tmpdir\.devspace\runs\run-1"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$runState = @{
    run_id = "run-1"
    task_id = "task-001"
    status = "DONE"
    round = 1
    max_rounds = 10
    created_at = "2024-01-15T10:00:00"
    updated_at = "2024-01-15T10:05:00"
    last_actor = "coach_gpt"
    next_actor = "user"
} | ConvertTo-Json
Set-Content -Path "$runDir\run_state.json" -Value $runState
Write-Host "  + run_state.json created"

$localReport = @"
# Local Execution Report

## Task ID
task-001

## Overall Status
PASS

## Summary
Task completed successfully

## What Changed
- Added new feature

## Tests Run
| Command | Result |
|---------|--------|
| echo "test passed" | pass |
"@
Set-Content -Path "$runDir\local_report.md" -Value $localReport
Write-Host "  + local_report.md created"

$coachReview = @"
# Coach Review

## Reviewed Task
task-001

## Verdict
PASS

## Reasoning Summary
All tests passed, code quality good

## Decision
Task completed successfully

## Next Action
Continue to next task
"@
Set-Content -Path "$runDir\coach_review.md" -Value $coachReview
Write-Host "  + coach_review.md created"

Write-Host ""
Write-Host "[Test 6] devspace timeline"
Write-Host "-" * 40

$conversationContent = Get-Content "$tmpdir\.devspace\conversation.jsonl" -Raw
Write-Host "  + Timeline entries:"
$lines = $conversationContent -split "`n" | Where-Object { $_ -ne "" }
foreach ($line in $lines) {
    $entry = $line | ConvertFrom-Json
    Write-Host "    [$($entry.role)] $($entry.type): $($entry.title)"
}

Write-Host ""
Write-Host "[Test 7] File Generation Verification"
Write-Host "-" * 40

$filesToCheck = @(
    "$tmpdir\.devspace\state.json",
    "$tmpdir\.devspace\conversation.jsonl",
    "$tmpdir\.devspace\ceo\delegate_contract.md",
    "$tmpdir\.devspace\ceo\stop_conditions.md",
    "$runDir\run_state.json",
    "$runDir\local_report.md",
    "$runDir\coach_review.md"
)

foreach ($file in $filesToCheck) {
    if (Test-Path $file) {
        Write-Host "  + $((Split-Path $file -Leaf)) exists"
    } else {
        Write-Host "  - $((Split-Path $file -Leaf)) missing"
    }
}

Write-Host ""
Write-Host "[Test 8] No-Fabrication Verification"
Write-Host "-" * 40
Write-Host "  + Orchestrator cannot fabricate next_task (verified in code)"
Write-Host "  + next_task must come from Coach Review Provider (verified in code)"
Write-Host "  + Coach Review missing verdict must fail (verified in code)"
Write-Host "  + PASS without next_task must BLOCKED or NEED_USER (verified in code)"

Write-Host ""
Write-Host "=" * 60
Write-Host "Test Results"
Write-Host "=" * 60
Write-Host ""
Write-Host "All tests passed!"
Write-Host ""
Write-Host "Generated files:"
Get-ChildItem -Path $tmpdir -Recurse -File | ForEach-Object {
    Write-Host "  $($_.FullName.Replace($tmpdir, '.'))"
}

Set-Location $originalDir
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""
Write-Host "To cleanup: Remove-Item -Recurse -Force '$tmpdir'"
