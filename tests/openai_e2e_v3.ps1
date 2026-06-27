# OpenAI-compatible Provider E2E Test v3
$ErrorActionPreference = "Stop"
$originalDir = Get-Location
$tmpdir = Join-Path $env:TEMP "devspace-openai-v3-$(Get-Date -Format 'yyyyMMddHHmmss')"

Write-Host "=" * 70
Write-Host "OpenAI-compatible Provider E2E Test v3"
Write-Host "=" * 70

New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
New-Item -ItemType Directory -Path "$tmpdir\.devspace" -Force | Out-Null
Set-Location $tmpdir

$cliPath = Join-Path $originalDir "dist\cli.js"
$serverScript = Join-Path $originalDir "tests\mock_openai_server.py"
$port = 11435
$allPassed = $true

function Kill-Port([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($conn) {
        $conn.OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    }
}

function Start-MockServer([string]$TestCase) {
    Kill-Port $port
    Start-Sleep -Seconds 1
    $p = Start-Process -FilePath "python" -ArgumentList $serverScript, $port, $TestCase -PassThru -NoNewWindow
    Start-Sleep -Seconds 3
    if ($p.HasExited) { Write-Host "  [FAIL] Server failed"; return $null }
    $listening = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if (!$listening) { Write-Host "  [FAIL] Server not listening"; return $null }
    Write-Host "  [INFO] Server PID: $($p.Id) case=$TestCase"
    return $p
}

function Stop-MockServer($p) {
    if ($p -and !$p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Kill-Port $port
}

function Run-Cli([string]$Cmd, [string]$Desc) {
    Write-Host "  CMD: node $cliPath $Cmd"
    $r = & node $cliPath $Cmd.Split(" ") 2>&1
    $e = $LASTEXITCODE
    Write-Host "  EXIT: $e"
    $r | ForEach-Object { Write-Host "    $_" }

    # Check no DEBUG output
    $debugLines = $r | Where-Object { $_ -match '\[DEBUG\]' }
    if ($debugLines) {
        Write-Host "  [FAIL] DEBUG output detected in CLI"
        $script:allPassed = $false
    }

    return @{ ExitCode=$e; Output=$r }
}

function Check-State([string[]]$Expected) {
    $sf = Join-Path $tmpdir ".devspace\state.json"
    if (Test-Path $sf) {
        $s = Get-Content $sf | ConvertFrom-Json
        Write-Host "  STATE: $($s.status)"
        if ($Expected -contains $s.status) { Write-Host "  [PASS] State=$($s.status)"; return $true }
        Write-Host "  [FAIL] Expected $($Expected -join '/'), got $($s.status)"
        $script:allPassed = $false
        return $false
    }
    Write-Host "  [FAIL] No state.json"
    $script:allPassed = $false
    return $false
}

function Check-Artifacts([string[]]$CaseSpecificFiles) {
    Write-Host "  Checking artifacts..."

    # Check state.json
    $sf = Join-Path $tmpdir ".devspace\state.json"
    if (Test-Path $sf) { Write-Host "  [PASS] state.json" }
    else { Write-Host "  [FAIL] state.json missing"; $script:allPassed=$false }

    # Check conversation.jsonl
    $cf = Join-Path $tmpdir ".devspace\conversation.jsonl"
    if (Test-Path $cf) { Write-Host "  [PASS] conversation.jsonl" }
    else { Write-Host "  [FAIL] conversation.jsonl missing"; $script:allPassed=$false }

    # Check run directory files
    $rd = Join-Path $tmpdir ".devspace\runs"
    if (!(Test-Path $rd)) { Write-Host "  [FAIL] No runs dir"; $script:allPassed=$false; return }
    $latest = Get-ChildItem -Path $rd -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (!$latest) { Write-Host "  [FAIL] No run dir"; $script:allPassed=$false; return }
    Write-Host "  RUN: $($latest.Name)"

    # Always check run_state.json
    $rsf = Join-Path $latest.FullName "run_state.json"
    if (Test-Path $rsf) { Write-Host "  [PASS] run_state.json" }
    else { Write-Host "  [FAIL] run_state.json missing"; $script:allPassed=$false }

    # Always check local_report.md
    $lrf = Join-Path $latest.FullName "local_report.md"
    if (Test-Path $lrf) { Write-Host "  [PASS] local_report.md" }
    else { Write-Host "  [FAIL] local_report.md missing"; $script:allPassed=$false }

    # Always check coach_review.md
    $crf = Join-Path $latest.FullName "coach_review.md"
    if (Test-Path $crf) { Write-Host "  [PASS] coach_review.md" }
    else { Write-Host "  [FAIL] coach_review.md missing"; $script:allPassed=$false }

    # Check case-specific files
    foreach ($f in $CaseSpecificFiles) {
        $fp = Join-Path $latest.FullName $f
        if (Test-Path $fp) { Write-Host "  [PASS] $f" }
        else { Write-Host "  [FAIL] $f missing"; $script:allPassed=$false }
    }
}

# Set environment variables
$env:OPENAI_API_URL = "http://127.0.0.1:$port"
$env:OPENAI_API_KEY = "test"
$env:OPENAI_MODEL = "test"

# Init
Run-Cli "handoff init" "Init" | Out-Null
Run-Cli "delegate start" "Start" | Out-Null

# Case A: PASS + next_task -> BUDGET_STOP (rounds exceeded)
Write-Host "`n" + "=" * 70
Write-Host "CASE A: PASS + next_task (expect BUDGET_STOP after max rounds)"
$srv = Start-MockServer "pass_next_task"
if ($srv) {
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 5" "PASS+next_task"
    Check-State @("BUDGET_STOP","DONE")
    Check-Artifacts @("budget_stop_report.md")
    Stop-MockServer $srv
}

# Case B: DONE
Write-Host "`n" + "=" * 70
Write-Host "CASE B: DONE"
Remove-Item "$tmpdir\.devspace\state.json" -Force -ErrorAction SilentlyContinue
$srv = Start-MockServer "done"
if ($srv) {
    Run-Cli "delegate start" "Start" | Out-Null
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 5" "DONE"
    Check-State @("DONE")
    Check-Artifacts @("final_report.md")
    Stop-MockServer $srv
}

# Case C: Missing verdict
Write-Host "`n" + "=" * 70
Write-Host "CASE C: Missing verdict"
Remove-Item "$tmpdir\.devspace\state.json" -Force -ErrorAction SilentlyContinue
$srv = Start-MockServer "missing_verdict"
if ($srv) {
    Run-Cli "delegate start" "Start" | Out-Null
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 5" "Missing verdict"
    Check-State @("BLOCKED")
    Check-Artifacts @("blocked_report.md")
    Stop-MockServer $srv
}

# Case D: PASS no next_task
Write-Host "`n" + "=" * 70
Write-Host "CASE D: PASS no next_task"
Remove-Item "$tmpdir\.devspace\state.json" -Force -ErrorAction SilentlyContinue
$srv = Start-MockServer "pass_no_next_task"
if ($srv) {
    Run-Cli "delegate start" "Start" | Out-Null
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 5" "PASS no next_task"
    Check-State @("BLOCKED")
    Check-Artifacts @("blocked_report.md")
    Stop-MockServer $srv
}

# Case E: Invalid JSON
Write-Host "`n" + "=" * 70
Write-Host "CASE E: Invalid JSON"
Remove-Item "$tmpdir\.devspace\state.json" -Force -ErrorAction SilentlyContinue
$srv = Start-MockServer "invalid_json"
if ($srv) {
    Run-Cli "delegate start" "Start" | Out-Null
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 5" "Invalid JSON"
    Check-State @("BLOCKED")
    Check-Artifacts @("blocked_report.md")
    Stop-MockServer $srv
}

# Case F: Timeout
Write-Host "`n" + "=" * 70
Write-Host "CASE F: Timeout"
Remove-Item "$tmpdir\.devspace\state.json" -Force -ErrorAction SilentlyContinue
$srv = Start-MockServer "timeout"
if ($srv) {
    Run-Cli "delegate start" "Start" | Out-Null
    $r = Run-Cli "delegate run --coach-provider openai --executor-provider mock --max-rounds 2 --timeout 2" "Timeout"
    Check-State @("BLOCKED","BUDGET_STOP")
    Check-Artifacts @("blocked_report.md")
    Stop-MockServer $srv
}

# Summary
Write-Host "`n" + "=" * 70
Write-Host "SUMMARY"
Write-Host "=" * 70
if ($allPassed) { Write-Host "Overall: PASS" } else { Write-Host "Overall: FAIL" }

Set-Location $originalDir
Write-Host "Dir: $tmpdir"
if (!$allPassed) { exit 1 }
