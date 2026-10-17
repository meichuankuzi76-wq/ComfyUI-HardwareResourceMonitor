"""Windows inbox EMI reader, independently implemented from Microsoft's EMI API contract.
No driver installation, elevation, WMI polling, or network requests.
"""
import ctypes as C
from ctypes import wintypes as W
import uuid,struct,re

class GUID(C.Structure):
    _fields_=[('raw',C.c_ubyte*16)]
class Interface(C.Structure):
    _fields_=[('cbSize',W.DWORD),('guid',GUID),('flags',W.DWORD),('reserved',C.c_size_t)]

def decode_metadata(version,data):
    if version==1:
        if len(data)<72:raise ValueError('short EMI v1 metadata')
        unit=struct.unpack_from('<I',data)[0];size=struct.unpack_from('<H',data,70)[0]
        if size<2 or size%2 or 72+size>len(data):raise ValueError('invalid EMI channel name')
        return [(unit,data[72:72+size].decode('utf-16-le').rstrip('\0'))]
    if version!=2 or len(data)<68:raise ValueError('unsupported EMI metadata version')
    count=struct.unpack_from('<H',data,66)[0]
    if not 0<count<=256:raise ValueError('invalid EMI channel count')
    result=[];offset=68
    for _ in range(count):
        if offset+6>len(data):raise ValueError('truncated EMI channel')
        unit,size=struct.unpack_from('<IH',data,offset)
        if size<2 or size%2 or offset+6+size>len(data):raise ValueError('invalid EMI channel size')
        result.append((unit,data[offset+6:offset+6+size].decode('utf-16-le').rstrip('\0')));offset+=6+size
    return result

class WindowsCpuEnergy:
    def __init__(self):
        self.devices=[];self.errors=[];self.channels=[]
        self.k=C.WinDLL('kernel32',use_last_error=True);self.s=C.WinDLL('setupapi',use_last_error=True)
        self.k.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,C.c_void_p,W.DWORD,W.DWORD,W.HANDLE];self.k.CreateFileW.restype=W.HANDLE
        self.k.CloseHandle.argtypes=[W.HANDLE];self.k.CloseHandle.restype=W.BOOL
        self.k.DeviceIoControl.argtypes=[W.HANDLE,W.DWORD,C.c_void_p,W.DWORD,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p];self.k.DeviceIoControl.restype=W.BOOL
        self.s.SetupDiGetClassDevsW.argtypes=[C.POINTER(GUID),W.LPCWSTR,W.HWND,W.DWORD];self.s.SetupDiGetClassDevsW.restype=W.HANDLE
        self.s.SetupDiEnumDeviceInterfaces.argtypes=[W.HANDLE,C.c_void_p,C.POINTER(GUID),W.DWORD,C.POINTER(Interface)];self.s.SetupDiEnumDeviceInterfaces.restype=W.BOOL
        self.s.SetupDiGetDeviceInterfaceDetailW.argtypes=[W.HANDLE,C.POINTER(Interface),C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p];self.s.SetupDiGetDeviceInterfaceDetailW.restype=W.BOOL
        self.s.SetupDiDestroyDeviceInfoList.argtypes=[W.HANDLE];self.s.SetupDiDestroyDeviceInfoList.restype=W.BOOL
        guid=GUID((C.c_ubyte*16).from_buffer_copy(uuid.UUID('45bd8344-7ed6-49cf-a440-c276c933b053').bytes_le))
        info=self.s.SetupDiGetClassDevsW(C.byref(guid),None,None,18)
        if info==C.c_void_p(-1).value:self.errors.append('EMI enumeration: '+str(C.get_last_error()));return
        try:
            for index in range(64):
                entry=Interface();entry.cbSize=C.sizeof(entry)
                if not self.s.SetupDiEnumDeviceInterfaces(info,None,C.byref(guid),index,C.byref(entry)):
                    error=C.get_last_error()
                    if error!=259:self.errors.append('EMI enumerate: '+str(error))
                    break
                needed=W.DWORD();self.s.SetupDiGetDeviceInterfaceDetailW(info,C.byref(entry),None,0,C.byref(needed),None)
                if not 6<=needed.value<=65536:continue
                buf=C.create_string_buffer(needed.value);struct.pack_into('<I',buf,0,8 if C.sizeof(C.c_void_p)==8 else 6)
                if not self.s.SetupDiGetDeviceInterfaceDetailW(info,C.byref(entry),buf,needed.value,None,None):continue
                path=C.wstring_at(C.addressof(buf)+4)
                handle=self.k.CreateFileW(path,0x80000000,3,None,3,0,None)
                if handle==C.c_void_p(-1).value:self.errors.append('EMI open: '+str(C.get_last_error()));continue
                try:
                    version=struct.unpack_from('<H',self.ioctl(handle,0,2))[0]
                    size=struct.unpack_from('<I',self.ioctl(handle,1,4))[0]
                    if not 72<=size<=1048576:raise ValueError('invalid metadata size')
                    channels=decode_metadata(version,self.ioctl(handle,2,size))
                    self.devices.append({'handle':handle,'channels':channels,'previous':None});self.channels.extend(name for _,name in channels)
                except (OSError,ValueError,struct.error,UnicodeError) as e:self.errors.append(str(e));self.k.CloseHandle(handle)
        finally:self.s.SetupDiDestroyDeviceInfoList(info)
    def ioctl(self,handle,function,size):
        buf=C.create_string_buffer(size);used=W.DWORD()
        if not self.k.DeviceIoControl(handle,0x224000+(function<<2),None,0,buf,size,C.byref(used),None):raise OSError(C.get_last_error(),'EMI query failed')
        return buf.raw[:used.value]
    def sample(self):
        values={};error=None
        for device in self.devices:
            try:
                data=self.ioctl(device['handle'],3,16*len(device['channels']))
                if len(data)!=16*len(device['channels']):raise ValueError('short EMI measurements')
                rows=list(struct.iter_unpack('<QQ',data));previous=device['previous'];device['previous']=rows
                if previous is None:continue
                for (unit,name),(energy,tick),(old_energy,old_tick) in zip(device['channels'],rows,previous):
                    if unit!=0 or tick<=old_tick or energy<old_energy:continue
                    watts=(energy-old_energy)*0.036/(tick-old_tick)
                    if 0<=watts<=10000:values[name]=watts
            except (OSError,ValueError,struct.error) as e:error=str(e)
        # Match only explicit CPU package domains. Do not add cores/DRAM/PSys.
        package=[v for n,v in values.items() if n.strip().upper() in ('RAPL PACKAGE','CPU PACKAGE','PACKAGE','PROCESSOR PACKAGE','PKG') or re.fullmatch(r'RAPL_Package[0-9]+_PKG',n,re.I)]
        watts=sum(package) if package else None
        return {'power':watts,'source':'Windows EMI / CPU package' if watts is not None else None,'channels':self.channels,'error':error or ('; '.join(self.errors) if self.errors else None),'status':'ok' if watts is not None else 'warming_up' if self.devices and not values else 'no_package_channel' if self.devices else 'no_energy_meter'}
    def close(self):
        for device in self.devices:self.k.CloseHandle(device['handle'])
        self.devices=[]
