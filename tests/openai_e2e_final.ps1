# OpenAI-compatible Provider E2E Final Test
# This script starts a mock HTTP server for each test case and runs real CLI commands

$ErrorActionPreference = "Stop"
$originalDir = Get-Location
$tmpdir = Join-Path $env:TEMP "devspace-openai-e2e-final-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "=" * 70
Write-Host "OpenAI-compatible Provider E2E Final Test"
Write-Host "=" * 70
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""

# Create test directory
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
Set-Location $tmpdir

$cliPath = Join-Path $originalDir "dist\cli.js"
$serverScript = Join-Path $originalDir "tests\mock_openai_server.py"
$allPassed = $true
$port = 11435

# Helper function to start mock server
function Start-MockServer {
    param([string]$TestCase)

    Write-Host "  Starting mock server for test case: $TestCase on port $port"

    # Kill any existing server on the port
    Get-Process -Name "python" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like "*mock_openai_server*"} | Stop-Process -Force -ErrorAction SilentlyContinue

    # Start new server
    $serverProcess = Start-Process -FilePath "python" -ArgumentList $serverScript, $port, $TestCase -PassThru -NoNewWindow -RedirectStandardOutput "$tmpdir\server_$TestCase.log" -RedirectStandardError "$tmpdir\server_${TestCase}_err.log"

    # Wait for server to start
    Start-Sleep -Seconds 2

    # Check if server is running
    if ($serverProcess.HasExited) {
        Write-Host "  [FAIL] Server failed to start!"
        $script:allPassed = $false
        return $null
    }

    Write-Host "  [INFO] Server started with PID: $($serverProcess.Id)"
    return $serverProcess
}

# Helper function to stop mock server
function Stop-MockServer {
    param($ServerProcess)

    if ($ServerProcess -and !$ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  [INFO] Server stopped"
    }
}

# Helper function to run CLI command
function Run-CliCommand {
    param(
        [string]$Command,
        [string]$Description,
        [int]$ExpectedExitCode = 0
    )

    Write-Host "  Running: $Description"
    Write-Host "  Command: node $cliPath $Command"

    $result = & node $cliPath $Command.Split(" ") 2>&1
    $exitCode = $LASTEXITCODE

    Write-Host "  Exit Code: $exitCode (expected: $ExpectedExitCode)"

    if ($exitCode -ne $ExpectedExitCode) {
        Write-Host "  [FAIL] Exit code mismatch!"
        $script:allPassed = $false
    } else {
        Write-Host "  [PASS] Exit code matches"
    }

    Write-Host "  Output:"
    $result | ForEach-Object { Write-Host "    $_" }
    Write-Host ""

    return @{
        ExitCode = $exitCode
        Output = $result
    }
}

# Helper function to verify files
function Verify-Files {
    param([string]$RunDir, [string[]]$RequiredFiles)

    Write-Host "  Verifying files in: $RunDir"

    foreach ($file in $RequiredFiles) {
        $filePath = Join-Path $RunDir $file
        if (Test-Path $filePath) {
            $content = Get-Content $filePath -Raw
            $lines = ($content -split "`n").Count
            Write-Host "  [PASS] $file exists ($lines lines)"
        } else {
            Write-Host "  [FAIL] $file missing"
            $script:allPassed = $false
        }
    }
}

# Set environment variables for OpenAI provider
$env:OPENAI_API_URL = "http://127.0.0.1:$port"
$env:OPENAI_API_KEY = "test-key"
$env:OPENAI_MODEL = "gpt-4"

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

$serverProcess = Start-MockServer -TestCase "pass_next_task"

if ($serverProcess) {
    Write-Host "-" * 40
    $result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 2" -Description "Run with OpenAI Coach Provider (PASS + next_task)"

    $stateFile = Join-Path $tmpdir ".devspace\state.json"
    if (Test-Path $stateFile) {
        $state = Get-Content $stateFile | ConvertFrom-Json
        Write-Host "  [INFO] Final state: $($state.status)"

        if ($state.status -eq "DONE" -or $state.status -eq "DELEGATE_RUNNING" -or $state.status -eq "NEED_USER") {
            Write-Host "  [PASS] Final state is valid (not BLOCKED for success case)"
        } else {
            Write-Host "  [FAIL] Final state is invalid: $($state.status)"
            $script:allPassed = $false
        }
    }

    # Verify run files
    $runsDir = Join-Path $tmpdir ".devspace\runs"
    if (Test-Path $runsDir) {
        $runDirs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($runDirs) {
            Verify-Files -RunDir $runDirs.FullName -RequiredFiles @("run_state.json", "local_report.md", "coach_review.md")
        }
    }

    Stop-MockServer -ServerProcess $serverProcess
}

