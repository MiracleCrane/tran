"""GUI：会话窗口 + 设置页 + 托盘 + 全局热键 + Win32 窗口效果。

回答引擎二选一（设置页可切）：
- acp：驱动本地 kimi.exe 挂到真实 Kimi 会话，可用知识库，只显示最终答案
- api：直连 OpenAI 兼容接口，上下文由本程序自己维护

多会话 + 知识库：
- 会话栏可独立新建/切换本地会话，各自对应一个底层 ACP 会话（resume 切换）
- 每个会话可绑定一个知识库目录 = ACP 会话的 cwd，
  Agent 回答前会先查目录里的文件（"一个会话一个知识库"）

窗口形态：无边框 + WA_TranslucentBackground，界面背景透明度和文字透明度分离调节。

显示策略：只展示当前一轮——问题（小字）+ 分割线 + 答案；新一轮进来清空上一轮。

五个全局热键（设置页都可重新录制、可选单击/双击）：
- 截图提问（默认双击小键盘 +）   一键隐藏（默认单击小键盘 -）
- 区域框显隐（默认双击小键盘 *） 鼠标穿透（默认双击小键盘 .）
- 重试上一轮（默认双击小键盘 0）
"""

import base64
import ctypes
import os
from pathlib import Path

import keyboard
from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QIcon, QKeyEvent, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QSlider,
    QSystemTrayIcon,
    QTabWidget,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

import wheel_hook
from acp_client import AcpBridge
from config import load_config, save_config
from core import (
    DEFAULT_PROMPT,
    image_message,
    make_client,
    screenshot_png,
    screenshot_region_png,
)
from region_frame import RegionFrame
from region_picker import RegionPicker
from sessions import SessionStore

PROJECT_DIR = Path(__file__).parent

# ---------------- Win32 ----------------

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WDA_NONE = 0x0
WDA_EXCLUDEFROMCAPTURE = 0x11
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020

user32 = ctypes.windll.user32


def set_exclude_from_capture(hwnd: int, enable: bool) -> None:
    """让窗口从 PrintScreen/截图工具/录屏/屏幕共享中消失（Win10 2004+）。"""
    user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE if enable else WDA_NONE)


def set_click_through(hwnd: int, enable: bool) -> None:
    style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if enable:
        style |= WS_EX_LAYERED | WS_EX_TRANSPARENT
    else:
        style &= ~WS_EX_TRANSPARENT
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)


# ---------------- 直连 API 引擎 ----------------

class ApiWorker(QThread):
    """直连 OpenAI 兼容接口：子线程跑流式请求，避免阻塞 UI。"""

    chunk = Signal(str)
    failed = Signal(str)

    def __init__(self, cfg: dict, messages: list, parent=None):
        super().__init__(parent)
        self.cfg = cfg
        self.messages = list(messages)
        self.full = ""

    def run(self) -> None:
        try:
            client = make_client(self.cfg)
            stream = client.chat.completions.create(
                model=self.cfg["model"], messages=self.messages, stream=True
            )
            for part in stream:
                delta = part.choices[0].delta.content or ""
                if delta:
                    self.full += delta
                    self.chunk.emit(delta)
        except Exception as ex:  # noqa: BLE001 - 任何错误都只上屏，不弄死程序
            self.failed.emit(str(ex))


# ---------------- 全局热键 ----------------

class HotkeyManager(QObject):
    """低级键盘钩子：按扫描码识别热键，支持单击/双击两种触发方式。

    扫描码不受 NumLock 影响，小键盘键在 NumLock 开/关下行为一致。
    回调运行在 keyboard 库自己的线程，只发 Qt 信号（排队到 GUI 线程），
    绝不在回调里做截图/网络等重活，否则会拖慢系统按键。
    """

    ask = Signal()
    toggle_hide = Signal()
    toggle_frame = Signal()
    toggle_click = Signal()
    retry = Signal()
    key_recorded = Signal(int, str)  # scan_code, 可读名称

    ACTIONS = ("ask", "hide", "frame", "click", "retry")
    DOUBLE_MS = 400

    def __init__(self, cfg: dict, parent=None):
        super().__init__(parent)
        self._signals = {
            "ask": self.ask,
            "hide": self.toggle_hide,
            "frame": self.toggle_frame,
            "click": self.toggle_click,
            "retry": self.retry,
        }
        self._key_up = dict.fromkeys(self.ACTIONS, True)
        self._last_down = dict.fromkeys(self.ACTIONS, 0.0)
        self._recording = False
        self._enabled = True       # 总开关只管截图提问，其余热键永远可用
        self.rebind(cfg)
        keyboard.hook(self._on_key)

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    def rebind(self, cfg: dict) -> None:
        self._bindings = {
            action: (cfg[f"{action}_scan"], cfg[f"{action}_mode"])
            for action in self.ACTIONS
        }

    def start_record(self) -> None:
        """录制下一个按下的键（在守护线程里阻塞读，结果用信号送回）。"""
        import threading

        self._recording = True

        def _read() -> None:
            event = keyboard.read_event()
            self.key_recorded.emit(event.scan_code, event.name or str(event.scan_code))

        threading.Thread(target=_read, daemon=True).start()

    def _on_key(self, event: keyboard.KeyboardEvent) -> None:
        import time

        if self._recording:
            return
        for action, (scan, mode) in self._bindings.items():
            if event.scan_code != scan:
                continue
            if action == "ask" and not self._enabled:
                return
            if event.event_type == "up":
                self._key_up[action] = True
                return
            if not self._key_up[action]:  # 长按自动重复
                return
            self._key_up[action] = False
            if mode == "single":
                self._signals[action].emit()
                return
            now = time.monotonic()
            if (now - self._last_down[action]) * 1000 < self.DOUBLE_MS:
                self._last_down[action] = 0.0
                self._signals[action].emit()
            else:
                self._last_down[action] = now
            return


