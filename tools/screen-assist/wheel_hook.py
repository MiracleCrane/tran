"""点击穿透模式下把滚轮事件偷渡回本窗口。

背景：WS_EX_TRANSPARENT 会把包括滚轮在内的所有鼠标事件漏给下层窗口，
穿透开启后答案区就没法滚动了。

方案：WH_MOUSE_LL 低级鼠标钩子——命中本窗口物理矩形就把 WM_MOUSEWHEEL
PostMessage 给自己，并 return 1 吞掉（下层窗口不会误滚动）；其余事件一律放行。
钩子必须在独立线程的消息循环里运行（Qt 事件循环不驱动它）。
"""

import ctypes
import ctypes.wintypes as wt
import threading

WH_MOUSE_LL = 14
WM_MOUSEWHEEL = 0x020A

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, ctypes.c_size_t, ctypes.c_ssize_t)

user32.SetWindowsHookExW.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_size_t, ctypes.c_ssize_t]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
user32.PostMessageW.restype = ctypes.c_int
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("pt", wt.POINT), ("mouseData", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


# 由 GUI 线程通过 update() 维护；钩子线程只读
_state = {"hwnd": 0, "enabled": False, "rect": (0, 0, 0, 0)}


def _proc(nCode, wParam, lParam):
    if nCode == 0 and wParam == WM_MOUSEWHEEL and _state["enabled"] and _state["hwnd"]:
        info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
        x, y = info.pt.x, info.pt.y
        left, top, right, bottom = _state["rect"]
        if left <= x < right and top <= y < bottom:
            # mouseData 高 16 位就是滚轮 delta，原样搬进 wParam；lParam 是屏幕坐标
            new_lparam = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
            user32.PostMessageW(_state["hwnd"], WM_MOUSEWHEEL,
                                info.mouseData & 0xFFFF0000, new_lparam)
            return 1  # 吞掉，防止下层窗口跟着滚
    return user32.CallNextHookEx(None, nCode, wParam, lParam)


_proc_ref = HOOKPROC(_proc)  # 持引用防 GC 回收回调


def _thread_main() -> None:
    user32.SetWindowsHookExW(WH_MOUSE_LL, _proc_ref, kernel32.GetModuleHandleW(None), 0)
    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.DispatchMessageW(ctypes.byref(msg))


def start() -> None:
    threading.Thread(target=_thread_main, daemon=True).start()


def update(hwnd: int, enabled: bool, rect: tuple[int, int, int, int]) -> None:
    """rect 为本窗口的物理像素矩形 (left, top, right, bottom)。"""
    _state.update(hwnd=hwnd, enabled=enabled, rect=rect)
