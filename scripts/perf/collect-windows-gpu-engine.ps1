[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+(,\d+)*$')]
  [string]$ProcessIds,

  [Parameter(Mandatory = $true)]
  [ValidateRange(5, 300)]
  [int]$SampleCount
)

$ErrorActionPreference = 'Stop'
$targetProcessIds = @($ProcessIds.Split(',') | ForEach-Object { [int]$_ })
$devices = @(
  Get-CimInstance Win32_VideoController | ForEach-Object {
    [ordered]@{
      name = $_.Name
      vendor = $_.AdapterCompatibility
      pnpDeviceId = $_.PNPDeviceID
      driverVersion = $_.DriverVersion
      adapterRamBytes = if ($null -eq $_.AdapterRAM) { $null } else { [long]$_.AdapterRAM }
      status = $_.Status
    }
  }
)

try {
  $counterSets = @(
    Get-Counter '\GPU Engine(*)\Utilization Percentage' `
      -SampleInterval 1 `
      -MaxSamples $SampleCount
  )
  $samples = @(
    foreach ($counterSet in $counterSets) {
      foreach ($counterSample in $counterSet.CounterSamples) {
        if ($counterSample.InstanceName -notmatch '(?:^|_)pid_(\d+)(?:_|$)') {
          continue
        }
        $sampleProcessId = [int]$Matches[1]
        if ($sampleProcessId -notin $targetProcessIds) {
          continue
        }
        [ordered]@{
          timestamp = $counterSet.Timestamp.ToUniversalTime().ToString('o')
          pid = $sampleProcessId
          instanceName = $counterSample.InstanceName
          path = $counterSample.Path
          valuePercent = [double]$counterSample.CookedValue
        }
      }
    }
  )
  [ordered]@{
    available = $true
    error = $null
    devices = $devices
    samples = $samples
  } | ConvertTo-Json -Compress -Depth 5
} catch {
  [ordered]@{
    available = $false
    error = $_.Exception.Message
    devices = $devices
    samples = @()
  } | ConvertTo-Json -Compress -Depth 5
}
