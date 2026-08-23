# ============================================================
# SandustryMP - co-op multiplayer mod for Sandustry
# Author: Cr0ss0vr
# Self-contained installer: no Node.js, no internet required.
# Run install.bat (recommended) or right-click -> Run with PowerShell
# ============================================================

$ErrorActionPreference = "Stop"
Write-Host ""
Write-Host "=== SandustryMP installer (by Cr0ss0vr) ===" -ForegroundColor Yellow
Write-Host ""

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host "Send a screenshot of this window to the mod author for help." -ForegroundColor Yellow
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" }
    exit 1
}

# --- 1. Locate Sandustry (Steam, Microsoft Store, Xbox, or Game Pass) ------
$candidatePaths = New-Object System.Collections.Generic.List[string]
$sandustrySteamAppId = "2764460"
$sandustryStoreProductId = "9PPH71DV44T7"

function Add-InstallCandidate($path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return }
    $expanded = [Environment]::ExpandEnvironmentVariables($path.Trim().Trim('"'))
    try { $fullPath = [System.IO.Path]::GetFullPath($expanded) } catch { return }
    if ([System.IO.Path]::GetFileName($fullPath) -ieq "Sandustry.exe") {
        $fullPath = [System.IO.Path]::GetDirectoryName($fullPath)
    }
    $candidatePaths.Add($fullPath.TrimEnd('\'))
}

function Add-SteamLibraryCandidate($libraryRoot) {
    if ([string]::IsNullOrWhiteSpace($libraryRoot)) { return }
    $steamApps = Join-Path $libraryRoot "steamapps"
    $manifest = Join-Path $steamApps "appmanifest_$sandustrySteamAppId.acf"
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $manifest -ErrorAction SilentlyContinue) {
            if ($line -match '^\s*"installdir"\s+"(.+?)"') {
                Add-InstallCandidate (Join-Path (Join-Path $steamApps "common") $Matches[1])
                break
            }
        }
    }
    Add-InstallCandidate (Join-Path $steamApps "common\Sandustry")
}

function Add-SteamCandidates($steamRoot) {
    if ([string]::IsNullOrWhiteSpace($steamRoot)) { return }
    Add-SteamLibraryCandidate $steamRoot
    $libraryFile = Join-Path $steamRoot "steamapps\libraryfolders.vdf"
    if (-not (Test-Path -LiteralPath $libraryFile -PathType Leaf)) { return }
    foreach ($line in Get-Content -LiteralPath $libraryFile -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*"path"\s+"(.+?)"') {
            $libraryRoot = $Matches[1] -replace '\\\\', '\'
            Add-SteamLibraryCandidate $libraryRoot
        }
    }
}

function Add-MicrosoftCandidates($registryRoot) {
    if (-not (Test-Path -LiteralPath $registryRoot)) { return }
    foreach ($applicationKey in Get-ChildItem -LiteralPath $registryRoot -Recurse -ErrorAction SilentlyContinue) {
        try {
            $application = Get-ItemProperty -LiteralPath $applicationKey.PSPath -ErrorAction Stop
            $identity = @($applicationKey.PSChildName, $application.DisplayName, $application.Name,
                $application.PackageName, $application.PackageFullName, $application.PackageFamilyName,
                $application.ProductId, $application.StoreId, $application.XboxProductId,
                $application.Executable) -join " "
            if ($identity -notmatch '(?i)Sandustry' -and $identity -notmatch [regex]::Escape($sandustryStoreProductId)) { continue }
            foreach ($propertyName in @("InstallLocation", "InstallPath", "PackageRootFolder",
                "MutableLocation", "Root", "Path", "Executable")) {
                $candidate = $application.$propertyName
                if (-not $candidate -or $candidate -isnot [string]) { continue }
                Add-InstallCandidate $candidate
                Add-InstallCandidate (Join-Path $candidate "Content")
            }
        } catch {}
    }
}

foreach ($entry in @(
    @{ Path = "HKCU:\Software\Valve\Steam"; Name = "SteamPath" },
    @{ Path = "HKCU:\Software\Valve\Steam"; Name = "InstallPath" },
    @{ Path = "HKLM:\SOFTWARE\Valve\Steam"; Name = "InstallPath" },
    @{ Path = "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam"; Name = "InstallPath" }
)) {
    try { Add-SteamCandidates (Get-ItemPropertyValue -LiteralPath $entry.Path -Name $entry.Name -ErrorAction Stop) } catch {}
}

foreach ($steamAppKey in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App $sandustrySteamAppId",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App $sandustrySteamAppId",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App $sandustrySteamAppId"
)) {
    try { Add-InstallCandidate (Get-ItemPropertyValue -LiteralPath $steamAppKey -Name "InstallLocation" -ErrorAction Stop) } catch {}
}

