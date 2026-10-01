# Read-only, local metadata only. No elevation, install, config/auth reads or Codex launch.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$probe = [ordered]@{
    version = 'ANALYSIS_ISOLATION_HOST_V1'
    capturedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    platform = 'win32'
    os = [ordered]@{ editionId = $null; build = $null; is64Bit = [Environment]::Is64BitOperatingSystem }
    elevated = $null
    hardware = [ordered]@{ logicalProcessors = $null; memoryMiB = $null; hypervisorPresent = $null; virtualizationFirmwareEnabled = $null; slat = $null }
    executables = [ordered]@{ windowsSandbox = $null; wsl = $null; codexOnPath = $null }
    features = [ordered]@{}
    unavailable = [System.Collections.Generic.List[string]]::new()
}
try {
    $version = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID,CurrentBuildNumber -ErrorAction Stop
    $probe.os.editionId = [string]$version.EditionID
    $probe.os.build = [int]$version.CurrentBuildNumber
} catch { $probe.unavailable.Add('OS_QUERY_UNAVAILABLE') }
try {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $probe.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $probe.unavailable.Add('TOKEN_QUERY_UNAVAILABLE') }
try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem -Property HypervisorPresent,TotalPhysicalMemory -OperationTimeoutSec 3 -ErrorAction Stop
    $probe.hardware.hypervisorPresent = $computer.HypervisorPresent
    if ($null -ne $computer.TotalPhysicalMemory) { $probe.hardware.memoryMiB = [int][Math]::Floor($computer.TotalPhysicalMemory / 1MB) }
} catch { $probe.unavailable.Add('COMPUTER_QUERY_UNAVAILABLE') }
try {
    $processors = @(Get-CimInstance -ClassName Win32_Processor -Property NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions -OperationTimeoutSec 3 -ErrorAction Stop)
    if ($processors.Count -eq 0) { throw 'NO_PROCESSOR' }
    $probe.hardware.logicalProcessors = [int](($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
    if (@($processors | Where-Object { $null -eq $_.VirtualizationFirmwareEnabled }).Count -eq 0) {
        $probe.hardware.virtualizationFirmwareEnabled = @($processors | Where-Object { -not $_.VirtualizationFirmwareEnabled }).Count -eq 0
    }
    if (@($processors | Where-Object { $null -eq $_.SecondLevelAddressTranslationExtensions }).Count -eq 0) {
        $probe.hardware.slat = @($processors | Where-Object { -not $_.SecondLevelAddressTranslationExtensions }).Count -eq 0
    }
} catch { $probe.unavailable.Add('PROCESSOR_QUERY_UNAVAILABLE') }
try {
    $systemDirectory = [Environment]::SystemDirectory
    $probe.executables.windowsSandbox = Test-Path -LiteralPath (Join-Path $systemDirectory 'WindowsSandbox.exe') -PathType Leaf
    $probe.executables.wsl = Test-Path -LiteralPath (Join-Path $systemDirectory 'wsl.exe') -PathType Leaf
    # Metadata lookup only. Never invoke the found executable or report its user path.
    $probe.executables.codexOnPath = [bool](Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue)
} catch { $probe.unavailable.Add('EXECUTABLE_QUERY_UNAVAILABLE') }
$featureNames = [ordered]@{
    windowsSandbox = 'Containers-DisposableClientVM'
    hyperV = 'Microsoft-Hyper-V-All'
    virtualMachinePlatform = 'VirtualMachinePlatform'
    wsl = 'Microsoft-Windows-Subsystem-Linux'
}
foreach ($key in $featureNames.Keys) {
    $probe.features[$key] = 'UNKNOWN'
    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureNames[$key] -ErrorAction Stop
        $state = [string]$feature.State
        if (@('Enabled', 'Disabled', 'EnablePending', 'DisablePending', 'DisabledWithPayloadRemoved') -contains $state) {
            $probe.features[$key] = $state
        } else { $probe.unavailable.Add('FEATURE_QUERY_UNAVAILABLE') }
    } catch { $probe.unavailable.Add('FEATURE_QUERY_UNAVAILABLE') }
}
$probe.unavailable = @($probe.unavailable | Sort-Object -Unique)
$probe | ConvertTo-Json -Depth 5 -Compress
