"""全屏圈选层：每个屏幕一个半透明遮罩窗口，拖出矩形，返回物理像素坐标。

为什么每屏一个窗口：混合 DPI 多屏下 Qt 的 virtualGeometry 错乱，
单个跨屏窗口会盖不全（实测只盖住副屏+主屏左上角）。每屏一个窗口
用 screen.geometry() 定位，永远精确覆盖。

截图工具的标准做法：无边框置顶窗口 + WA_TranslucentBackground 画半透明遮罩，
选区用 CompositionMode_Clear "挖洞" 透出原屏幕内容。
"""

from PySide6.QtCore import QObject, QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QGuiApplication, QPainter, QPen
from PySide6.QtWidgets import QWidget

from screenmap import logical_to_physical


class _Surface(QWidget):
    """单个屏幕的圈选遮罩。"""

    picked = Signal(int, int, int, int)  # x, y, w, h（物理像素）
    cancelled = Signal()

    def __init__(self, screen) -> None:
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self._screen = screen
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setCursor(Qt.CrossCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setGeometry(screen.geometry())
        self._origin = QPoint()
        self._current = QRect()
        self._dragging = False

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._origin = event.position().toPoint()
            self._current = QRect(self._origin, self._origin)
            self._dragging = True

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._dragging:
            self._current = QRect(self._origin, event.position().toPoint()).normalized()
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.LeftButton or not self._dragging:
            return
        self._dragging = False
        rect = self._current
        if rect.width() > 5 and rect.height() > 5:
            self.picked.emit(*logical_to_physical(
                self._screen, rect.x(), rect.y(), rect.width(), rect.height()))
        else:
            self.cancelled.emit()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Escape:
            self.cancelled.emit()
        else:
            super().keyPressEvent(event)

    def paintEvent(self, _event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(0, 0, 0, 100))
        if not self._current.isNull():
            painter.setCompositionMode(QPainter.CompositionMode_Clear)
            painter.fillRect(self._current, Qt.transparent)
            painter.setCompositionMode(QPainter.CompositionMode_SourceOver)
            painter.setPen(QPen(QColor("#3a7afe"), 2))
            painter.drawRect(self._current)


class RegionPicker(QObject):
    """管理所有屏幕的圈选遮罩，对外保持 show/hide/picked/cancelled 接口。"""

    picked = Signal(int, int, int, int)
    cancelled = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._surfaces = [_Surface(s) for s in QGuiApplication.screens()]
        for surface in self._surfaces:
            surface.picked.connect(self._on_picked)
            surface.cancelled.connect(self._on_cancelled)

    def show(self) -> None:
        for surface in self._surfaces:
            surface.show()
        self._surfaces[0].activateWindow()
        self._surfaces[0].setFocus()

    def hide(self) -> None:
        for surface in self._surfaces:
            surface.hide()

    def raise_(self) -> None:
        for surface in self._surfaces:
            surface.raise_()

    def activateWindow(self) -> None:
        self._surfaces[0].activateWindow()

    def _on_picked(self, *args) -> None:
        self.hide()
        self.picked.emit(*args)

    def _on_cancelled(self) -> None:
        self.hide()
        self.cancelled.emit()
