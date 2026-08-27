"""screen-assist：双击热键截图 → 视觉模型 → 会话式浮窗显示。

运行：uv run python main.py
"""

import faulthandler
import sys
import traceback
from datetime import datetime
from pathlib import Path

# pythonw 无控制台，崩溃/异常必须落文件，否则永远抓不到现场
_LOG_FILE = open(Path(__file__).parent / "gui.log", "a", encoding="utf-8")
faulthandler.enable(_LOG_FILE)


def _excepthook(exc_type, exc, tb) -> None:
    _LOG_FILE.write("".join(traceback.format_exception(exc_type, exc, tb)))
    _LOG_FILE.flush()


sys.excepthook = _excepthook
_LOG_FILE.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} 启动 =====\n")
_LOG_FILE.flush()

from PySide6.QtWidgets import QApplication  # noqa: E402

from gui import MainWindow  # noqa: E402


def main() -> None:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)  # 关窗退到托盘，不退出
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
