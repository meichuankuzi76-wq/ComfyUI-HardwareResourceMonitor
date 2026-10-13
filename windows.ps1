$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$folder = Join-Path $PSScriptRoot 'lib/windows'
try {
    foreach ($file in @('HidSharp.dll','LibreHardwareMonitorLib.dll')) {
        [void][Reflection.Assembly]::LoadFrom((Join-Path $folder $file))
    }
    $computer = New-Object LibreHardwareMonitor.Hardware.Computer
    $computer.IsGpuEnabled = $true
    $computer.Open()
    while ($true) {
        $devices = @()
        foreach ($hardware in $computer.Hardware) {
            $hardware.Update()
            $sensors = @($hardware.Sensors | ForEach-Object {
                @{ name=$_.Name; kind=$_.SensorType.ToString(); value=$_.Value }
            })
            $devices += @{id=$hardware.Identifier.ToString(); name=$hardware.Name; kind=$hardware.HardwareType.ToString(); sensors=$sensors}
        }
        @{devices=$devices; error=$null} | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::WriteLine($_) }
        Start-Sleep -Milliseconds 1000
    }
} catch {
    $message = $_.Exception.Message
    $devices = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{name=$_.Name; kind='Unknown'; sensors=@()} })
    @{devices=$devices; error=$message} | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::WriteLine($_) }
}
