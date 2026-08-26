"""Qt 逻辑坐标与 mss 物理像素之间的换算。

混合 DPI 多屏（如主屏 200% + 副屏 100%）下，Qt 的 virtualGeometry 是错乱的，
不能用来开全屏窗口；必须逐屏换算：
    物理 = (screen.geometry 原点 + 屏内逻辑坐标) × screen.devicePixelRatio
"""

from PySide6.QtGui import QGuiApplication


def screen_for_physical(x: int, y: int):
    """找物理坐标点落在哪个屏幕上。"""
    for s in QGuiApplication.screens():
        dpr = s.devicePixelRatio()
        g = s.geometry()
        if (round(g.x() * dpr) <= x < round((g.x() + g.width()) * dpr)
                and round(g.y() * dpr) <= y < round((g.y() + g.height()) * dpr)):
            return s
    return QGuiApplication.primaryScreen()


def logical_to_physical(screen, lx: int, ly: int, lw: int, lh: int):
    """屏内逻辑矩形 → mss 需要的物理像素矩形。"""
    dpr = screen.devicePixelRatio()
    g = screen.geometry()
    return (round((g.x() + lx) * dpr), round((g.y() + ly) * dpr),
            round(lw * dpr), round(lh * dpr))


def physical_to_logical(screen, x: int, y: int, w: int, h: int):
    """mss 物理像素矩形 → 屏内逻辑矩形（用于摆放标识框窗口）。"""
    dpr = screen.devicePixelRatio()
    g = screen.geometry()
    return (round(x / dpr) - g.x(), round(y / dpr) - g.y(),
            round(w / dpr), round(h / dpr))
