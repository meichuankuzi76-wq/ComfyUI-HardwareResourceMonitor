# Windows 采集桥构建

发布包已包含编译后的采集器及其源码。重新构建需 Windows .NET Framework 4.x 编译器，在插件 sensors 目录执行：

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /out:HardwareSensors-v1110.exe /reference:System.Management.dll /reference:System.Web.Extensions.dll /reference:../lib/windows/LibreHardwareMonitorLib.dll HardwareSensors.cs
```

HardwareSensors-v1110.exe 是当前内部文件名，由 monitor.py 调用；不代表插件对外版本。构建不需要管理员权限。第三方 DLL 的来源与许可证见 README.md 和 lib/windows。
