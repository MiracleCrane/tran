# screen-assist — 屏幕问答助手

双击热键截图 → 视觉模型识别 → 会话式浮窗显示答案。
典型场景：屏幕上看到一道题/一段内容，不动键盘外的任何东西，
按一下热键就拿到答案。

## 运行

```bash
uv run python main.py
```

首次运行 uv 自动解析依赖（PySide6 / mss / keyboard / openai）。
关闭主窗口不会退出，程序退到系统托盘。

## 配置

复制 `config.example.toml` 为 `config.toml` 并填写：

```toml
base_url = "https://api.kimi.com/coding/v1"   # 任意 OpenAI 兼容接口
api_key  = "sk-填你的key"
model    = "k3"                                # 需要视觉能力
```

可选项（默认值见 `config.py` 的 DEFAULTS）：

| 键 | 说明 |
|---|---|
| `prompt` | 自定义系统提示词，留空用内置默认（识别截图内容、图中题目直接给答案和解析） |
| `opacity` | 浮窗不透明度 0.3~1.0 |
| `topmost` | 窗口置顶 |
| `exclude_capture` | 从截图/录屏中排除本窗口（防自己拍自己） |
| `ask_scan` / `ask_mode` | 截图提问热键扫描码与触发方式（默认：双击小键盘 `+`） |
| `hide_scan` / `hide_mode` | 一键隐藏热键（默认：单击小键盘 `-`） |

程序内「设置」页的改动会写回 `config.toml`。

## 使用

- **双击小键盘 `+`**：截取主屏 → 发给视觉模型 → 浮窗显示回答，
  可在浮窗里继续追问（多轮会话）
- **单击小键盘 `-`**：一键隐藏浮窗
- 支持区域截图（框选屏幕任意矩形，可跨副屏）

## 文件

```
main.py           入口（QApplication + 托盘）
gui.py            浮窗 UI（PySide6）
core.py           截图与模型调用纯逻辑（不依赖 Qt，可单测）
config.py         配置读写与默认值
acp_client.py     ACP 后端通道（可选）
region_picker.py  区域框选
screenmap.py      屏幕坐标映射
```
