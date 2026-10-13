import atexit
import json
import os
import platform
import subprocess
import threading
import time
from pathlib import Path
import psutil

try:
    import pynvml
except ImportError:
    pynvml = None

ROOT = Path(__file__).parent

def gpu_record(key, name, vendor, source):
    return dict(id=key, name=name, vendor=vendor, source=source, utilization=None,
                memory_used=None, memory_total=None, temperature=None,
                memory_temperature=None, power=None, power_limit=None)

def read_sensors(device):
    kind = device['kind']
    vendor = {'GpuNvidia':'NVIDIA', 'GpuAmd':'AMD', 'GpuIntel':'Intel'}.get(kind, '其他')
    row = gpu_record('lhm:' + device.get('id', device['name']), device['name'], vendor, 'LibreHardwareMonitor')
    sensors = {(s['kind'], s['name']): s['value'] for s in device['sensors'] if s['value'] is not None}
    def pick(kind, names):
        return next((sensors[(kind, name)] for name in names if (kind, name) in sensors), None)
    row['utilization'] = pick('Load', ['GPU Core', 'GPU D3D 3D', 'GPU Total'])
    row['temperature'] = pick('Temperature', ['GPU Core', 'GPU Temperature'])
    row['memory_temperature'] = pick('Temperature', ['GPU Memory', 'GPU Memory Junction'])
    row['power'] = pick('Power', ['GPU Package', 'GPU Power', 'GPU Total', 'GPU Board Power'])
    for key, names in [('memory_used',['GPU Memory Used','GPU D3D Dedicated Memory Used']),
                       ('memory_total',['GPU Memory Total','GPU D3D Dedicated Memory Total'])]:
        value = pick('SmallData', names)
        if value is not None: row[key] = value * 1024 ** 2
    return row

class Monitor:
    def __init__(self):
        self.lock = threading.Lock()
        self.windows = {'devices':[], 'error':None}
        self.windows_time = 0
        self.process = None
        self.handles = []
        self.nvml_error = None
        self.drm_names = {}
        self.cached = None
        self.cached_at = 0
        psutil.cpu_percent()
        if pynvml:
            try:
                pynvml.nvmlInit()
                self.handles = [pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(pynvml.nvmlDeviceGetCount())]
            except pynvml.NVMLError as e: self.nvml_error = str(e)
        if os.name == 'nt':
            threading.Thread(target=self._windows_reader, daemon=True).start()
        atexit.register(self.close)

    def _windows_reader(self):
        try:
            windows = Path(os.environ.get('SystemRoot', r'C:\Windows'))
            powershell = windows / 'System32/WindowsPowerShell/v1.0/powershell.exe'
            if not powershell.exists():
                powershell = windows / 'Sysnative/WindowsPowerShell/v1.0/powershell.exe'
            self.process = subprocess.Popen([str(powershell),'-NoLogo','-NoProfile','-NonInteractive',
                '-ExecutionPolicy','Bypass','-File',str(ROOT/'windows.ps1')], stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
            for line in self.process.stdout:
                try: data = json.loads(line)
                except json.JSONDecodeError: continue
                with self.lock:
                    self.windows = data
                    self.windows_time = time.monotonic()
        except OSError as e:
            with self.lock: self.windows['error'] = str(e)

    def _nvidia(self):
        rows = []
        for index, handle in enumerate(self.handles):
            def get(method, *args):
                try: return method(handle, *args)
                except pynvml.NVMLError: return None
            name = get(pynvml.nvmlDeviceGetName) or 'NVIDIA GPU'
            if isinstance(name, bytes): name = name.decode('utf-8', errors='replace')
            row = gpu_record('nvml:'+str(index), name, 'NVIDIA', 'NVML')
            use = get(pynvml.nvmlDeviceGetUtilizationRates)
            memory = get(pynvml.nvmlDeviceGetMemoryInfo)
            row['utilization'] = use.gpu if use else None
            if memory: row.update(memory_used=memory.used, memory_total=memory.total)
            row['temperature'] = get(pynvml.nvmlDeviceGetTemperature, pynvml.NVML_TEMPERATURE_GPU)
            power = get(pynvml.nvmlDeviceGetPowerUsage)
            limit = get(pynvml.nvmlDeviceGetEnforcedPowerLimit)
            row['power'] = power / 1000 if power is not None else None
            row['power_limit'] = limit / 1000 if limit is not None else None
            rows.append(row)
        return rows

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
            rows.append(row)
        return rows

    def sample(self):
        with self.lock:
            now = time.monotonic()
            if self.cached is not None and now-self.cached_at < .5: return self.cached
            memory=psutil.virtual_memory()
            rows=self._nvidia()
            if os.name == 'nt':
                fresh=now-self.windows_time < 5
                unmatched = list(rows)
                for device in self.windows['devices']:
                    row=read_sensors(device)
                    if not fresh:
                        for key in ['utilization','temperature','memory_temperature','power','memory_used','memory_total']: row[key]=None
                    match=next((r for r in unmatched if r['name'].lower()==row['name'].lower()),None)
                    if match:
                        unmatched.remove(match)
                        for key in ['utilization','temperature','memory_temperature','power','memory_used','memory_total']:
                            if match[key] is None and row[key] is not None:
                                match[key]=row[key]
                                match['source']='NVML + LibreHardwareMonitor'
                    else: rows.append(row)
            elif platform.system() == 'Linux': rows.extend(self._linux())
            self.cached=dict(cpu=psutil.cpu_percent(),ram_used=memory.used,ram_total=memory.total,
                ram_percent=memory.percent,gpus=rows,platform=platform.system(),
                sensor_error=self.windows['error'] if os.name=='nt' else None,version='1.0.0')
            self.cached_at=now
            return self.cached

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired: self.process.kill()
        if self.handles:
            try: pynvml.nvmlShutdown()
            except pynvml.NVMLError: pass
