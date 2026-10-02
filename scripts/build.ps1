<#
.SYNOPSIS
  Local build for Personal AI OS. No Docker, no deploy, starts no servers.

.DESCRIPTION
  1. Checks prerequisites (Python >= 3.10, Node >= 18, npm).
  2. Creates/updates the Python venv (apps/api/.venv) and npm workspaces from the lock file.
  3. Runs the gates: ruff, ruff format, pytest, tsc, eslint (0 warnings), vitest. Optional Playwright.
  4. Writes artifacts to out/:
       out/web/            production UI bundle (static files)
       out/wheels/         pos_schemas + pos_api wheels
       out/BUILD_INFO.json commit, versions, checks run, sha256 of every artifact

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build.ps1
  powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Clean -E2E
#>
[CmdletBinding()]
param(
  # Remove out/, the venv and node_modules first, then install from the lock files (npm ci).
  [switch]$Clean,
  # Build artifacts only; skip lint/type/unit gates.
  [switch]$SkipChecks,
  # Also run the Playwright suite (starts its own throwaway servers on 8001/5174, stops them after).
  [switch]$E2E
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Api = Join-Path $Root "apps\api"
$Web = Join-Path $Root "apps\workspace"
$Out = Join-Path $Root "out"
$Venv = Join-Path $Api ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"
$results = New-Object System.Collections.Generic.List[object]

function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [string]$Cwd = $Root)
  Push-Location $Cwd
  try {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Body
    $results.Add([pscustomobject]@{ step = $Name; status = "ok"; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
  } catch {
    $results.Add([pscustomobject]@{ step = $Name; status = "FAILED"; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
    Write-Host ""
    $results | Format-Table -AutoSize | Out-String | Write-Host
    Write-Host "BUILD FAILED at '$Name': $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}

function Get-Version([string]$Exe, [string]$Arg = "--version") {
  try { (& $Exe $Arg 2>&1 | Out-String).Trim() } catch { $null }
}

# ---------------------------------------------------------------- prerequisites
Step "prerequisites" {
  $pyv = Get-Version "python"
  $nodev = Get-Version "node"
  $npmv = Get-Version "npm"
  if (-not $pyv) { throw "python not found on PATH (need >= 3.10)" }
  if (-not $nodev) { throw "node not found on PATH (need >= 18)" }
  if (-not $npmv) { throw "npm not found on PATH" }
  $pm = [regex]::Match($pyv, "(\d+)\.(\d+)")
  if ([int]$pm.Groups[1].Value -lt 3 -or ([int]$pm.Groups[1].Value -eq 3 -and [int]$pm.Groups[2].Value -lt 10)) { throw "$pyv is too old (need >= 3.10)" }
  if ([int]([regex]::Match($nodev, "v(\d+)").Groups[1].Value) -lt 18) { throw "node $nodev is too old (need >= 18)" }
  Write-Host "  $pyv | node $nodev | npm $npmv"
}

# ---------------------------------------------------------------- clean
if ($Clean) {
  Step "clean (out/, venv, node_modules)" {
    foreach ($p in @($Out, $Venv, (Join-Path $Root "node_modules"), (Join-Path $Web "node_modules"), (Join-Path $Web "dist"))) {
      if (Test-Path $p) {
        try { Remove-Item -Recurse -Force $p }
        catch { throw "could not delete $p (stop running dev servers / editors holding files): $($_.Exception.Message)" }
        Write-Host "  removed $p"
      }
    }
  }
}

# ---------------------------------------------------------------- install
Step "python venv + deps" {
  if (-not (Test-Path $Py)) { Invoke-Native "python" @("-m", "venv", $Venv) }
  Invoke-Native $Py @("-m", "pip", "install", "-q", "--disable-pip-version-check", "-e", "packages/schemas/python", "-e", "apps/api[dev]")
}

Step "npm deps (from package-lock.json)" {
  $nm = Join-Path $Root "node_modules"
  if ($Clean -or -not (Test-Path $nm)) { Invoke-Native "npm" @("ci", "--no-audit", "--no-fund") }
  else { Invoke-Native "npm" @("install", "--no-audit", "--no-fund") }
}

# ---------------------------------------------------------------- gates
$checksRun = @()
if (-not $SkipChecks) {
  Step "ruff check" { Invoke-Native (Join-Path $Venv "Scripts\ruff.exe") @("check", ".", "../../packages/schemas/python") $Api }
  Step "ruff format --check" { Invoke-Native (Join-Path $Venv "Scripts\ruff.exe") @("format", "--check", ".", "../../packages/schemas/python") $Api }
  Step "pytest" { Invoke-Native $Py @("-m", "pytest", "-q", "-p", "no:warnings") $Api }
  Step "tsc" { Invoke-Native "npm" @("run", "typecheck", "--silent") }
  Step "eslint (--max-warnings 0)" { Invoke-Native "npm" @("run", "lint", "--silent") }
  Step "vitest" { Invoke-Native "npm" @("test", "--silent") }
  $checksRun += @("ruff", "ruff-format", "pytest", "tsc", "eslint", "vitest")
}
if ($E2E) {
  Step "playwright e2e" { Invoke-Native "npx" @("playwright", "test") $Web }
  $checksRun += "playwright"
}

# ---------------------------------------------------------------- artifacts
Step "web bundle -> out/web" {
  Invoke-Native "npx" @("vite", "build", "--outDir", (Join-Path $Out "web"), "--emptyOutDir", "--logLevel", "error") $Web
}

Step "python wheels -> out/wheels" {
  $wheels = Join-Path $Out "wheels"
  if (Test-Path $wheels) { Remove-Item -Recurse -Force $wheels }
  Invoke-Native $Py @("-m", "pip", "wheel", "-q", "--disable-pip-version-check", "--no-deps", "-w", $wheels, "packages/schemas/python", "apps/api")
  # setuptools leaves build/ next to the sources; keep the source tree untouched
  foreach ($d in @("packages/schemas/python/build", "apps/api/build")) {
    $full = Join-Path $Root $d
    if (Test-Path $full) { Remove-Item -Recurse -Force $full }
  }
}

Step "BUILD_INFO.json" {
  $commit = (& git -C $Root rev-parse --short HEAD 2>$null)
  $dirty = [bool](& git -C $Root status --porcelain 2>$null)
  $files = Get-ChildItem -Recurse -File $Out | Where-Object { $_.Name -ne "BUILD_INFO.json" } | ForEach-Object {
    [pscustomobject]@{
      path = $_.FullName.Substring($Out.Length + 1).Replace("\", "/")
      bytes = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower()
    }
  }
  $info = [ordered]@{
    built_at = (Get-Date).ToUniversalTime().ToString("o")
    commit = $commit
    dirty_worktree = $dirty
    python = (& $Py --version)
    node = (& node --version)
    checks = $checksRun
    deploy = "none (local build only)"
    artifacts = $files
  }
  # UTF-8 without BOM (PowerShell 5.1's -Encoding UTF8 adds one; strict JSON readers reject it)
  [IO.File]::WriteAllText((Join-Path $Out "BUILD_INFO.json"), ($info | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  $webBytes = ($files | Where-Object { $_.path -like "web/*" } | Measure-Object bytes -Sum).Sum
  Write-Host ("  {0} files, web bundle {1:N0} KB, wheels: {2}" -f $files.Count, ($webBytes / 1KB), (($files | Where-Object { $_.path -like "wheels/*" }).path -join ", "))
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "BUILD OK -> $Out   (nothing deployed, no servers started)" -ForegroundColor Green
