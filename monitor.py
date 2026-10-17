import atexit
import ctypes
import json
import math
import os
import platform
import queue
import subprocess
import threading
import time
from pathlib import Path
import psutil

try:
    import pynvml
except ImportError:
    pynvml = None

ROOT = Path(__file__).resolve().parent
VERSION = '1.1'

if os.name == 'nt':
    import winreg
    from ctypes import wintypes
    class PerformanceInfo(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in (
            'CommitTotal','CommitLimit','CommitPeak','PhysicalTotal','PhysicalAvailable',
            'SystemCache','KernelTotal','KernelPaged','KernelNonpaged','PageSize')] + [
            ('HandleCount',wintypes.DWORD),('ProcessCount',wintypes.DWORD),('ThreadCount',wintypes.DWORD)]
    get_performance = ctypes.WinDLL('psapi', use_last_error=True).GetPerformanceInfo
    get_performance.argtypes = [ctypes.POINTER(PerformanceInfo), wintypes.DWORD]
    get_performance.restype = wintypes.BOOL


def committed_memory():
    if os.name == 'nt':
        info = PerformanceInfo()
        info.cb = ctypes.sizeof(info)
        if not get_performance(ctypes.byref(info), info.cb):
            return dict(kind='commit', used=None, total=None, percent=None)
        used, total = info.CommitTotal*info.PageSize, info.CommitLimit*info.PageSize
        return dict(kind='commit', used=used, total=total, percent=used/total*100 if total else None)
    swap = psutil.swap_memory()
    return dict(kind='swap',used=swap.used,total=swap.total,percent=swap.percent)


def gpu_record(key, name, vendor, source):
    return dict(id=key,name=name,vendor=vendor,source=source,utilization=None,
        memory_used=None,memory_total=None,temperature=None,memory_temperature=None,
        hotspot=None,power=None,power_limit=None,fan_rpm=None,fan_percent=None,
        pcie_generation=None,pcie_width=None,pcie_tx_bps=None,pcie_rx_bps=None,clock_mhz=None,memory_clock_mhz=None,memory_clock_raw_mhz=None,memory_clock_basis='driver',memory_type=None,cuda_cores=None)


def pick(device, kind, names):
    sensors = {(s['kind'],s['name']):s['value'] for s in device.get('sensors',[]) if s['value'] is not None}
    return next((sensors[(kind,n)] for n in names if (kind,n) in sensors),None)


def read_sensors(device):
    vendor = {'GpuNvidia':'NVIDIA','GpuAmd':'AMD','GpuIntel':'Intel'}.get(device['kind'],'其他')
    row = gpu_record('lhm:'+device['id'],device['name'],vendor,'LibreHardwareMonitor')
    row['utilization'] = pick(device,'Load',['GPU Core','GPU D3D 3D','GPU Total'])
    row['temperature'] = pick(device,'Temperature',['GPU Core','GPU Temperature'])
    row['memory_temperature'] = pick(device,'Temperature',['GPU Memory','GPU Memory Junction'])
    row['clock_mhz']=pick(device,'Clock',['GPU Core','GPU Clock'])
    row['memory_clock_mhz']=pick(device,'Clock',['GPU Memory'])
    row['hotspot'] = pick(device,'Temperature',['GPU Hot Spot','GPU Hotspot','GPU Hot Spot Temperature'])
    row['power'] = pick(device,'Power',['GPU Package','GPU Power','GPU Total','GPU Board Power'])
    fans = [s['value'] for s in device.get('sensors',[]) if s['kind']=='Fan' and s['value'] is not None]
    row['fan_rpm'] = fans[0] if fans else None
    for key,names in [('memory_used',['GPU Memory Used','GPU D3D Dedicated Memory Used']),
                      ('memory_total',['GPU Memory Total','GPU D3D Dedicated Memory Total'])]:
        value = pick(device,'SmallData',names)
        if value is not None: row[key]=value*1024**2
    return row


