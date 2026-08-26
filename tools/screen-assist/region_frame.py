"""固定截图区域的标识框：只画边框的置顶透明窗口。

这个窗口本身也是"隐身"技术的演示：
- 鼠标穿透（WS_EX_TRANSPARENT）：标识框永远不挡鼠标操作
- WDA_EXCLUDEFROMCAPTURE：标识框不会被截图/录屏拍到，不会污染提问用的截图
"""

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

from screenmap import physical_to_logical, screen_for_physical


class RegionFrame(QWidget):
    def __init__(self) -> None:
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)

    def set_region_physical(self, x: int, y: int, w: int, h: int) -> None:
        """按物理像素定位：先找到区域所在屏幕，再换算成该屏的逻辑坐标。"""
        screen = screen_for_physical(x, y)
        lx, ly, lw, lh = physical_to_logical(screen, x, y, w, h)
        g = screen.geometry()
        self.setGeometry(g.x() + lx, g.y() + ly, lw, lh)

    def paintEvent(self, _event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setPen(QPen(QColor("#3a7afe"), 3))
        painter.drawRect(self.rect().adjusted(1, 1, -2, -2))
        painter.setPen(QColor("#3a7afe"))
        painter.drawText(8, 18, "固定截图区域")
