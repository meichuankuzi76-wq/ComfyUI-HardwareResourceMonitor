using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using LibreHardwareMonitor.Hardware;

class HardwareSensors {
    static string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
    static JavaScriptSerializer Json = new JavaScriptSerializer();
    static object Value(object obj, string name) {
        PropertyInfo property = obj.GetType().GetProperty(name);
        return property == null ? null : property.GetValue(obj, null);
    }
    static List<Dictionary<string,object>> Disks() {
        var result = new List<Dictionary<string,object>>();
        using (var search = new ManagementObjectSearcher("SELECT Index,Model FROM Win32_DiskDrive")) {
            foreach (ManagementObject disk in search.Get()) result.Add(new Dictionary<string,object> {
                {"id", "PhysicalDrive" + disk["Index"]}, {"index", Convert.ToInt32(disk["Index"])}, {"name", Convert.ToString(disk["Model"]).Trim()}
            });
        }
        return result;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int inputSize,byte[] output,int outputSize,out int returned,IntPtr overlapped);
    static object DiskTemperature(string id) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id,"^PhysicalDrive[0-9]+$")) return null;
        using (SafeFileHandle h=CreateFile(new string((char)92,2)+"."+(char)92+id,0,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
            if(h.IsInvalid) return new {id=id,value=(object)null,error=Marshal.GetLastWin32Error()};
            byte[] query=new byte[12];Array.Copy(BitConverter.GetBytes(52),query,4);
            byte[] output=new byte[4096];int returned;
            if(DeviceIoControl(h,0x2d1400,query,query.Length,output,output.Length,out returned,IntPtr.Zero) && returned>=40 && BitConverter.ToUInt16(output,12)>0) {
                short temperature=BitConverter.ToInt16(output,26);
                if(temperature>=-40 && temperature<=150)return new {id=id,value=(object)temperature,error=0};
            }
            return new {id=id,value=(object)null,error=Marshal.GetLastWin32Error()};
        }
    }
    static object MemoryInfo() {
        var speeds=new List<int>();var rated=new List<int>();var modules=new List<object>();
        try {using(var query=new ManagementObjectSearcher("SELECT Manufacturer,PartNumber,ConfiguredClockSpeed,Speed FROM Win32_PhysicalMemory"))foreach(ManagementObject memory in query.Get()){int speed=Convert.ToInt32(memory["ConfiguredClockSpeed"]);if(speed>0)speeds.Add(speed);int maximum=Convert.ToInt32(memory["Speed"]);if(maximum>0)rated.Add(maximum);modules.Add(new {manufacturer=Convert.ToString(memory["Manufacturer"]).Trim(),part_number=Convert.ToString(memory["PartNumber"]).Trim(),configured_mhz=speed,firmware_rated_mhz=maximum});}}catch{}
        return new {modules=modules,configured_speeds_mhz=speeds,rated_speeds_mhz=rated,rated_max_mhz=rated.Count>0?(object)System.Linq.Enumerable.Min(rated):null,source="SMBIOS ConfiguredClockSpeed"};
    }
    static void UpdateHardware(IHardware hardware) {
        hardware.Update();foreach(IHardware child in hardware.SubHardware)UpdateHardware(child);
    }
    static IEnumerable<ISensor> AllSensors(IHardware hardware) {
        foreach(ISensor sensor in hardware.Sensors)yield return sensor;
        foreach(IHardware child in hardware.SubHardware)foreach(ISensor sensor in AllSensors(child))yield return sensor;
    }
    static void Run() {
        var computer = new Computer { IsCpuEnabled = false, IsGpuEnabled = true, IsStorageEnabled = true, IsPsuEnabled = false, IsPowerMonitorEnabled = false };
        computer.Open();
        var disks = Disks();
        var memoryInfo = MemoryInfo();
        System.Diagnostics.PerformanceCounter cpuCounter=null;double baseMhz=0;
        try {using(var key=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0"))baseMhz=Convert.ToDouble(key.GetValue("~MHz"));cpuCounter=new System.Diagnostics.PerformanceCounter("Processor Information","% Processor Performance","_Total",true);cpuCounter.NextValue();}catch{cpuCounter=null;}
        var names = new List<Dictionary<string,object>>();
        foreach (IHardware h in computer.Hardware) names.Add(new Dictionary<string,object>{{"id",h.Identifier.ToString()},{"name",h.Name},{"kind",h.HardwareType.ToString()}});
        string line;
        while ((line=Console.ReadLine()) != null) {
            try {
                var request = Json.Deserialize<Dictionary<string,object>>(line);
                string diskId = request.ContainsKey("disk") ? Convert.ToString(request["disk"]) : "";
                string gpuName = request.ContainsKey("gpu") ? Convert.ToString(request["gpu"]) : "";
                var devices = new List<Dictionary<string,object>>();
                foreach (IHardware hardware in computer.Hardware) {
                    string kind = hardware.HardwareType.ToString();
                    string mappedDisk = "";
                    if (kind == "Storage") {
                        object index = Value(hardware,"Index");
                        if (index != null) mappedDisk = "PhysicalDrive" + index;
                        else {
                            var matches = disks.FindAll(d=>String.Equals(Convert.ToString(d["name"]),hardware.Name.Trim(),StringComparison.OrdinalIgnoreCase));
                            if (matches.Count == 1) mappedDisk=Convert.ToString(matches[0]["id"]);
                        }
                        if (mappedDisk != diskId) continue;
                    }
                    if (kind.StartsWith("Gpu") && gpuName != "" && !String.Equals(hardware.Name,gpuName,StringComparison.OrdinalIgnoreCase)) continue;
                    UpdateHardware(hardware);
                    var sensors = new List<Dictionary<string,object>>();
                    foreach (ISensor sensor in AllSensors(hardware)) sensors.Add(new Dictionary<string,object>{
                        {"name",sensor.Name},{"kind",sensor.SensorType.ToString()},
                        {"value",sensor.Value.HasValue && !Single.IsNaN(sensor.Value.Value) && !Single.IsInfinity(sensor.Value.Value) ? (object)sensor.Value.Value : null}
                    });
                    devices.Add(new Dictionary<string,object>{{"id",hardware.Identifier.ToString()},{"name",hardware.Name},{"kind",kind},{"disk_id",mappedDisk},{"sensors",sensors}});
                }
                object cpuFrequency=null;
                if(cpuCounter!=null)try{double value=cpuCounter.NextValue()*baseMhz/100;if(value>0 && value<15000)cpuFrequency=value;}catch{}
                Console.WriteLine(Json.Serialize(new {cpu_frequency_mhz=cpuFrequency,devices=devices,inventory=names,disks=disks,disk_temperature=DiskTemperature(diskId),memory_info=memoryInfo,error=(string)null}));
            } catch (Exception e) { Console.WriteLine(Json.Serialize(new {error=e.Message})); }
        }
        if(cpuCounter!=null)cpuCounter.Dispose();
        computer.Close();
    }
    public static void Main() {
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        AppDomain.CurrentDomain.AssemblyResolve += (sender,args) => {
            string path=Path.Combine(Root,"lib","windows",new AssemblyName(args.Name).Name+".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
        try { Run(); } catch(Exception e) { Console.WriteLine(Json.Serialize(new {error=e.ToString()})); }
    }
}
