# 随包分发的第三方字体

Tran 只随包分发一款字体：**JetBrains Mono**（等宽，用于代码、diff、终端输出）。
界面字体不打包，跟随系统——这是刻意对齐 Codex 桌面版的行为（它在 Windows 上就是
Segoe UI + 系统中文字体）。

| 字体 | 用途 | 版权 | 许可 |
|---|---|---|---|
| JetBrains Mono | 代码 / diff / 终端输出 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | OFL-1.1 |

- 来源：JetBrains 官方 v2.304 发布包的 `fonts/webfonts/`，**不是** Google Fonts 子集版
  （子集缺制表符，会让终端输出错列，详见 `cli/src/renderer/assets/fonts/fonts.css`）。
- 打包字重：400（Regular）、500（Medium），各约 92KB。
- 许可原文：`cli/src/renderer/assets/fonts/OFL.txt`，亦见 https://scripts.sil.org/OFL

SIL Open Font License 1.1 允许自由使用、修改与随软件分发（含商业用途），
限制是不得单独销售字体本身，且衍生字体不得使用保留字体名。
