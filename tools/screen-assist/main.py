"""screen-assist：双击热键截图 → 视觉模型 → 会话式浮窗显示。

运行：uv run python main.py
"""

import sys

from PySide6.QtWidgets import QApplication

from gui import MainWindow


def main() -> None:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)  # 关窗退到托盘，不退出
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
