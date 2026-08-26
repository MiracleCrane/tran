"""截图与模型调用的纯逻辑，不依赖 Qt。"""

import base64

import mss
import mss.tools
from openai import OpenAI

DEFAULT_PROMPT = (
    "你是屏幕问答助手。用户会发来屏幕截图，并可能附带追问。"
    "描述截图中与问题相关的内容；如果图中有待解答的题目，直接给出答案和简要解析。"
    "用简体中文回答，简洁为先。"
)


def screenshot_png(monitor: int = 1) -> bytes:
    """截取主显示器（monitors[1]；monitors[0] 是所有屏拼成的虚拟屏）。"""
    with mss.MSS() as sct:
        shot = sct.grab(sct.monitors[monitor])
        return mss.tools.to_png(shot.rgb, shot.size)


def screenshot_region_png(x: int, y: int, w: int, h: int) -> bytes:
    """按物理像素矩形抓屏，坐标基于虚拟桌面（可跨副屏，起点可为负）。"""
    with mss.MSS() as sct:
        shot = sct.grab({"left": x, "top": y, "width": w, "height": h})
        return mss.tools.to_png(shot.rgb, shot.size)


def make_client(cfg: dict) -> OpenAI:
    return OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"])


def image_message(png: bytes, text: str) -> dict:
    b64 = base64.b64encode(png).decode()
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
    }