foreach ($root in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($applicationKey in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
        try {
            $application = Get-ItemProperty -LiteralPath $applicationKey.PSPath -ErrorAction Stop
            if ($application.DisplayName -notlike "*Sandustry*") { continue }
            Add-InstallCandidate $application.InstallLocation
            if ($application.DisplayIcon) { Add-InstallCandidate (($application.DisplayIcon -split ',')[0]) }
        } catch {}
    }
}

foreach ($root in @(
    "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Applications",
    "HKLM:\SOFTWARE\Microsoft\GamingServices\PackageRepository\Root",
    "HKLM:\SOFTWARE\Microsoft\GamingServices\GameConfig"
)) { Add-MicrosoftCandidates $root }

foreach ($appPathKey in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Sandustry.exe",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Sandustry.exe",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Sandustry.exe"
)) {
    try { Add-InstallCandidate ((Get-Item -LiteralPath $appPathKey -ErrorAction Stop).GetValue("")) } catch {}
}

$gamePath = $null
$checkedPaths = @($candidatePaths | Sort-Object -Unique)
foreach ($candidate in $checkedPaths) {
    if ((Test-Path -LiteralPath (Join-Path $candidate "Sandustry.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $candidate "resources") -PathType Container)) {
        $gamePath = $candidate
        break
    }
}
if (-not $gamePath) {
    Write-Host "Game not found automatically. Registry candidates checked:" -ForegroundColor Yellow
    if ($checkedPaths.Count) { $checkedPaths | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host "  (none)" }
    $gamePath = Read-Host "Enter the Sandustry folder path (the one with Sandustry.exe and resources)"
    if (-not (Test-Path -LiteralPath (Join-Path $gamePath "Sandustry.exe") -PathType Leaf)) { Fail "No Sandustry.exe in '$gamePath'" }
    if (-not (Test-Path -LiteralPath (Join-Path $gamePath "resources") -PathType Container)) { Fail "No resources folder in '$gamePath'" }
}
Write-Host "Game: $gamePath" -ForegroundColor Green

# --- 2. Close the game ------------------------------------------------------
Get-Process Sandustry -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$res = "$gamePath\resources"

# --- 3. Extract app.asar (pure PowerShell asar reader) ----------------------
function Extract-Asar($asarPath, $outDir, $unpackedDir) {
    Write-Host "Unpacking game code (1-2 minutes)..." -ForegroundColor Yellow
    $bytes = [System.IO.File]::ReadAllBytes($asarPath)
    $headerSize = [System.BitConverter]::ToUInt32($bytes, 4)
    $jsonLen = [System.BitConverter]::ToUInt32($bytes, 12)
    $json = [System.Text.Encoding]::UTF8.GetString($bytes, 16, $jsonLen)
    $index = $json | ConvertFrom-Json
    $base = 8 + $headerSize
    $script:extracted = 0

    function Walk($node, $rel) {
        foreach ($prop in $node.files.PSObject.Properties) {
            $name = $prop.Name
            $child = $prop.Value
            $childRel = if ($rel) { "$rel\$name" } else { $name }
            if ($child.PSObject.Properties['files']) {
                $dir = Join-Path $outDir $childRel
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                Walk $child $childRel
            } else {
                $dest = Join-Path $outDir $childRel
                $destDir = Split-Path $dest -Parent
                if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
                if ($child.PSObject.Properties['unpacked'] -and $child.unpacked) {
                    $src = Join-Path $unpackedDir $childRel
                    if (Test-Path $src) { Copy-Item $src $dest -Force }
                } else {
                    $off = $base + [int64]$child.offset
                    $size = [int]$child.size
                    $fs = [System.IO.File]::Open($dest, 'Create', 'Write')
                    $fs.Write($bytes, $off, $size)
                    $fs.Close()
                }
                $script:extracted++
                if ($script:extracted % 200 -eq 0) { Write-Host "  ... $script:extracted files" }
            }
        }
    }
    Walk $index ""
    Write-Host "Unpacked $script:extracted files." -ForegroundColor Green
}

# Microsoft Store product 9PPH71DV44T7 is Sandustry. The 9MWPM2CQNLHN link in
# the base game points to the Gaming Services dependency, not the game install.
# app.asar PRESENT = the platform installed or restored it after a fresh install, update, or file verification.
# In both cases re-extract fresh so the unpacked "app" folder matches the CURRENT game build,
# then sideline app.asar so the game loads our patched folder (not the untouched asar).
# This also handles a game platform restoring app.asar and causing an unmodified launch.
if (Test-Path "$res\app.asar") {
    if (Test-Path "$res\app") { Write-Host "The game platform replaced app.asar - re-extracting the current build..." -ForegroundColor Yellow; Remove-Item "$res\app" -Recurse -Force }
    Extract-Asar "$res\app.asar" "$res\app" "$res\app.asar.unpacked"
    if (Test-Path "$res\app.asar.bak") { Remove-Item "$res\app.asar.bak" -Force }
    Rename-Item "$res\app.asar" "app.asar.bak"
} elseif (-not (Test-Path "$res\app\main.js")) {
    # no live app.asar and no unpacked folder -> fall back to our backup
    if (Test-Path "$res\app.asar.bak") { Extract-Asar "$res\app.asar.bak" "$res\app" "$res\app.asar.unpacked" }
    else { Fail "app.asar not found in $res (repair or verify the game installation first)" }
}

# --- 4. Version check -------------------------------------------------------
$patches = Get-Content "$PSScriptRoot\src\patches.json" -Raw -Encoding UTF8 | ConvertFrom-Json
try {
    $gv = (Get-Content "$res\app\package.json" -Raw | ConvertFrom-Json).version
    Write-Host "Game build: $gv (mod supports: $($patches.supportedVersions -join ', '))"
} catch {}

# --- 5. Copy mod files ------------------------------------------------------
$rendererFiles = @(
    "localisation.js",
    "state.js",
    "network.js",
    "menu.js",
    "sandustrymp.js"
)
foreach ($rendererFile in $rendererFiles) {
    Copy-Item "$PSScriptRoot\src\$rendererFile" "$res\app\dist\js\$rendererFile" -Force
}
Copy-Item "$PSScriptRoot\src\smp-main.js" "$res\app\smp-main.js" -Force
Write-Host "[+] mod files copied"

# --- 6. index.html ----------------------------------------------------------
$p = "$res\app\dist\index.html"
$s = [System.IO.File]::ReadAllText($p)
$bundleTag = '<script type="module" src="js/bundle.js"></script>'
if (-not $s.Contains($bundleTag)) { Fail "index.html anchor not found" }
foreach ($rendererFile in $rendererFiles) {
    $escapedFile = [Regex]::Escape($rendererFile)
    $s = [Regex]::Replace($s, "(?m)^\s*<script src=[`"']js/$escapedFile[`"']></script>\s*\r?\n?", "")
}
$rendererTags = ($rendererFiles | ForEach-Object { "    <script src=""js/$_""></script>" }) -join "`r`n"
$s = $s.Replace($bundleTag, "$rendererTags`r`n    $bundleTag")
[System.IO.File]::WriteAllText($p, $s)
Write-Host "[+] index.html"

# --- 7. preload.js ----------------------------------------------------------
$p = "$res\app\preload.js"
$s = [System.IO.File]::ReadAllText($p)
if ($s.Contains("sandustrympNet")) { Write-Host "[=] preload.js (already patched)" }
else {
    $s += "`n" + [System.IO.File]::ReadAllText("$PSScriptRoot\src\smp-preload-append.js")
    [System.IO.File]::WriteAllText($p, $s)
    Write-Host "[+] preload.js"
}

# --- 8. main.js -------------------------------------------------------------
$p = "$res\app\main.js"
$s = [System.IO.File]::ReadAllText($p)
$USERDATA_MARK_A = "// --- SandustryMP early userData override ---"
$USERDATA_MARK_B = "// --- /SandustryMP early userData override ---"
$existingUserDataStart = $s.IndexOf($USERDATA_MARK_A)
if ($existingUserDataStart -ge 0) {
    $existingUserDataEnd = $s.IndexOf($USERDATA_MARK_B, $existingUserDataStart)
    if ($existingUserDataEnd -lt 0) { Fail "main.js has an incomplete early userData block" }
    $s = $s.Substring(0, $existingUserDataStart) + $s.Substring($existingUserDataEnd + $USERDATA_MARK_B.Length).TrimStart()
}
$userDataAnchor = "const path = require('node:path')"
if (-not $s.Contains($userDataAnchor)) { Fail "main.js early userData anchor not found" }
$userDataBlock = @"
$USERDATA_MARK_A
try {
  const smpUserDataPrefix = '--smp-userdata=';
  const smpUserDataArgument = process.argv.find((argument) => argument.startsWith(smpUserDataPrefix));
  if (smpUserDataArgument) {
    const smpUserDataPath = smpUserDataArgument.slice(smpUserDataPrefix.length);
    if (smpUserDataPath) app.setPath('userData', smpUserDataPath);
  }
} catch (e) { console.error('[SandustryMP] early userdata error:', e); }
$USERDATA_MARK_B

"@
$s = $s.Replace($userDataAnchor, $userDataBlock + $userDataAnchor)
Write-Host "[+] main.js earliest userData override"
$MARK_A = "// --- SandustryMP init ---"
$MARK_B = "// --- /SandustryMP init ---"
$block = @"


$MARK_A
try {
  app.whenReady().then(() => {
    try { require('./smp-main.js').init({ getMainWindow: () => mainWindow }); }
    catch (e) { console.error('[SandustryMP] init error:', e); }
  });
} catch (e) { console.error('[SandustryMP] bootstrap error:', e); }
$MARK_B
"@
$ia = $s.IndexOf($MARK_A)
if ($ia -ge 0) { $ib = $s.IndexOf($MARK_B); $s = $s.Substring(0, $ia).TrimEnd() + $s.Substring($ib + $MARK_B.Length) }
$s += $block
$anchor = $patches.mainJs.singleInstanceAnchor
if ($s.Contains($anchor)) { $s = $s.Replace($anchor, $patches.mainJs.singleInstancePatched) }
[System.IO.File]::WriteAllText($p, $s)
Write-Host "[+] main.js"

# --- 9. bundle.js anchor patches (multi-version: tries each variant) --------
$p = "$res\app\dist\js\bundle.js"
$s = [System.IO.File]::ReadAllText($p)
$dirty = $false
$criticalFail = $false
$featureMiss = 0
foreach ($pt in $patches.bundle) {
    $applied = $false
    $already = $false
    foreach ($v in $pt.variants) {
        if ($s.IndexOf($v.patched, [System.StringComparison]::Ordinal) -ge 0) { $already = $true; break }
        $i1 = $s.IndexOf($v.anchor, [System.StringComparison]::Ordinal)
        if ($i1 -lt 0) { continue }
        $i2 = $s.IndexOf($v.anchor, $i1 + 1, [System.StringComparison]::Ordinal)
        if ($i2 -ge 0) { continue }  # not unique in this variant, try next
        $s = $s.Substring(0, $i1) + $v.patched + $s.Substring($i1 + $v.anchor.Length)
        $dirty = $true; $applied = $true
        break
    }
    if ($applied) { Write-Host "[+] bundle: $($pt.name)" }
    elseif ($already) { Write-Host "[=] bundle: $($pt.name) (already patched)" }
    else {
        if ($pt.critical) { Write-Host "[X] bundle: $($pt.name) - NO MATCHING VARIANT (critical)" -ForegroundColor Red; $criticalFail = $true }
        else { Write-Host "[!] bundle: $($pt.name) - not found, feature disabled on this build" -ForegroundColor Yellow; $featureMiss++ }
    }
}
if ($dirty) { [System.IO.File]::WriteAllText($p, $s) }
if ($criticalFail) {
    Fail "This game version is NOT supported by the mod yet (core hook didn't match). Supported: $($patches.supportedVersions -join ', '). Your game may have auto-updated to a newer build. Watch the Workshop page for an update, or opt into a supported version via Steam betas."
}
if ($featureMiss -gt 0) { Write-Host "Note: $featureMiss optional feature(s) not available on this game build, but co-op will work." -ForegroundColor Yellow }

# --- 10. simulation-worker.js deterministic RNG bootstrap ------------------
$p = "$res\app\dist\js\simulation-worker.js"
if (-not (Test-Path -LiteralPath $p)) { Fail "simulation-worker.js not found" }
$worker = [System.IO.File]::ReadAllText($p)
$markA = "// --- SandustryMP deterministic simulation RNG ---"
$markB = "// --- /SandustryMP deterministic simulation RNG ---"
$start = $worker.IndexOf($markA, [System.StringComparison]::Ordinal)
if ($start -ge 0) {
    $end = $worker.IndexOf($markB, $start, [System.StringComparison]::Ordinal)
    if ($end -lt 0) { Fail "simulation-worker.js has an incomplete SandustryMP RNG block" }
    $worker = ($worker.Substring(0, $start) + $worker.Substring($end + $markB.Length)).TrimStart()
}
$bootstrap = [System.IO.File]::ReadAllText("$PSScriptRoot\src\sim-worker-bootstrap.js").TrimEnd()
[System.IO.File]::WriteAllText($p, $bootstrap + "`n" + $worker)
Write-Host "[+] simulation-worker.js deterministic RNG bootstrap"

Write-Host ""
Write-Host "=== DONE! SandustryMP installed. ===" -ForegroundColor Green
Write-Host "Launch Sandustry from Steam. The SandustryMP panel appears top-right (click its header or Ctrl+Shift+H to hide)."
Write-Host "TIP: if Steam keeps updating the game and reverting the mod, set Steam -> Sandustry -> Properties -> Updates -> 'Only update on launch', and launch via SandustryMP-START.bat."
Write-Host "Uninstall: repair or verify Sandustry through its installer, then delete resources\app if it remains."
if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" }
