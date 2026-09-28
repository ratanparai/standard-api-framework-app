[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Resolve-ApplicationPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($null -ne $command) {
        return $command.Source
    }

    return $null
}

function Test-PerlModule {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PerlPath
    )

    try {
        & $PerlPath '-MLocale::Maketext::Simple' '-e' 'exit 0' *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Find-PerlWithLocaleModule {
    $candidates = [System.Collections.Generic.List[string]]::new()

    $pathPerl = Resolve-ApplicationPath -Name 'perl.exe'
    if (-not [string]::IsNullOrWhiteSpace($pathPerl)) {
        $candidates.Add($pathPerl)
    }

    foreach ($commonPath in @(
        'C:\Strawberry\perl\bin\perl.exe',
        'D:\Strawberry\perl\bin\perl.exe'
    )) {
        if (-not $candidates.Contains($commonPath)) {
            $candidates.Add($commonPath)
        }
    }

    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-PerlModule -PerlPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Find-VsWhere {
    $candidates = [System.Collections.Generic.List[string]]::new()

    $pathVsWhere = Resolve-ApplicationPath -Name 'vswhere.exe'
    if (-not [string]::IsNullOrWhiteSpace($pathVsWhere)) {
        $candidates.Add($pathVsWhere)
    }

    foreach ($programFiles in @(
        ${env:ProgramFiles(x86)},
        $env:ProgramFiles,
        $env:ProgramW6432
    )) {
        if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
            $candidate = Join-Path $programFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
            if (-not $candidates.Contains($candidate)) {
                $candidates.Add($candidate)
            }
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Get-VsInstallationPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VsWherePath
    )

    $output = & $VsWherePath `
        '-latest' `
        '-products' '*' `
        '-requires' 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' `
        '-property' 'installationPath' 2>$null

    if (($LASTEXITCODE -ne 0) -or ($null -eq $output)) {
        return $null
    }

    $installationPath = $output |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
        Select-Object -First 1

    if ($null -eq $installationPath) {
        return $null
    }

    $installationPath = ([string]$installationPath).Trim()
    if ([string]::IsNullOrWhiteSpace($installationPath)) {
        return $null
    }

    return $installationPath
}

$scriptDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
    $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDirectory '..')).Path

if ($env:OS -ne 'Windows_NT') {
    throw 'This script requires Windows because it bootstraps the Visual Studio C++ toolchain.'
}

$nodePath = Resolve-ApplicationPath -Name 'node.exe'
if ([string]::IsNullOrWhiteSpace($nodePath)) {
    throw 'Node.js was not found on PATH. Install the Node.js LTS release, then run this script again.'
}

& $nodePath '--version' *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Node.js was found at '$nodePath' but could not be executed. Repair the Node.js installation, then run this script again."
}

$npmPath = Resolve-ApplicationPath -Name 'npm.cmd'
if ([string]::IsNullOrWhiteSpace($npmPath)) {
    throw 'npm.cmd was not found on PATH. Install Node.js with npm, then run this script again.'
}

& $npmPath '--version' *> $null
if ($LASTEXITCODE -ne 0) {
    throw "npm.cmd was found at '$npmPath' but could not be executed. Repair the Node.js installation, then run this script again."
}

$nodeModulesPath = Join-Path $repoRoot 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
    throw "The node_modules directory is missing at '$nodeModulesPath'. Run 'npm install' from the repository root first."
}

$tauriCliPath = Join-Path $nodeModulesPath '@tauri-apps\cli'
if (-not (Test-Path -LiteralPath $tauriCliPath -PathType Container)) {
    throw "The Tauri CLI is missing at '$tauriCliPath'. Run 'npm install' from the repository root first."
}

$perlPath = Find-PerlWithLocaleModule
if ([string]::IsNullOrWhiteSpace($perlPath)) {
    throw 'A Perl installation with Locale::Maketext::Simple was not found. Install Strawberry Perl (for example in C:\Strawberry or D:\Strawberry), add it to PATH, and run this script again.'
}

$vsWherePath = Find-VsWhere
if ([string]::IsNullOrWhiteSpace($vsWherePath)) {
    throw 'vswhere.exe was not found. Install Visual Studio Build Tools with the Desktop development with C++ workload, then run this script again.'
}

$vsInstallationPath = Get-VsInstallationPath -VsWherePath $vsWherePath
if ([string]::IsNullOrWhiteSpace($vsInstallationPath)) {
    throw 'Visual Studio with the Microsoft.VisualStudio.Component.VC.Tools.x86.x64 component was not found. Install the Visual Studio Build Tools C++ workload, then run this script again.'
}

$vsDevCmdPath = Join-Path $vsInstallationPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmdPath -PathType Leaf)) {
    throw "VsDevCmd.bat was not found at '$vsDevCmdPath'. Repair the Visual Studio Build Tools installation and run this script again."
}

$commandShell = if (-not [string]::IsNullOrWhiteSpace($env:ComSpec)) {
    $env:ComSpec
}
else {
    Join-Path $env:SystemRoot 'System32\cmd.exe'
}

if (-not (Test-Path -LiteralPath $commandShell -PathType Leaf)) {
    throw "The Windows command shell was not found at '$commandShell'."
}

$perlDirectory = Split-Path -Parent $perlPath
$executablePath = Join-Path $repoRoot 'src-tauri\target\release\standard-api-framework-app.exe'

Write-Host "[INFO] Repository: $repoRoot"
Write-Host "[INFO] Node.js: $nodePath"
Write-Host "[INFO] Perl: $perlPath"
Write-Host "[INFO] Visual Studio: $vsInstallationPath"
Write-Host '[INFO] Building the Windows executable without bundling or signing...'

# Run the whole build in one child cmd.exe so the Visual Studio and CMake
# environment changes cannot leak into the caller's PowerShell session.
$buildCommand = 'call "' + $vsDevCmdPath + '" -arch=x64 -host_arch=x64 -no_logo' +
    ' && set "PATH=' + $perlDirectory + ';!PATH!"' +
    ' && set "CMAKE_POLICY_VERSION_MINIMUM=3.5"' +
    ' && set "CMAKE_GENERATOR=NMake Makefiles"' +
    ' && call "' + $npmPath + '" run tauri -- build --no-bundle'

Push-Location -LiteralPath $repoRoot
try {
    & $commandShell '/d' '/v:on' '/s' '/c' $buildCommand
    $buildExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($buildExitCode -ne 0) {
    throw "Tauri build failed with exit code $buildExitCode."
}

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "The build completed without producing the expected executable at '$executablePath'."
}

Write-Host "[OK] Windows executable created: $executablePath"