def cpu_temperature(device):
    sensors=[s for s in device.get('sensors',[]) if s.get('kind')=='Temperature' and isinstance(s.get('value'),(int,float)) and math.isfinite(s['value']) and -40<=s['value']<=150]
    preferred=['cpu package','cpu (tctl/tdie)','core (tctl/tdie)','core (tdie)','core (tctl)','cpu (tctl)','core max','core average']
    for name in preferred:
        match=next((s for s in sensors if s['name'].strip().lower()==name),None)
        if match:return match['value'],match['name']
    cores=[s for s in sensors if ('core #' in s['name'].lower() or 'ccd' in s['name'].lower()) and not any(x in s['name'].lower() for x in ('distance','tjmax','t j max','threshold','limit'))]
    if cores:
        sensor=max(cores,key=lambda s:s['value']);return sensor['value'],'最高核心 · '+sensor['name']
    return None,None


class Monitor:
    fast_interval = 0.5
    sensor_interval = 5.0
    idle_timeout = 12.0

    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.worker = None
        self.process = None
        self.windows = dict(devices=[],inventory=[],disks=[],error=None)
        self.windows_time = 0
        self.last_requested = 0
        self.selected_disk = ''
        self.selected_gpu = ''
        self.cached = None
        self.cached_at = 0
        self.cpu_previous = psutil.cpu_times()
        self.cpu_info = dict(name=platform.processor() or 'CPU',cores=psutil.cpu_count(logical=False),threads=psutil.cpu_count())
        if os.name == 'nt':
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:
                    self.cpu_info['name']=winreg.QueryValueEx(key,'ProcessorNameString')[0].strip()
            except OSError: pass
        self.nvidia_memory_types = None
        self.cpu_energy = None
        self.cpu_energy_attempted = False
        self.handles = None
        self.nvidia = []
        self.unsupported = set()
        self.nvml_slow_at = 0
        self.drm_names = {}
        self.disk_previous = {}
        self.rates = {}
        self.sensor_reads = 0
        self.cpu_linux_at = 0
        self.cpu_linux = dict(temperature=None,power=None)
        self.energy_previous = None
        atexit.register(self.close)

    def _cpu_percent(self):
        current=psutil.cpu_times()
        def total(t):
            if os.name == 'nt': return t.user+t.system+t.idle
            return sum(t)-getattr(t,'guest',0)-getattr(t,'guest_nice',0)
        elapsed=total(current)-total(self.cpu_previous)
        idle=(current.idle+getattr(current,'iowait',0))-(self.cpu_previous.idle+getattr(self.cpu_previous,'iowait',0))
        self.cpu_previous=current
        return max(0,min(100,(elapsed-idle)/elapsed*100)) if elapsed>0 else 0

    def _nvidia_rows(self, now):
        if self.handles is None:
            self.handles=[]
            if os.name=='nt':
                try:
                    try:from .windows_nvapi import NvidiaMemoryTypes
                    except ImportError:from windows_nvapi import NvidiaMemoryTypes
                    self.nvidia_memory_types=NvidiaMemoryTypes()
                except (OSError,ValueError):pass
            if pynvml:
                try:
                    pynvml.nvmlInit()
                    for index in range(pynvml.nvmlDeviceGetCount()):
                        h=pynvml.nvmlDeviceGetHandleByIndex(index)
                        name=pynvml.nvmlDeviceGetName(h)
                        if isinstance(name,bytes):name=name.decode('utf-8',errors='replace')
                        self.handles.append(h)
                        record=gpu_record('nvml:'+str(index),name,'NVIDIA','NVML')
                        if self.nvidia_memory_types:
                            try:
                                pci=pynvml.nvmlDeviceGetPciInfo(h)
                                record['memory_type_code']=self.nvidia_memory_types.for_bus(pci.bus)
                            except pynvml.NVMLError:pass
                        self.nvidia.append(record)
                except pynvml.NVMLError: pass
        slow=now-self.nvml_slow_at>=self.sensor_interval
        for index,h in enumerate(self.handles):
            row=self.nvidia[index]
            def get(name,*args):
                if (index,name,args) in self.unsupported:return None
                method=getattr(pynvml,name,None)
                if method is None:
                    self.unsupported.add((index,name,args));return None
                try:return method(h,*args)
                except pynvml.NVMLError as e:
                    if isinstance(e,(pynvml.NVMLError_NotSupported,pynvml.NVMLError_FunctionNotFound)):
                        self.unsupported.add((index,name,args))
                    return None
            use=get('nvmlDeviceGetUtilizationRates')
            memory=get('nvmlDeviceGetMemoryInfo')
            row['utilization']=use.gpu if use else None
            row['memory_used']=memory.used if memory else None
            row['memory_total']=memory.total if memory else None
            watts=get('nvmlDeviceGetPowerUsage')
            row['power']=watts/1000 if watts is not None else None
            row['clock_mhz']=get('nvmlDeviceGetClockInfo',pynvml.NVML_CLOCK_GRAPHICS)
            raw_clock=get('nvmlDeviceGetClockInfo',pynvml.NVML_CLOCK_MEM)
            row['memory_clock_raw_mhz']=raw_clock
            if self.nvidia_memory_types:
                try:from .windows_nvapi import memory_clock,MEMORY_TYPES
                except ImportError:from windows_nvapi import memory_clock,MEMORY_TYPES
                row['memory_clock_mhz'],row['memory_clock_basis']=memory_clock(raw_clock,row.get('memory_type_code'))
                row['memory_type']=MEMORY_TYPES.get(row.get('memory_type_code'),(None,None))[0]
            else:row['memory_clock_mhz']=raw_clock
            tx=get('nvmlDeviceGetPcieThroughput',pynvml.NVML_PCIE_UTIL_TX_BYTES)
            rx=get('nvmlDeviceGetPcieThroughput',pynvml.NVML_PCIE_UTIL_RX_BYTES)
            row['pcie_tx_bps']=tx*1000 if tx is not None else None
            row['pcie_rx_bps']=rx*1000 if rx is not None else None
            if slow:
                if row['cuda_cores'] is None:row['cuda_cores']=get('nvmlDeviceGetNumGpuCores')
                row['temperature']=get('nvmlDeviceGetTemperature',pynvml.NVML_TEMPERATURE_GPU)
                limit=get('nvmlDeviceGetEnforcedPowerLimit')
                row['power_limit']=limit/1000 if limit is not None else None
                row['fan_rpm']=get('nvmlDeviceGetFanSpeedRPM')
                row['fan_percent']=get('nvmlDeviceGetFanSpeed')
                row['pcie_generation']=get('nvmlDeviceGetCurrPcieLinkGeneration')
                row['pcie_width']=get('nvmlDeviceGetCurrPcieLinkWidth')
        if slow:self.nvml_slow_at=now
        return [r.copy() for r in self.nvidia]

    def _close_bridge(self):
        p=self.process
        self.process=None
        if not p:return
        try:
            if p.stdin:p.stdin.close()
            p.wait(timeout=2)
        except (OSError,subprocess.TimeoutExpired):
            p.kill();p.wait(timeout=3)
        if p.stdout:p.stdout.close()

    def _open_bridge(self):
        self.process=subprocess.Popen([str(ROOT/'sensors/HardwareSensors-v1110.exe')],stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',
            creationflags=subprocess.CREATE_NO_WINDOW)
        self.replies=queue.Queue()
        def reader(process,replies):
            for line in process.stdout:
                try: replies.put(json.loads(line))
                except json.JSONDecodeError: pass
            replies.put(None)
        threading.Thread(target=reader,args=(self.process,self.replies),daemon=True).start()

    def _sensor_loop(self):
        while not self.stop.is_set():
            self.wake.wait()
            self.wake.clear()
            if self.stop.is_set():break
            while not self.stop.is_set():
                with self.lock:
                    active=time.monotonic()-self.last_requested<self.idle_timeout
                    request=dict(disk=self.selected_disk,gpu=self.selected_gpu)
                if not active:break
                try:
                    if not self.process or self.process.poll() is not None:
                        self._close_bridge();self._open_bridge()
                    self.process.stdin.write(json.dumps(request)+'\n')
                    self.process.stdin.flush()
                    data=self.replies.get(timeout=10)
                    if data is None:raise OSError('传感器进程已退出')
                    with self.lock:
                        if data.get('error'):self.windows['error']=data['error']
                        else:self.windows=data;self.windows_time=time.monotonic()
                        self.sensor_reads+=1
                except (OSError,queue.Empty) as e:
                    with self.lock:self.windows['error']=str(e) or '传感器读取超时'
                    self._close_bridge()
                if self.stop.wait(self.sensor_interval):break
            self._close_bridge()

    def _disk_data(self, now, catalog):
        counters=psutil.disk_io_counters(perdisk=True)
        for key,counter in counters.items():
            previous=self.disk_previous.get(key)
            if previous and now>previous[0]:
                dt=now-previous[0]
                self.rates[key]=dict(read_bps=max(0,counter.read_bytes-previous[1])/dt,
                    write_bps=max(0,counter.write_bytes-previous[2])/dt)
            self.disk_previous[key]=(now,counter.read_bytes,counter.write_bytes)
        result=[]
        for key in counters:
            item=next((d for d in catalog if d['id']==key),None)
            row=dict(id=key,name=item['name'] if item else key,temperature=None,read_bps=None,write_bps=None)
            row.update(self.rates.get(key,{}))
            if os.name!='nt':
                paths=list((Path('/sys/class/block')/key/'device/hwmon').glob('hwmon*/temp1_input'))
                if key.startswith('nvme'):
                    controller=key.split('n',1)[0] if not key.startswith('nvme') else key.rsplit('n',1)[0]
                    paths+=list((Path('/sys/class/nvme')/controller/'device/hwmon').glob('hwmon*/temp1_input'))
                for path in paths:
                    try:row['temperature']=int(path.read_text())/1000;break
                    except (OSError,ValueError):pass
            result.append(row)
        return result

    def _linux_cpu(self, now):
        if now-self.cpu_linux_at<self.sensor_interval:return self.cpu_linux.copy()
        self.cpu_linux_at=now
        if hasattr(psutil,'sensors_temperatures'):
            temps=psutil.sensors_temperatures()
            for name in ('coretemp','k10temp','zenpower'):
                entries=temps.get(name,[])
                if entries:
                    preferred=next((v for v in entries if v.label in ('Package id 0','Tctl','Tdie')),entries[0])
                    self.cpu_linux['temperature']=preferred.current;break
        for path in Path('/sys/class/powercap').glob('intel-rapl:*/energy_uj'):
            try:
                energy=int(path.read_text())
                if self.energy_previous:
                    dt=now-self.energy_previous[0]
                    delta=energy-self.energy_previous[1]
                    if delta<0:delta+=int(path.with_name('max_energy_range_uj').read_text())
                    self.cpu_linux['power']=delta/1e6/dt
                self.energy_previous=(now,energy);break
            except (OSError,ValueError):pass
        return self.cpu_linux.copy()

    def _linux(self):
        rows = []
        for card in sorted(Path('/sys/class/drm').glob('card[0-9]*')):
            if '-' in card.name: continue
            device = card/'device'
            def number(path):
                try: return int(path.read_text().strip(), 0)
                except (OSError, ValueError): return None
            vendor = {0x1002:'AMD',0x8086:'Intel',0x10de:'NVIDIA'}.get(number(device/'vendor'),'其他')
            if vendor == 'NVIDIA' and self.handles: continue
            name = vendor + ' ' + card.name
            try:
                if card.name not in self.drm_names:
                    result = subprocess.run(['lspci','-s',device.resolve().name],capture_output=True,text=True,timeout=2)
                    self.drm_names[card.name] = result.stdout.strip().split(': ',1)[1] if result.returncode == 0 and ': ' in result.stdout else name
                name = self.drm_names[card.name]
            except (OSError, subprocess.TimeoutExpired): pass
            row = gpu_record('drm:'+card.name,name,vendor,'Linux DRM / hwmon')
            row['utilization']=number(device/'gpu_busy_percent')
            row['memory_used']=number(device/'mem_info_vram_used')
            row['memory_total']=number(device/'mem_info_vram_total')
            for hw in (device/'hwmon').glob('hwmon*'):
                power=number(hw/'power1_average')
                cap=number(hw/'power1_cap')
                if power is not None: row['power']=power/1e6
                if cap is not None: row['power_limit']=cap/1e6
                for sensor in hw.glob('temp*_input'):
                    value=number(sensor)
                    if value is None: continue
                    label=sensor.with_name(sensor.name.replace('_input','_label'))
                    try: label=label.read_text().strip().lower()
                    except OSError: label='core' if sensor.name=='temp1_input' else ''
                    if label in ('edge','core','gpu'): row['temperature']=value/1000
                    if label in ('mem','memory','vram'): row['memory_temperature']=value/1000
                    if label in ('junction','hotspot'): row['hotspot']=value/1000
                row['fan_rpm']=number(hw/'fan1_input')
            rows.append(row)
        return rows

    def sample(self, disk='', gpu=''):
        with self.lock:
            now=time.monotonic()
            self.last_requested=now
            if disk:self.selected_disk=disk
            if gpu:self.selected_gpu=gpu
            if os.name=='nt':
                if self.worker is None or not self.worker.is_alive():
                    self.worker=threading.Thread(target=self._sensor_loop,daemon=True);self.worker.start()
                self.wake.set()
            if self.cached is not None and now-self.cached_at<self.fast_interval:return self.cached
            memory=psutil.virtual_memory()
            rows=self._nvidia_rows(now)
            catalog=self.windows.get('disks',[]) if os.name=='nt' else []
            disks=self._disk_data(now,catalog)
            if not self.selected_disk and disks:self.selected_disk=disks[0]['id']
            if not self.selected_gpu and rows:self.selected_gpu=rows[0]['name']
            cpu_sensor=dict(temperature=None,power=None,frequency_mhz=None)
            try:
                frequency=psutil.cpu_freq()
                if frequency and frequency.current>0:cpu_sensor.update(frequency_mhz=frequency.current,frequency_source='OS reported')
            except (OSError,NotImplementedError):pass
            fresh=now-self.windows_time<self.sensor_interval+3
            if fresh and self.windows.get('cpu_frequency_mhz') is not None:cpu_sensor.update(frequency_mhz=self.windows['cpu_frequency_mhz'],frequency_source='Windows Processor Performance')
            if os.name=='nt':
                unmatched=list(rows)
                for device in self.windows.get('inventory',[]):
                    if device['kind'].startswith('Gpu') and not any(r['name']==device['name'] for r in rows):
                        rows.append(read_sensors(dict(device,sensors=[])))
                for device in self.windows.get('devices',[]) if fresh else []:
                    if device['kind'].startswith('Gpu'):
                        row=read_sensors(device)
                        match=next((r for r in unmatched if r['name'].lower()==row['name'].lower()),None)
                        if match:
                            unmatched.remove(match)
                            for key,value in row.items():
                                if key not in ('id','name','vendor','source') and match.get(key) is None and value is not None:
                                    if key=='memory_clock_mhz' and match.get('memory_type_code') is not None and self.nvidia_memory_types:
                                        try:from .windows_nvapi import memory_clock
                                        except ImportError:from windows_nvapi import memory_clock
                                        match['memory_clock_raw_mhz']=value
                                        value,match['memory_clock_basis']=memory_clock(value,match['memory_type_code'])
                                    match[key]=value;match['source']='NVML + LibreHardwareMonitor'
                        else:
                            existing=next((i for i,r in enumerate(rows) if r['id']==row['id']),None)
                            if existing is None:rows.append(row)
                            else:rows[existing]=row
                    elif device['kind']=='Cpu':
                        self.cpu_info['name']=device['name']
                        cpu_sensor['access']={k:v for k,v in (self.windows.get('cpu_access') or {}).items() if k!='hint'}
                        clocks=[s['value'] for s in device.get('sensors',[]) if s['kind']=='Clock' and s['name'].startswith('CPU Core') and s['value'] is not None and s['value']>0]
                        if clocks:cpu_sensor.update(frequency_mhz=sum(clocks)/len(clocks),frequency_source='LibreHardwareMonitor core average')
                        cpu_sensor['temperature'],cpu_sensor['temperature_source']=cpu_temperature(device)
                        value=pick(device,'Power',['CPU Package','Package'])
                        cpu_sensor['power']=value if value is not None and value>0 else None
                    elif device['kind']=='Storage':
                        row=next((r for r in disks if r['id']==device.get('disk_id')),None)
                        if row:row['temperature']=pick(device,'Temperature',['Temperature','Composite','Temperature 1'])
                temperature=self.windows.get('disk_temperature') if fresh else None
                if temperature and temperature.get('value') is not None:
                    disk_row=next((r for r in disks if r['id']==temperature['id']),None)
                    if disk_row:disk_row['temperature']=temperature['value']
            elif platform.system()=='Linux':
                rows.extend(self._linux());cpu_sensor.update(self._linux_cpu(now))
            if os.name=='nt':
                if not self.cpu_energy_attempted:
                    self.cpu_energy_attempted=True
                    try:
                        try:from .windows_cpu import WindowsCpuEnergy
                        except ImportError:from windows_cpu import WindowsCpuEnergy
                        self.cpu_energy=WindowsCpuEnergy()
                    except (OSError,ValueError):pass
                energy=self.cpu_energy.sample() if self.cpu_energy else dict(power=None,source=None,status='unavailable')
                cpu_sensor['energy']=energy
                if energy['power'] is not None:
                    cpu_sensor['power']=energy['power']
                    cpu_sensor['power_source']=energy['source']
                else:cpu_sensor['power_source']='LibreHardwareMonitor' if cpu_sensor['power'] is not None else None
                cpu_sensor['temperature_status']='ok' if cpu_sensor['temperature'] is not None else 'driver_access_denied' if cpu_sensor.get('access',{}).get('driver_access_error')==5 else 'unavailable'
            self.cached=dict(cpu=round(self._cpu_percent(),1),cpu_info=self.cpu_info.copy(),cpu_sensor=cpu_sensor,
                memory_info=self.windows.get('memory_info',{}),ram_used=memory.used,ram_total=memory.total,ram_percent=memory.percent,virtual_memory=committed_memory(),
                gpus=rows,disks=disks,platform=platform.system(),version=VERSION,
                sensor_error=self.windows.get('error') if os.name=='nt' else None,
                sampling=dict(fast_seconds=self.fast_interval,sensor_seconds=self.sensor_interval,
                    sensor_reads=self.sensor_reads,sensor_age_seconds=round(now-self.windows_time,1) if self.windows_time else None,
                    helper_pid=self.process.pid if self.process and self.process.poll() is None else None))
            self.cached_at=now
            return self.cached

    def close(self):
        self.stop.set();self.wake.set()
        if self.worker:self.worker.join(timeout=12)
        if self.cpu_energy:
            self.cpu_energy.close()
        if self.handles:
            try:pynvml.nvmlShutdown()
            except pynvml.NVMLError:pass
