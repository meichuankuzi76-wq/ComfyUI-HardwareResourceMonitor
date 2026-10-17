"""Read-only NVIDIA memory-type metadata. No settings or driver changes."""
import ctypes as C
import os

MEMORY_TYPES={8:('GDDR5',2),10:('GDDR5X',4),14:('GDDR6',4),15:('GDDR6X',8)}
def memory_clock(raw_mhz,ram_type):
    if raw_mhz is None:return None,'unknown'
    known=MEMORY_TYPES.get(ram_type)
    return (raw_mhz/known[1],'physical') if known else (raw_mhz,'driver')

class NvidiaMemoryTypes:
    def __init__(self):
        self.by_bus={};self.error=None
        try:
            self.dll=C.CDLL('nvapi64.dll' if C.sizeof(C.c_void_p)==8 else 'nvapi.dll')
            self.query=self.dll.nvapi_QueryInterface;self.query.argtypes=[C.c_uint];self.query.restype=C.c_void_p
            def bind(identifier,*args):
                address=self.query(identifier)
                if not address:raise OSError('NVAPI memory metadata unavailable')
                return C.CFUNCTYPE(C.c_int,*args)(address)
            initialize=bind(0x0150E828)
            if initialize()!=0:raise OSError('NVAPI initialize failed')
            enumerate_gpus=bind(0xE5AC921F,C.POINTER(C.c_void_p),C.POINTER(C.c_uint))
            get_type=bind(0x57F7CAAC,C.c_void_p,C.POINTER(C.c_uint))
            get_bus=bind(0x1BE0B8E5,C.c_void_p,C.POINTER(C.c_uint))
            handles=(C.c_void_p*64)();count=C.c_uint()
            if enumerate_gpus(handles,C.byref(count))!=0 or count.value>64:raise OSError('NVAPI GPU enumeration failed')
            for handle in handles[:count.value]:
                ram_type=C.c_uint();bus=C.c_uint()
                if get_type(handle,C.byref(ram_type))==0 and get_bus(handle,C.byref(bus))==0:
                    self.by_bus.setdefault(bus.value,[]).append(ram_type.value)
        except (OSError,AttributeError,ValueError) as e:self.error=str(e)
    def for_bus(self,bus):
        matches=self.by_bus.get(bus,[])
        return matches[0] if len(matches)==1 else None
