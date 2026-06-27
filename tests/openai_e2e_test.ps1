# OpenAI-compatible Provider mock HTTP E2E Test
# This script starts a mock HTTP server and runs real CLI commands

$ErrorActionPreference = "Stop"
$originalDir = Get-Location
$tmpdir = Join-Path $env:TEMP "devspace-openai-e2e-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "=" * 70
Write-Host "OpenAI-compatible Provider mock HTTP E2E Test"
Write-Host "=" * 70
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""

# Create test directory
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
Set-Location $tmpdir

$cliPath = Join-Path $originalDir "dist\cli.js"
$allPassed = $true
$testResults = @()

# Helper function to run CLI command
function Run-CliCommand {
    param(
        [string]$Command,
        [string]$Description,
        [int]$ExpectedExitCode = 0,
        [string]$TestCase = ""
    )

    Write-Host "  Running: $Description"
    Write-Host "  Command: node $cliPath $Command"
    if ($TestCase) {
        Write-Host "  Test Case: $TestCase"
    }

    $result = & node $cliPath $Command.Split(" ") 2>&1
    $exitCode = $LASTEXITCODE

    Write-Host "  Exit Code: $exitCode (expected: $ExpectedExitCode)"

    $passed = $exitCode -eq $ExpectedExitCode
    if ($passed) {
        Write-Host "  [PASS] Exit code matches"
    } else {
        Write-Host "  [FAIL] Exit code mismatch!"
        $script:allPassed = $false
    }

    Write-Host "  Output:"
    $result | ForEach-Object { Write-Host "    $_" }
    Write-Host ""

    return @{
        ExitCode = $exitCode
        Output = $result
        Passed = $passed
        TestCase = $TestCase
    }
}

# Start mock HTTP server
Write-Host "Starting mock HTTP server..."
$serverScript = Join-Path $originalDir "tests\mock_openai_server.py"
$serverProcess = Start-Process -FilePath "python" -ArgumentList $serverScript, "11435" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

# ============================================================
# Task 1: Initialize workspace
# ============================================================
Write-Host "=" * 70
Write-Host "[Task 1] Initialize workspace"
Write-Host "=" * 70
Write-Host ""

# handoff init
Write-Host "-" * 40
$result = Run-CliCommand -Command "handoff init" -Description "Initialize Handoff Package"

# handoff validate
Write-Host "-" * 40
$result = Run-CliCommand -Command "handoff validate" -Description "Validate Handoff Package"

# delegate start
Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode"

# ============================================================
# Task 2: Test case A - PASS + next_task
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 2] Test case A: PASS + next_task"
Write-Host "=" * 70
Write-Host ""

# Set environment variables for OpenAI provider
$env:OPENAI_API_URL = "http://127.0.0.1:11435"
$env:OPENAI_API_KEY = "test-key"
$env:OPENAI_MODEL = "gpt-4"

Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 1" -Description "Run with OpenAI Coach Provider (PASS + next_task)" -TestCase "pass_next_task"

$stateFile = Join-Path $tmpdir ".devspace\state.json"
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"

    if ($state.status -ne "BRAINSTORM" -and $state.status -ne "NEEDS_FIX") {
        Write-Host "  [PASS] Final state is valid"
    } else {
        Write-Host "  [FAIL] Final state is invalid: $($state.status)"
        $script:allPassed = $false
    }
}

# ============================================================
# Task 3: Test case B - DONE
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 3] Test case B: DONE"
Write-Host "=" * 70
Write-Host ""

# Reset state for new test
Remove-Item -Path $stateFile -Force -ErrorAction SilentlyContinue

Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode" -TestCase "done"
$result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 1" -Description "Run with OpenAI Coach Provider (DONE)" -TestCase "done"

if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"

    if ($state.status -eq "DONE") {
        Write-Host "  [PASS] Final state is DONE"
    } else {
        Write-Host "  [FAIL] Final state is not DONE: $($state.status)"
        $script:allPassed = $false
    }
}

# ============================================================
# Task 4: Test case C - Missing verdict → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 4] Test case C: Missing verdict → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state for new test
Remove-Item -Path $stateFile -Force -ErrorAction SilentlyContinue

Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode" -TestCase "missing_verdict"
$result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 1" -Description "Run with OpenAI Coach Provider (missing verdict)" -TestCase "missing_verdict"

if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"

    if ($state.status -eq "BLOCKED") {
        Write-Host "  [PASS] Final state is BLOCKED (not NEEDS_FIX)"
    } else {
        Write-Host "  [FAIL] Final state is not BLOCKED: $($state.status)"
        $script:allPassed = $false
    }
}

# ============================================================
# Task 5: Test case D - PASS but no next_task → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 5] Test case D: PASS but no next_task → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state for new test
Remove-Item -Path $stateFile -Force -ErrorAction SilentlyContinue

Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode" -TestCase "pass_no_next_task"
$result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 1" -Description "Run with OpenAI Coach Provider (PASS no next_task)" -TestCase "pass_no_next_task"

if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"

    if ($state.status -eq "BLOCKED") {
        Write-Host "  [PASS] Final state is BLOCKED"
    } else {
        Write-Host "  [FAIL] Final state is not BLOCKED: $($state.status)"
        $script:allPassed = $false
    }
}

# ============================================================
# Task 6: Test case E - Invalid JSON → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 6] Test case E: Invalid JSON → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state for new test
Remove-Item -Path $stateFile -Force -ErrorAction SilentlyContinue

Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode" -TestCase "invalid_json"
$result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 1" -Description "Run with OpenAI Coach Provider (invalid JSON)" -TestCase "invalid_json"

if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"

    if ($state.status -eq "BLOCKED" -or $state.status -eq "NEED_USER") {
        Write-Host "  [PASS] Final state is BLOCKED or NEED_USER"
    } else {
        Write-Host "  [FAIL] Final state is not BLOCKED or NEED_USER: $($state.status)"
        $script:allPassed = $false
    }
}

# ============================================================
# Task 7: Output Final Report
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "OpenAI-compatible Provider E2E Report"
Write-Host "=" * 70
Write-Host ""

Write-Host "Test Results:"
if ($allPassed) {
    Write-Host "  Overall: PASS"
} else {
    Write-Host "  Overall: FAIL"
}

Write-Host ""
Write-Host "Generated Files:"
Get-ChildItem -Path $tmpdir -Recurse -File | ForEach-Object {
    Write-Host "  $($_.FullName.Replace($tmpdir, '.'))"
}

Write-Host ""
Write-Host "Final State:"
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  Mode: $($state.mode)"
    Write-Host "  Status: $($state.status)"
    Write-Host "  Stop Reason: $($state.stop_reason)"
}

# Stop mock server
if ($serverProcess -and !$serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
}

# Cleanup
Set-Location $originalDir
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""

# Exit with appropriate code
if (-not $allPassed) {
    exit 1
}
