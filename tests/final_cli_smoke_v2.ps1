# Final CLI Provider Smoke Test v2
# This script runs real CLI commands and verifies file generation

$ErrorActionPreference = "Stop"
$originalDir = Get-Location
$tmpdir = Join-Path $env:TEMP "devspace-final-smoke-v2-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "=" * 70
Write-Host "Final CLI Provider Smoke Test v2"
Write-Host "=" * 70
Write-Host ""
Write-Host "Test directory: $tmpdir"
Write-Host ""

# Create test directory
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
Set-Location $tmpdir

$cliPath = Join-Path $originalDir "dist\cli.js"
$allPassed = $true

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

# ============================================================
# Task 1: Mock Provider CLI E2E
# ============================================================
Write-Host "=" * 70
Write-Host "[Task 1] Mock Provider CLI E2E"
Write-Host "=" * 70
Write-Host ""

# Step 1: handoff init
Write-Host "-" * 40
$result = Run-CliCommand -Command "handoff init" -Description "Initialize Handoff Package" -ExpectedExitCode 0

# Verify ceo directory created
$ceoDir = Join-Path $tmpdir ".devspace\ceo"
if (Test-Path $ceoDir) {
    $files = Get-ChildItem -Path $ceoDir -Filter "*.md"
    Write-Host "  [PASS] .devspace\ceo created with $($files.Count) files"
} else {
    Write-Host "  [FAIL] .devspace\ceo not created"
    $script:allPassed = $false
}

# Step 2: handoff validate
Write-Host "-" * 40
$result = Run-CliCommand -Command "handoff validate" -Description "Validate Handoff Package" -ExpectedExitCode 0

# Step 3: delegate start
Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate start" -Description "Start Delegate Mode" -ExpectedExitCode 0

# Verify state.json
$stateFile = Join-Path $tmpdir ".devspace\state.json"
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] State: $($state.status)"
    Write-Host "  [INFO] Mode: $($state.mode)"
}

# Step 4: delegate run --provider mock --max-rounds 2
Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate run --provider mock --max-rounds 2" -Description "Run with Mock Provider (2 rounds)" -ExpectedExitCode 0

# Verify final state
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"
    
    if ($state.status -ne "BRAINSTORM") {
        Write-Host "  [PASS] Final state is not BRAINSTORM"
    } else {
        Write-Host "  [FAIL] Final state is BRAINSTORM"
        $script:allPassed = $false
    }
}

# Step 5: timeline
Write-Host "-" * 40
$result = Run-CliCommand -Command "timeline" -Description "Show Timeline" -ExpectedExitCode 0

# Verify generated files
Write-Host "-" * 40
Write-Host "  Verifying generated files..."

$filesToCheck = @(
    @{Path=".devspace\state.json"; Required=$true},
    @{Path=".devspace\conversation.jsonl"; Required=$true},
    @{Path=".devspace\ceo\delegate_contract.md"; Required=$true},
    @{Path=".devspace\ceo\stop_conditions.md"; Required=$true},
    @{Path=".devspace\ceo\first_task.md"; Required=$true}
)

foreach ($file in $filesToCheck) {
    $fullPath = Join-Path $tmpdir $file.Path
    if (Test-Path $fullPath) {
        $content = Get-Content $fullPath -Raw
        $lines = ($content -split "`n").Count
        Write-Host "  [PASS] $($file.Path) exists ($lines lines)"
    } else {
        Write-Host "  [FAIL] $($file.Path) missing"
        $script:allPassed = $false
    }
}

# Check runs directory
$runsDir = Join-Path $tmpdir ".devspace\runs"
if (Test-Path $runsDir) {
    $runDirs = Get-ChildItem -Path $runsDir -Directory
    Write-Host "  [INFO] Found $($runDirs.Count) run directories"
    
    foreach ($runDir in $runDirs) {
        Write-Host "  [INFO] Run: $($runDir.Name)"
        $runFiles = Get-ChildItem -Path $runDir.FullName -File
        foreach ($runFile in $runFiles) {
            Write-Host "    - $($runFile.Name)"
        }
    }
} else {
    Write-Host "  [WARN] No runs directory found"
}

# ============================================================
# Task 2: Ollama Provider failure-path CLI E2E
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "[Task 2] Ollama Provider failure-path CLI E2E"
Write-Host "=" * 70
Write-Host ""

# Run Ollama provider with short timeout (expected to fail)
Write-Host "-" * 40
$result = Run-CliCommand -Command "delegate run --provider ollama --max-rounds 2 --timeout 5" -Description "Run with Ollama Provider (expected BLOCKED)" -ExpectedExitCode 0

# Verify final state
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    Write-Host "  [INFO] Final state: $($state.status)"
    Write-Host "  [INFO] Stop reason: $($state.stop_reason)"
    
    if ($state.status -eq "BLOCKED") {
        Write-Host "  [PASS] State is BLOCKED (not NEEDS_FIX)"
    } else {
        Write-Host "  [FAIL] State is $($state.status), expected BLOCKED"
        $script:allPassed = $false
    }
}

# Check for blocked_report.md
$runsDir = Join-Path $tmpdir ".devspace\runs"
if (Test-Path $runsDir) {
    $blockedReports = Get-ChildItem -Path $runsDir -Recurse -Filter "blocked_report.md"
    if ($blockedReports.Count -gt 0) {
        Write-Host "  [PASS] blocked_report.md found"
    } else {
        Write-Host "  [WARN] No blocked_report.md found"
    }
}

# Check conversation.jsonl for provider_error
$conversationFile = Join-Path $tmpdir ".devspace\conversation.jsonl"
if (Test-Path $conversationFile) {
    $content = Get-Content $conversationFile -Raw
    if ($content -match "provider" -or $content -match "BLOCKED") {
        Write-Host "  [PASS] conversation.jsonl contains provider/BLOCKED entries"
    } else {
        Write-Host "  [WARN] No provider/BLOCKED entries in conversation.jsonl"
    }
}

# ============================================================
# Task 3: Output Final Report
# ============================================================
Write-Host ""
Write-Host "=" * 70
Write-Host "Final CLI Provider Smoke Report"
Write-Host "=" * 70
Write-Host ""

Write-Host "Test Results:"
if ($allPassed) {
    Write-Host "  Overall: PASS"
} else {
    Write-Host "  Overall: FAIL"
}
Write-Host "  Mock Provider CLI E2E: $(if ($allPassed) {'PASS'} else {'FAIL'})"
Write-Host "  Ollama Provider failure-path: $(if ($allPassed) {'PASS'} else {'FAIL'})"
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

Write-Host ""
Write-Host "Recommendation:"
if ($allPassed) {
    Write-Host "  All CLI Provider smoke tests passed."
    Write-Host "  Ready for MCP integration."
} else {
    Write-Host "  Some tests failed. Fix issues before MCP integration."
}

# Cleanup
Set-Location $originalDir
Write-Host ""
Write-Host "Test directory: $tmpdir"

# Exit with appropriate code
if (-not $allPassed) {
    exit 1
}