# ---------------- 自定义标题栏（无边框窗口用） ----------------

class TitleBar(QWidget):
    def __init__(self, window: QMainWindow) -> None:
        super().__init__(window)
        self._win = window
        self._drag_pos = None
        self.setObjectName("titlebar")
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 4, 6, 4)
        layout.addWidget(QLabel("screen-assist · 屏幕问答演示"))
        layout.addStretch()
        min_btn = QPushButton("—")
        min_btn.setFixedSize(30, 24)
        min_btn.clicked.connect(window.showMinimized)
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(30, 24)
        close_btn.clicked.connect(window.close)  # closeEvent 里转为退到托盘
        layout.addWidget(min_btn)
        layout.addWidget(close_btn)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self._win.frameGeometry().topLeft()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag_pos is not None and event.buttons() & Qt.LeftButton:
            self._win.move(event.globalPosition().toPoint() - self._drag_pos)

    def mouseReleaseEvent(self, _event) -> None:  # noqa: N802
        self._drag_pos = None


# ---------------- 主窗口 ----------------

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.cfg = load_config()
        self.store = SessionStore.migrate(self.cfg)
        self.history: list[dict] = []   # API 模式的会话历史（ACP 模式历史在 kimi 侧）
        self._md_parts: list[str] = []  # 当前一轮的渲染片段：问题/分割线/答案
        self._last_round: tuple[str, str | None, bytes | None] | None = None
        self._states: dict[str, dict] = {}  # 每个本地会话的展示状态（md/last/history）
        self.worker: ApiWorker | None = None
        self.acp: AcpBridge | None = None
        self._ensuring = False
        self._pending_round: tuple[str | None, bytes | None] | None = None
        self.picker: RegionPicker | None = None
        self.frame: RegionFrame | None = None
        self._fixed_pick = False  # 本次圈选要存为固定区域
        self._save_only = False   # 存完就结束，不接着提问
        self.click_through = False
        self._recording_target = ""
        self._quitting = False

        self.setWindowTitle("screen-assist · 屏幕问答演示")
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.Window)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setMinimumSize(520, 380)
        self.resize(880, 620)
        self._build_ui()
        self._build_tray()
        self._apply_style()
        self._refresh_session_box()

        self.hotkeys = HotkeyManager(self.cfg)
        self.hotkeys.set_enabled(bool(self.cfg["enabled"]))
        self.hotkeys.ask.connect(self.on_ask_hotkey)
        self.hotkeys.toggle_hide.connect(self.toggle_visible)
        self.hotkeys.toggle_frame.connect(self.on_frame_hotkey)
        self.hotkeys.toggle_click.connect(
            lambda: self.on_click_through_toggled(not self.click_through)
        )
        self.hotkeys.retry.connect(self.on_retry)
        self.hotkeys.key_recorded.connect(self._on_key_recorded)

        wheel_hook.start()
        self._apply_window_settings()
        self._apply_frame_visibility()
        if self.cfg["backend"] == "acp":
            self._ensure_acp()

    # ---- 本地会话状态 ----

    def _sess(self) -> dict:
        return self.store.current()

    def _state(self) -> dict:
        return self._states.setdefault(
            self._sess()["id"], {"md": [], "last": None, "history": []})

    def _dump_state(self) -> None:
        st = self._state()
        st["md"] = self._md_parts
        st["last"] = self._last_round
        st["history"] = self.history

    def _load_state(self) -> None:
        st = self._state()
        self._md_parts = st.get("md", [])
        self._last_round = st.get("last")
        self.history = st.get("history", [])
        self._render()

    # ---- UI 搭建 ----

    def _build_ui(self) -> None:
        container = QWidget()
        container.setObjectName("central")
        container_layout = QVBoxLayout(container)
        container_layout.setContentsMargins(0, 0, 0, 0)
        container_layout.setSpacing(0)
        container_layout.addWidget(TitleBar(self))
        self.setCentralWidget(container)

        tabs = QTabWidget()
        container_layout.addWidget(tabs)

        # 会话页
        chat_page = QWidget()
        chat_layout = QVBoxLayout(chat_page)

        # 会话栏：下拉切换 + 新建 + 知识库目录
        sess_row = QHBoxLayout()
        sess_row.addWidget(QLabel("会话"))
        self.session_box = QComboBox()
        self.session_box.currentIndexChanged.connect(self.on_session_switched)
        new_sess_btn = QPushButton("新建")
        new_sess_btn.clicked.connect(self.on_new_session)
        self.kb_btn = QPushButton()
        self.kb_btn.clicked.connect(self.on_pick_kb)
        self.kb_clear_btn = QPushButton("✕")
        self.kb_clear_btn.setFixedWidth(28)
        self.kb_clear_btn.setToolTip("清除本会话的知识库绑定")
        self.kb_clear_btn.clicked.connect(self.on_clear_kb)
        sess_row.addWidget(self.session_box, 1)
        sess_row.addWidget(new_sess_btn)
        sess_row.addWidget(self.kb_btn)
        sess_row.addWidget(self.kb_clear_btn)
        chat_layout.addLayout(sess_row)

        self.chat = QTextBrowser()
        self.chat.setOpenExternalLinks(True)
        chat_layout.addWidget(self.chat)
        input_row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("追问…（回车发送，多轮上下文有效）")
        self.input.returnPressed.connect(self.on_send_text)
        send_btn = QPushButton("发送")
        send_btn.clicked.connect(self.on_send_text)
        shot_btn = QPushButton("截图提问")
        shot_btn.clicked.connect(self.on_ask_hotkey)
        for w in (self.input, send_btn, shot_btn):
            input_row.addWidget(w)
        chat_layout.addLayout(input_row)
        tabs.addTab(chat_page, "会话")

        # 设置页
        settings_page = QWidget()
        form = QFormLayout(settings_page)

        self.backend_box = QComboBox()
        self.backend_box.addItem("Kimi 会话（可用知识库）", "acp")
        self.backend_box.addItem("直连 API", "api")
        self.backend_box.setCurrentIndex(0 if self.cfg["backend"] == "acp" else 1)
        self.backend_box.currentIndexChanged.connect(self.on_backend_changed)
        form.addRow("回答引擎", self.backend_box)

        self.prompt_edit = QPlainTextEdit(self.current_prompt())
        self.prompt_edit.setPlaceholderText("留空则使用内置默认提示词")
        save_prompt_btn = QPushButton("保存提示词")
        save_prompt_btn.clicked.connect(self.on_save_prompt)
        form.addRow("系统提示词", self.prompt_edit)
        form.addRow("", save_prompt_btn)

        self.shot_mode_box = QComboBox()
        self.shot_mode_box.addItem("主屏全屏", "fullscreen")
        self.shot_mode_box.addItem("每次圈选区域", "region")
        self.shot_mode_box.addItem("固定区域", "region_fixed")
        self.shot_mode_box.setCurrentIndex(
            {"fullscreen": 0, "region": 1, "region_fixed": 2}.get(self.cfg["shot_mode"], 0)
        )
        self.shot_mode_box.currentIndexChanged.connect(self.on_shot_mode_changed)
        pick_btn = QPushButton("圈选固定区域")
        pick_btn.clicked.connect(self.on_pick_fixed_region)
        shot_row = QHBoxLayout()
        shot_row.addWidget(self.shot_mode_box)
        shot_row.addWidget(pick_btn)
        form.addRow("截图范围", shot_row)

        self.enabled_box = QCheckBox("启用截图热键（总开关，其余热键不受影响）")
        self.enabled_box.setChecked(bool(self.cfg["enabled"]))
        self.enabled_box.toggled.connect(self.on_enabled_toggled)
        form.addRow("", self.enabled_box)

        # 五个热键行
        self._key_labels: dict[str, QLabel] = {}
        self._mode_boxes: dict[str, QComboBox] = {}
        for action, title in (
            ("ask", "截图提问热键"),
            ("hide", "一键隐藏热键"),
            ("frame", "区域框显隐热键"),
            ("click", "鼠标穿透热键"),
            ("retry", "重试热键"),
        ):
            label = QLabel(f"当前：{self.cfg[f'{action}_name']}")
            self._key_labels[action] = label
            record = QPushButton("录制")
            record.clicked.connect(lambda _=False, a=action: self._start_record(a))
            mode_box = QComboBox()
            mode_box.addItems(["double", "single"])
            mode_box.setCurrentText(self.cfg[f"{action}_mode"])
            mode_box.currentTextChanged.connect(self.on_mode_changed)
            self._mode_boxes[action] = mode_box
            row = QHBoxLayout()
            for w in (label, record, QLabel("触发"), mode_box):
                row.addWidget(w)
            form.addRow(title, row)

        self.ui_opacity_slider = QSlider(Qt.Horizontal)
        self.ui_opacity_slider.setRange(30, 100)
        self.ui_opacity_slider.setValue(round(float(self.cfg["ui_opacity"]) * 100))
        self.ui_opacity_slider.valueChanged.connect(self.on_ui_opacity_changed)
        form.addRow("界面不透明度", self.ui_opacity_slider)

        self.text_opacity_slider = QSlider(Qt.Horizontal)
        self.text_opacity_slider.setRange(30, 100)
        self.text_opacity_slider.setValue(round(float(self.cfg["text_opacity"]) * 100))
        self.text_opacity_slider.valueChanged.connect(self.on_text_opacity_changed)
        form.addRow("文字不透明度", self.text_opacity_slider)

        self.topmost_box = QCheckBox("窗口置顶")
        self.topmost_box.setChecked(bool(self.cfg["topmost"]))
        self.topmost_box.toggled.connect(self.on_topmost_toggled)
        form.addRow("", self.topmost_box)

        self.click_box = QCheckBox("鼠标穿透（开启后点击落到下层，滚轮仍作用于本窗口；用热键或托盘恢复）")
        self.click_box.toggled.connect(self.on_click_through_toggled)
        form.addRow("", self.click_box)

        self.capture_box = QCheckBox("从截图/录屏中排除本窗口（WDA_EXCLUDEFROMCAPTURE）")
        self.capture_box.setChecked(bool(self.cfg["exclude_capture"]))
        self.capture_box.toggled.connect(self.on_capture_toggled)
        form.addRow("", self.capture_box)

        tabs.addTab(settings_page, "设置")

    def _build_tray(self) -> None:
        pix = QPixmap(32, 32)
        pix.fill(QColor("#3a7afe"))
        self.tray = QSystemTrayIcon(QIcon(pix), self)
        self.tray.setToolTip("screen-assist")
        menu = QMenu()
        show_act = QAction("显示/隐藏", self)
        show_act.triggered.connect(self.toggle_visible)
        self.tray_enabled_act = QAction("启用热键", self, checkable=True)
        self.tray_enabled_act.setChecked(bool(self.cfg["enabled"]))
        self.tray_enabled_act.toggled.connect(self.on_enabled_toggled)
        self.tray_click_act = QAction("鼠标穿透", self, checkable=True)
        self.tray_click_act.toggled.connect(self.on_click_through_toggled)
        quit_act = QAction("退出", self)
        quit_act.triggered.connect(self.quit_app)
        menu.addAction(show_act)
        menu.addAction(self.tray_enabled_act)
        menu.addAction(self.tray_click_act)
        menu.addSeparator()
        menu.addAction(quit_act)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda reason: self.toggle_visible()
            if reason == QSystemTrayIcon.DoubleClick
            else None
        )
        self.tray.show()

    # ---- 会话栏 ----

    def _refresh_session_box(self) -> None:
        self.session_box.blockSignals(True)
        self.session_box.clear()
        current = self._sess()
        for s in self.store.all():
            self.session_box.addItem(s["name"], s["id"])
            if current and s["id"] == current["id"]:
                self.session_box.setCurrentIndex(self.session_box.count() - 1)
        self.session_box.blockSignals(False)
        self._refresh_kb_btn()

    def _refresh_kb_btn(self) -> None:
        kb = self._sess().get("kb_dir", "")
        self.kb_btn.setText(f"知识库：{os.path.basename(kb) if kb else '未设置'}")
        self.kb_btn.setToolTip(kb or "点击选择目录，目录内所有文件作为本会话的知识库")
        self.kb_clear_btn.setVisible(bool(kb))

    def on_session_switched(self) -> None:
        if self._busy():
            # 回答途中不换会话，回退下拉
            self._refresh_session_box()
            self._status("回答中，稍后再切换")
            return
        self._dump_state()
        self.store.set_current(self.session_box.currentData())
        self._load_state()
        self._refresh_kb_btn()
        # 目标会话已有底层 ACP 会话的，切过去；没有的等首次提问时懒创建
        sess = self._sess()
        if self.cfg["backend"] == "acp" and self.acp is not None and sess["acp_session_id"]:
            self._prepare_acp_session()

    def on_new_session(self) -> None:
        if self._busy():
            self._status("回答中，稍后再新建")
            return
        self._dump_state()
        self.store.add(f"会话{len(self.store.all()) + 1}")
        self._md_parts = []
        self._last_round = None
        self.history = []
        self.chat.clear()
        self._refresh_session_box()
        self._status("新会话已创建；点右侧「知识库」按钮可绑定目录")

    def on_pick_kb(self) -> None:
        sess = self._sess()
        chosen = QFileDialog.getExistingDirectory(
            self, "选择知识库目录（目录内所有文件作为本会话知识库）",
            sess.get("kb_dir") or str(PROJECT_DIR))
        if not chosen:
            return
        if sess["acp_session_id"] and chosen != sess.get("kb_dir"):
            # 知识库路径已随固定指令进入旧会话上下文，换目录要换底层会话才能生效
            sess["acp_session_id"] = ""
            sess["instructed"] = False
            self._status("知识库已变更，底层会话将在下次提问时按新目录重建")
        sess["kb_dir"] = chosen
        self.store.save()
        self._refresh_kb_btn()

    def on_clear_kb(self) -> None:
        sess = self._sess()
        if not sess.get("kb_dir"):
            return
        sess["kb_dir"] = ""
        if sess["acp_session_id"]:
            # 知识库路径已随固定指令进入旧会话上下文，解绑要换底层会话才能生效
            sess["acp_session_id"] = ""
            sess["instructed"] = False
        self.store.save()
        self._refresh_kb_btn()
        self._status("已清除知识库绑定")

    # ---- 样式：界面透明度与文字透明度分离 ----

    def _apply_style(self) -> None:
        ui_a = round(float(self.cfg["ui_opacity"]) * 255)
        tx_a = round(float(self.cfg["text_opacity"]) * 255)
        self.centralWidget().setStyleSheet(f"""
            QWidget#central {{
                background: rgba(24, 24, 28, {ui_a});
                border-radius: 10px;
            }}
            QWidget#titlebar {{
                background: rgba(34, 34, 40, {ui_a});
                border-top-left-radius: 10px;
                border-top-right-radius: 10px;
            }}
            QLabel, QCheckBox {{
                color: rgba(240, 240, 240, {tx_a});
                background: transparent;
            }}
            QTextBrowser, QPlainTextEdit, QLineEdit {{
                background: rgba(40, 40, 46, {ui_a});
                color: rgba(240, 240, 240, {tx_a});
                border: 1px solid rgba(90, 90, 100, {ui_a});
                border-radius: 6px;
            }}
            QPushButton {{
                background: rgba(58, 122, 254, {ui_a});
                color: rgba(255, 255, 255, {tx_a});
                border-radius: 6px;
                padding: 4px 12px;
            }}
            QComboBox {{
                background: rgba(40, 40, 46, {ui_a});
                color: rgba(240, 240, 240, {tx_a});
                border-radius: 4px;
                padding: 2px 6px;
            }}
            QTabWidget::pane {{ border: none; }}
            QTabBar::tab {{
                background: rgba(40, 40, 46, {ui_a});
                color: rgba(240, 240, 240, {tx_a});
                padding: 6px 14px;
            }}
            QTabBar::tab:selected {{ background: rgba(58, 122, 254, {ui_a}); }}
        """)

    # ---- 窗口效果 ----

    def _apply_window_settings(self) -> None:
        self.setWindowFlag(Qt.WindowStaysOnTopHint, bool(self.cfg["topmost"]))
        hwnd = int(self.winId())
        set_exclude_from_capture(hwnd, bool(self.cfg["exclude_capture"]))
        set_click_through(hwnd, self.click_through)
        self._sync_wheel_hook()

    def _physical_rect(self) -> tuple[int, int, int, int]:
        g = self.frameGeometry()
        dpr = self.screen().devicePixelRatio() if self.screen() else 1.0
        return (round(g.x() * dpr), round(g.y() * dpr),
                round((g.x() + g.width()) * dpr), round((g.y() + g.height()) * dpr))

    def _sync_wheel_hook(self) -> None:
        """穿透开启时，滚轮钩子需要知道本窗口的物理矩形。"""
        wheel_hook.update(int(self.winId()), self.click_through, self._physical_rect())

    def showEvent(self, event) -> None:  # noqa: N802 - Qt 命名
        super().showEvent(event)
        # 窗口标志变化可能重建句柄，每次显示都重挂 Win32 效果
        hwnd = int(self.winId())
        set_exclude_from_capture(hwnd, bool(self.cfg["exclude_capture"]))
        set_click_through(hwnd, self.click_through)
        self._sync_wheel_hook()

    def moveEvent(self, event) -> None:  # noqa: N802
        super().moveEvent(event)
        if self.click_through:
            self._sync_wheel_hook()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if self.click_through:
            self._sync_wheel_hook()

    # ---- 区域标识框 ----

    def _apply_frame_visibility(self) -> None:
        want = (self.cfg.get("shot_mode") == "region_fixed"
                and self.cfg.get("frame_visible", True)
                and self._parse_region() is not None)
        if not want:
            if self.frame is not None:
                self.frame.hide()
            return
        if self.frame is None:
            self.frame = RegionFrame()
        self.frame.set_region_physical(*self._parse_region())
        self.frame.show()
        # 标识框永远鼠标穿透 + 不进任何截图/录屏，不会污染提问用的图
        hwnd = int(self.frame.winId())
        set_click_through(hwnd, True)
        set_exclude_from_capture(hwnd, True)

    def on_frame_hotkey(self) -> None:
        self.cfg["frame_visible"] = not self.cfg.get("frame_visible", True)
        save_config(self.cfg)
        self._apply_frame_visibility()
        self._status("区域框已" + ("显示" if self.cfg["frame_visible"] else "隐藏"))

    # ---- 会话逻辑（单轮展示） ----

    def current_prompt(self) -> str:
        return self.cfg["prompt"].strip() or DEFAULT_PROMPT

    def _instruction(self, sess: dict) -> str:
        text = self.current_prompt()
        if sess.get("kb_dir"):
            text += (f"\n本会话有一个本地知识库目录：{sess['kb_dir']}（绝对路径）。"
                     "当问题可能涉及知识库内容时，先用 Glob/Grep/Read 查阅该目录下的文件，"
                     "再基于文件内容回答。")
        return text

    def _render(self) -> None:
        self.chat.setMarkdown("\n\n".join(self._md_parts))
        bar = self.chat.verticalScrollBar()
        bar.setValue(bar.maximum())

    def _busy(self) -> bool:
        if self.cfg["backend"] == "acp":
            return (self.acp is not None and self.acp.busy) or self._ensuring
        return self.worker is not None and self.worker.isRunning()

    def _status(self, text: str, ms: int = 4000) -> None:
        self.statusBar().showMessage(text, ms)

    def _start_round(self, question_md: str, text: str | None, png: bytes | None) -> None:
        """开新一轮：清掉上一轮的展示，只留 问题 + 分割线 + 流式答案。"""
        self._last_round = (question_md, text, png)
        self._md_parts = [question_md, "---", "**助手**："]
        self._render()
        if self.cfg["backend"] == "acp":
            self._send_acp(text, png)
        else:
            self._send_api(text, png)

    def on_retry(self) -> None:
        """重试热键：原样重发上一轮的问题和截图，重新生成答案。"""
        if self._busy():
            self._status("上一轮还在回答中…")
            return
        if not self._last_round:
            self._status("还没有可重试的问题")
            return
        question_md, text, png = self._last_round
        self._md_parts = [question_md, "---", "**助手**："]
        self._render()
        if self.cfg["backend"] == "acp":
            self._send_acp(text, png)
        else:
            self._send_api(text, png)

    # -- 截图与圈选 --

    def on_ask_hotkey(self) -> None:
        """截图热键：按配置决定全屏 / 圈选 / 固定区域，随后自动提问。"""
        if self._busy():
            self._status("上一轮还在回答中…")
            return
        mode = self.cfg.get("shot_mode", "fullscreen")
        if mode == "region":
            self._fixed_pick = False
            self._save_only = False
            self._show_picker()
            return
        if mode == "region_fixed":
            rect = self._parse_region()
            if rect is None:
                # 还没有固定区域：先圈一次，圈完直接接着提问
                self._fixed_pick = True
                self._save_only = False
                self._show_picker()
                return
            self._capture_and_ask(rect)
            return
        self._capture_and_ask(None)

    def _parse_region(self) -> tuple[int, int, int, int] | None:
        try:
            x, y, w, h = (int(v) for v in str(self.cfg.get("region", "")).split(","))
        except ValueError:
            return None
        return (x, y, w, h) if w > 5 and h > 5 else None

    def _show_picker(self) -> None:
        if self.picker is None:
            self.picker = RegionPicker()
            self.picker.picked.connect(self._on_region_picked)
            self.picker.cancelled.connect(lambda: self._status("已取消圈选"))
        self.picker.show()
        self.picker.raise_()
        self.picker.activateWindow()

    def _on_region_picked(self, x: int, y: int, w: int, h: int) -> None:
        if self._fixed_pick:
            self._fixed_pick = False
            self.cfg["region"] = f"{x},{y},{w},{h}"
            save_config(self.cfg)
            self._status(f"固定区域已保存：{w}×{h} @({x},{y})")
            self._apply_frame_visibility()
            if self._save_only:
                self._save_only = False
                return
        # 等圈选层从屏幕上消失（DWM 合成一帧）再抓，否则会把遮罩拍进去
        QTimer.singleShot(250, lambda: self._capture_and_ask((x, y, w, h)))

    def on_pick_fixed_region(self) -> None:
        self._fixed_pick = True
        self._save_only = True
        self._show_picker()

    def _capture_and_ask(self, rect: tuple[int, int, int, int] | None) -> None:
        # 先抓图再弹窗：没开"排除捕获"时不会把自己的窗口拍进去
        try:
            png = screenshot_png() if rect is None else screenshot_region_png(*rect)
        except Exception as ex:  # noqa: BLE001
            self._md_parts = [f"> [截图失败] {ex}"]
            self._render()
            return
        if not self.isVisible():
            self.show()
        self.raise_()
        self._start_round("> **我**：[发送了一张屏幕截图]", text=None, png=png)

    # -- 发送 --

    def on_send_text(self) -> None:
        text = self.input.text().strip()
        if not text or self._busy():
            return
        self.input.clear()
        self._start_round(f"> **我**：{text}", text=text, png=None)

    # -- ACP 引擎：挂真实 Kimi 会话 --

    def _ensure_acp(self) -> None:
        if self.acp is not None:
            return
        self.acp = AcpBridge(
            cwd=str(PROJECT_DIR),
            kimi_home=self.cfg.get("kimi_home", ""),
            parent=self,
        )
        self.acp.booted.connect(self._on_acp_booted)
        self.acp.ready.connect(self._on_acp_ready)
        self.acp.chunk.connect(self._on_chunk)
        self.acp.turn_done.connect(lambda _reason: None)
        self.acp.failed.connect(self._on_failed)
        self.acp.tool_log.connect(lambda msg: self._status(msg, 5000))
        # 思考块按需求不显示
        self._status("正在连接 Kimi…")
        self.acp.start()

    def _on_acp_booted(self) -> None:
        # 当前会话已有底层 ACP 会话就接回去，没有则等首次提问时懒创建
        if self._sess()["acp_session_id"]:
            self._prepare_acp_session()

    def _prepare_acp_session(self) -> None:
        sess = self._sess()
        # cwd 永远固定为项目目录：所有会话在 Tran 里归到同一个可折叠分组；
        # 知识库走指令里的绝对路径，不靠 cwd（否则每个目录会散成不同分组）
        self._ensuring = True
        self._status("正在准备会话…")
        self.acp.ensure(sess["acp_session_id"], str(PROJECT_DIR))

    def _on_acp_ready(self, session_id: str) -> None:
        self._ensuring = False
        sess = self._sess()
        if session_id != sess["acp_session_id"]:
            sess["acp_session_id"] = session_id
            sess["instructed"] = False   # 新底层会话，首条消息要重发固定指令
            self.store.save()
        self._status(f"已连接 Kimi 会话 …{session_id[-8:]}")
        if self._pending_round is not None:
            text, png = self._pending_round
            self._pending_round = None
            self._send_acp(text, png)

    def _send_acp(self, text: str | None, png: bytes | None) -> None:
        self._ensure_acp()
        sess = self._sess()
        if not (sess["acp_session_id"] and self.acp.session_id == sess["acp_session_id"]):
            # 底层会话未就绪：先存下这轮，等 ready 后自动补发
            self._pending_round = (text, png)
            if not self._ensuring:
                self._prepare_acp_session()
            return
        blocks: list[dict] = []
        if png is not None:
            blocks.append({
                "type": "image",
                "data": base64.b64encode(png).decode(),
                "mimeType": "image/png",
            })
        body = text or "请处理这张屏幕截图。"
        if not sess.get("instructed"):
            body = (f"【固定指令】{self._instruction(sess)}\n"
                    f"（本会话后续所有截图和问题都按此指令处理，只输出最终答案）\n\n{body}")
            sess["instructed"] = True
            self.store.save()
        blocks.append({"type": "text", "text": body})
        self.acp.prompt(blocks)

    # -- 直连 API 引擎 --

    def _send_api(self, text: str | None, png: bytes | None) -> None:
        if png is not None:
            message = image_message(png, text or "请处理这张屏幕截图。")
        else:
            message = {"role": "user", "content": text}
        self.history.append(message)
        messages = [{"role": "system", "content": self.current_prompt()}] + self.history
        self.worker = ApiWorker(self.cfg, messages, self)
        self.worker.chunk.connect(self._on_chunk)
        self.worker.failed.connect(self._on_failed)
        self.worker.finished.connect(self._on_api_finished)
        self.worker.start()

    def _on_api_finished(self) -> None:
        if self.worker and self.worker.full:
            self.history.append({"role": "assistant", "content": self.worker.full})

    # -- 两种引擎共用的渲染回调 --

    def _on_chunk(self, delta: str) -> None:
        self._md_parts[-1] += delta
        self._render()

    def _on_failed(self, error: str) -> None:
        self._ensuring = False
        self._pending_round = None
        if self._md_parts:
            self._md_parts[-1] += f"\n\n> [请求失败] {error}"
            self._render()
        else:
            self._status(f"[失败] {error}", 8000)

    # ---- 设置项回调 ----

    def _persist(self) -> None:
        save_config(self.cfg)
        self.hotkeys.rebind(self.cfg)

    def on_backend_changed(self) -> None:
        self.cfg["backend"] = self.backend_box.currentData()
        self._persist()
        if self.cfg["backend"] == "acp":
            self._ensure_acp()

    def on_save_prompt(self) -> None:
        self.cfg["prompt"] = self.prompt_edit.toPlainText()
        self._persist()

    def on_shot_mode_changed(self) -> None:
        self.cfg["shot_mode"] = self.shot_mode_box.currentData()
        self._persist()
        self._apply_frame_visibility()

    def on_enabled_toggled(self, checked: bool) -> None:
        self.cfg["enabled"] = checked
        self._persist()
        self.hotkeys.set_enabled(checked)
        # 同步设置页和托盘两个入口
        self.enabled_box.blockSignals(True)
        self.enabled_box.setChecked(checked)
        self.enabled_box.blockSignals(False)
        self.tray_enabled_act.blockSignals(True)
        self.tray_enabled_act.setChecked(checked)
        self.tray_enabled_act.blockSignals(False)

    def on_mode_changed(self) -> None:
        for action, box in self._mode_boxes.items():
            self.cfg[f"{action}_mode"] = box.currentText()
        self._persist()

    def on_ui_opacity_changed(self, value: int) -> None:
        self.cfg["ui_opacity"] = value / 100
        self._apply_style()
        self._persist()

    def on_text_opacity_changed(self, value: int) -> None:
        self.cfg["text_opacity"] = value / 100
        self._apply_style()
        self._persist()

    def on_topmost_toggled(self, checked: bool) -> None:
        self.cfg["topmost"] = checked
        self._persist()
        # 置顶标志改动要重显窗口才生效
        was_visible = self.isVisible()
        self.setWindowFlag(Qt.WindowStaysOnTopHint, checked)
        if was_visible:
            self.show()

    def on_capture_toggled(self, checked: bool) -> None:
        self.cfg["exclude_capture"] = checked
        self._persist()
        set_exclude_from_capture(int(self.winId()), checked)

    def on_click_through_toggled(self, checked: bool) -> None:
        self.click_through = checked
        # 同步设置页和托盘两个入口的勾选状态，避免互相触发
        self.click_box.blockSignals(True)
        self.click_box.setChecked(checked)
        self.click_box.blockSignals(False)
        self.tray_click_act.blockSignals(True)
        self.tray_click_act.setChecked(checked)
        self.tray_click_act.blockSignals(False)
        set_click_through(int(self.winId()), checked)
        self._sync_wheel_hook()
        self._status("鼠标穿透已" + ("开启（滚轮仍可用）" if checked else "关闭"))

    # ---- 热键录制 ----

    def _start_record(self, target: str) -> None:
        self._recording_target = target
        self._key_labels[target].setText("请按下新热键…")
        self.hotkeys.start_record()

    def _on_key_recorded(self, scan: int, name: str) -> None:
        target = self._recording_target
        self.hotkeys._recording = False
        self.cfg[f"{target}_scan"] = scan
        self.cfg[f"{target}_name"] = name
        self._persist()
        self._key_labels[target].setText(f"当前：{name}")

    # ---- 显隐与退出 ----

    def toggle_visible(self) -> None:
        if self.isVisible() and not self.isMinimized():
            self.hide()
        else:
            self.showNormal()
            self.raise_()
            self.activateWindow()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if event.key() == Qt.Key_Escape:
            self.hide()
        else:
            super().keyPressEvent(event)

    def closeEvent(self, event) -> None:  # noqa: N802
        if self._quitting:
            event.accept()
        else:
            event.ignore()
            self.hide()  # 点关闭只是退到托盘

    def quit_app(self) -> None:
        self._quitting = True
        if self.acp is not None:
            self.acp.stop()
        QApplication.quit()