# ============================================================
# Task 3: Test case B - DONE
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 3] Test case B: DONE"
Write-Host "=" * 70
Write-Host ""

# Reset state
Remove-Item -Path (Join-Path $tmpdir ".devspace\state.json") -Force -ErrorAction SilentlyContinue

$serverProcess = Start-MockServer -TestCase "done"

if ($serverProcess) {
    Write-Host "-" * 40
    $result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode"
    $result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 2" -Description "Run with OpenAI Coach Provider (DONE)"

    $stateFile = Join-Path $tmpdir ".devspace\state.json"
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

    # Verify run files
    $runsDir = Join-Path $tmpdir ".devspace\runs"
    if (Test-Path $runsDir) {
        $runDirs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($runDirs) {
            Verify-Files -RunDir $runDirs.FullName -RequiredFiles @("run_state.json", "final_report.md")
        }
    }

    Stop-MockServer -ServerProcess $serverProcess
}

# ============================================================
# Task 4: Test case C - Missing verdict → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 4] Test case C: Missing verdict → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state
Remove-Item -Path (Join-Path $tmpdir ".devspace\state.json") -Force -ErrorAction SilentlyContinue

$serverProcess = Start-MockServer -TestCase "missing_verdict"

if ($serverProcess) {
    Write-Host "-" * 40
    $result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode"
    $result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 2" -Description "Run with OpenAI Coach Provider (missing verdict)"

    $stateFile = Join-Path $tmpdir ".devspace\state.json"
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

    # Verify run files
    $runsDir = Join-Path $tmpdir ".devspace\runs"
    if (Test-Path $runsDir) {
        $runDirs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($runDirs) {
            Verify-Files -RunDir $runDirs.FullName -RequiredFiles @("run_state.json", "blocked_report.md")
        }
    }

    Stop-MockServer -ServerProcess $serverProcess
}

# ============================================================
# Task 5: Test case D - PASS but no next_task → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 5] Test case D: PASS but no next_task → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state
Remove-Item -Path (Join-Path $tmpdir ".devspace\state.json") -Force -ErrorAction SilentlyContinue

$serverProcess = Start-MockServer -TestCase "pass_no_next_task"

if ($serverProcess) {
    Write-Host "-" * 40
    $result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode"
    $result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 2" -Description "Run with OpenAI Coach Provider (PASS no next_task)"

    $stateFile = Join-Path $tmpdir ".devspace\state.json"
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

    # Verify run files
    $runsDir = Join-Path $tmpdir ".devspace\runs"
    if (Test-Path $runsDir) {
        $runDirs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($runDirs) {
            Verify-Files -RunDir $runDirs.FullName -RequiredFiles @("run_state.json", "blocked_report.md")
        }
    }

    Stop-MockServer -ServerProcess $serverProcess
}

# ============================================================
# Task 6: Test case E - Invalid JSON → BLOCKED
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 6] Test case E: Invalid JSON → BLOCKED"
Write-Host "=" * 70
Write-Host ""

# Reset state
Remove-Item -Path (Join-Path $tmpdir ".devspace\state.json") -Force -ErrorAction SilentlyContinue

$serverProcess = Start-MockServer -TestCase "invalid_json"

if ($serverProcess) {
    Write-Host "-" * 40
    $result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode"
    $result = Run-CliCommand -Command "delegate run --coach-provider openai --executor-provider mock --max-rounds 2" -Description "Run with OpenAI Coach Provider (invalid JSON)"

    $stateFile = Join-Path $tmpdir ".devspace\state.json"
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

    # Verify run files
    $runsDir = Join-Path $tmpdir ".devspace\runs"
    if (Test-Path $runsDir) {
        $runDirs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($runDirs) {
            Verify-Files -RunDir $runDirs.FullName -RequiredFiles @("run_state.json", "blocked_report.md")
        }
    }

    Stop-MockServer -ServerProcess $serverProcess
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
Get-ChildItem -Path $tmpdir -Recurse -File | Where-Object { $_.Name -notlike "server_*" } | ForEach-Object {
    Write-Host "  $($_.FullName.Replace($tmpdir, '.'))"
}

Write-Host ""
Write-Host "Final State:"
$stateFile = Join-Path $tmpdir ".devspace\state.json"
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  Mode: $($state.mode)"
    Write-Host "  Status: $($state.status)"
    Write-Host "  Stop Reason: $($state.stop_reason)"
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
