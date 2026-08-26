"""config.toml 读写（扁平键值；含密钥，勿提交 git）。"""

import json
import os
import tomllib
from pathlib import Path


def _resolve_data_dir() -> Path:
    """运行期数据目录：代码目录可写就用代码目录；打包后代码在 Program Files
    （只读），落到 %APPDATA%\\screen-assist。"""
    here = Path(__file__).parent
    if os.access(here, os.W_OK):
        return here
    fallback = Path(os.environ.get("APPDATA", str(here))) / "screen-assist"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


DATA_DIR = _resolve_data_dir()
CONFIG_PATH = DATA_DIR / "config.toml"

DEFAULTS = {
    "backend": "acp",        # acp=挂 Kimi 会话（可用知识库）；api=直连 OpenAI 兼容接口
    "acp_session_id": "",    # ACP 模式上次使用的会话 ID，启动时自动续上
    "kimi_home": r"C:\LegacyD\Programs\kimi-code",  # Tran 的 KIMI_CODE_HOME，会话才会进 Tran 列表
    "base_url": "https://api.kimi.com/coding/v1",
    "api_key": "",
    "model": "k3",
    "prompt": "",            # 留空则用 core.DEFAULT_PROMPT
    "enabled": True,         # 截图热键总开关（关闭后隐藏热键仍可用）
    "shot_mode": "region_fixed",  # fullscreen=主屏全屏；region=每次圈选；region_fixed=固定区域
    "region": "",            # region_fixed 的固定区域 "x,y,w,h"（物理像素）
    "ui_opacity": 0.85,      # 界面背景不透明度 0.3~1.0
    "text_opacity": 1.0,     # 文字不透明度 0.3~1.0
    "topmost": True,         # 窗口置顶
    "exclude_capture": False,  # 从截图/录屏中排除本窗口
    "ask_scan": 0x4E,        # 截图提问热键：小键盘 +
    "ask_name": "小键盘 +",
    "ask_mode": "double",    # double=双击触发，single=单击
    "hide_scan": 0x4A,       # 一键隐藏热键：小键盘 -
    "hide_name": "小键盘 -",
    "hide_mode": "single",
    "frame_scan": 0x37,      # 区域框显隐热键：小键盘 *
    "frame_name": "小键盘 *",
    "frame_mode": "double",
    "frame_visible": True,   # 固定区域标识框是否显示
    "click_scan": 0x53,      # 鼠标穿透热键：小键盘 .
    "click_name": "小键盘 .",
    "click_mode": "double",
    "retry_scan": 0x52,      # 重试热键：小键盘 0
    "retry_name": "小键盘 0",
    "retry_mode": "double",
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    file_cfg: dict = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "rb") as f:
            file_cfg = tomllib.load(f)
        cfg.update(file_cfg)
    # 旧版整体不透明度键迁移为界面不透明度
    if "ui_opacity" not in file_cfg and "opacity" in file_cfg:
        cfg["ui_opacity"] = file_cfg["opacity"]
    return cfg


def save_config(cfg: dict) -> None:
    lines = ["# 本文件含密钥，勿提交 git"]
    for key, value in cfg.items():
        if key == "opacity":   # 旧键，已被 ui_opacity 取代，不再写回
            continue
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, str):
            rendered = json.dumps(value, ensure_ascii=False)
        elif isinstance(value, float):
            rendered = repr(round(value, 2))
        else:
            rendered = str(value)
        lines.append(f"{key} = {rendered}")
    CONFIG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
