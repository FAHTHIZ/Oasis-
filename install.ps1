# OASIS installer for Windows (PowerShell 5.1 or newer).
#
#   irm https://raw.githubusercontent.com/FAHTHIZ/Oasis-/main/install.ps1 | iex
#
# Options are environment variables, set before running:
#   $env:OASIS_WITH_TOOLS = "1"   also install language servers (TypeScript, Python, Bash, YAML, JSON/HTML/CSS)
#   $env:OASIS_BRANCH     = "main" branch or tag to install
#   $env:OASIS_HOME       = "$HOME\.oasis"
#   $env:OASIS_UNINSTALL  = "1"   remove the app, private Node.js, tools and the `oasis` command (keeps settings)
#
# Running it again updates an existing install. No administrator rights needed.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoUrl = if ($env:OASIS_REPO) { $env:OASIS_REPO } else { "https://github.com/FAHTHIZ/Oasis-.git" }
$Branch = if ($env:OASIS_BRANCH) { $env:OASIS_BRANCH } else { "main" }
$OasisHome = if ($env:OASIS_HOME) { $env:OASIS_HOME } else { Join-Path $HOME ".oasis" }
$NodeVersion = if ($env:OASIS_NODE_VERSION) { $env:OASIS_NODE_VERSION } else { "22.21.1" }
$AppDir = Join-Path $OasisHome "app"
$NodeDir = Join-Path $OasisHome "node"
$ToolsDir = Join-Path $OasisHome "tools"
$BinDir = Join-Path $OasisHome "bin"

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
# throw, not exit: under `irm | iex` an exit would close the user's PowerShell window.
function Die($m) { throw "OASIS install failed: $m" }

if ($env:OASIS_UNINSTALL -eq "1") {
	foreach ($d in @($AppDir, $NodeDir, $ToolsDir, $BinDir)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
	Say "Removed OASIS. Settings, logins and sessions in $OasisHome\agent were kept."
	return
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
	Die "git is missing. Install it with: winget install --id Git.Git -e   then open a new PowerShell and re-run."
}

function Test-NodeOk($node) {
	try {
		$v = (& $node -p "process.versions.node") -split "\."
		return ([int]$v[0] -gt 22) -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 19)
	} catch { return $false }
}

$NodeExe = $null
$private = Join-Path $NodeDir "node.exe"
if ((Test-Path $private) -and (Test-NodeOk $private)) {
	$NodeExe = $private
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-NodeOk "node")) {
	$NodeExe = (Get-Command node).Source
} else {
	$arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" } } else { Die "32-bit Windows is not supported" }
	$name = "node-v$NodeVersion-win-$arch"
	Say "Installing Node.js $NodeVersion for OASIS (private copy in $NodeDir)"
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oasis-" + [Guid]::NewGuid())
	New-Item -ItemType Directory -Path $tmp | Out-Null
	$zip = Join-Path $tmp "node.zip"
	Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$name.zip" -OutFile $zip -UseBasicParsing
	$sums = (Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
	$expected = ($sums -split "`n" | Where-Object { $_ -match " $name\.zip$" } | ForEach-Object { ($_ -split "\s+")[0] })
	$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
	if (-not $expected -or $expected -ne $actual) { Die "Node.js download failed its checksum" }
	Expand-Archive $zip -DestinationPath $tmp -Force
	if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
	Move-Item (Join-Path $tmp $name) $NodeDir
	Remove-Item -Recurse -Force $tmp
	$NodeExe = $private
}
$NodeBinDir = Split-Path $NodeExe
$env:Path = "$NodeBinDir;$env:Path"
$Npm = Join-Path $NodeBinDir "npm.cmd"
if (-not (Test-Path $Npm)) { $Npm = "npm.cmd" }
Write-Host "    node $(& $NodeExe --version) at $NodeExe" -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $OasisHome | Out-Null
if (Test-Path (Join-Path $AppDir ".git")) {
	Say "Updating OASIS in $AppDir"
	git -C $AppDir fetch --quiet --depth 1 origin $Branch
	if (git -C $AppDir status --porcelain --untracked-files=no) { Die "$AppDir has local changes; move them aside and re-run" }
	git -C $AppDir checkout --quiet -B $Branch FETCH_HEAD
} else {
	Say "Downloading OASIS ($Branch)"
	if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
	git clone --quiet --depth 1 --branch $Branch $RepoUrl $AppDir
	if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
}

$log = Join-Path $OasisHome "install.log"
Say "Installing dependencies (this takes a minute)"
$ok = $false
for ($i = 1; $i -le 3 -and -not $ok; $i++) {
	Push-Location $AppDir
	& $Npm ci --no-audit --no-fund --loglevel=error *> $log
	$ok = $LASTEXITCODE -eq 0
	Pop-Location
	if (-not $ok -and $i -lt 3) { Write-Host "warning: npm ci failed (attempt $i of 3); retrying" -ForegroundColor Yellow }
}
if (-not $ok) { Get-Content $log -Tail 20; Die "npm ci failed; full log in $log" }
Say "Building"
Push-Location $AppDir
& $Npm run build --silent *> $log
$built = $LASTEXITCODE -eq 0
Pop-Location
if (-not $built) { Get-Content $log -Tail 20; Die "build failed; full log in $log" }

if ($env:OASIS_WITH_TOOLS -eq "1") {
	Say "Installing language servers into $ToolsDir"
	& $Npm install --prefix $ToolsDir --global --no-audit --no-fund --loglevel=error typescript typescript-language-server pyright bash-language-server yaml-language-server vscode-langservers-extracted *> $log
	if ($LASTEXITCODE -ne 0) { Write-Host "warning: some language servers failed to install; OASIS works without them" -ForegroundColor Yellow }
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$launcher = @"
@echo off
rem Generated by the OASIS installer. Re-run the installer or ``oasis update`` to update.
set "PATH=$ToolsDir;$NodeBinDir;%PATH%"
"$NodeExe" "$AppDir\bin\oasis.mjs" %*
"@
Set-Content -Path (Join-Path $BinDir "oasis.cmd") -Value $launcher -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $BinDir })) {
	[Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
	Write-Host "    added $BinDir to your user PATH" -ForegroundColor DarkGray
}
$env:Path = "$BinDir;$env:Path"

$version = & (Join-Path $BinDir "oasis.cmd") --version
if ($LASTEXITCODE -ne 0) { Die "installed, but 'oasis --version' failed" }
Write-Host ""
Write-Host "OASIS $version is installed." -ForegroundColor Green
Write-Host "Open a new terminal, then:"
Write-Host "  cd your-project; oasis        start, then type /login to pick a provider"
Write-Host "  oasis doctor                  check your setup"
Write-Host "  oasis update                  update later"
