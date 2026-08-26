"""本地会话列表（sessions.json）：一个本地会话 = 一个底层 ACP 会话 + 可选知识库目录。

知识库原理：底层 ACP 会话的 cwd 固定为项目目录（保证 Tran 里只有一个分组），
知识库目录以绝对路径写进固定指令，Agent 用自带文件工具按需查阅该目录。
"""

import json
import uuid

from config import DATA_DIR

SESSIONS_PATH = DATA_DIR / "sessions.json"


class SessionStore:
    def __init__(self) -> None:
        self.data = {"current": "", "sessions": []}
        if SESSIONS_PATH.exists():
            self.data.update(json.loads(SESSIONS_PATH.read_text(encoding="utf-8")))

    @classmethod
    def migrate(cls, cfg: dict) -> "SessionStore":
        """首次运行：把 config.toml 里已有的 ACP 会话迁成默认会话。"""
        store = cls()
        if not store.data["sessions"]:
            store.add("默认会话",
                      acp_session_id=cfg.get("acp_session_id", ""),
                      instructed=bool(cfg.get("acp_session_id")))
        return store

    def save(self) -> None:
        SESSIONS_PATH.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    def all(self) -> list[dict]:
        return self.data["sessions"]

    def current(self) -> dict | None:
        for s in self.data["sessions"]:
            if s["id"] == self.data["current"]:
                return s
        return self.data["sessions"][0] if self.data["sessions"] else None

    def set_current(self, session_id: str) -> None:
        self.data["current"] = session_id
        self.save()

    def add(self, name: str, kb_dir: str = "", acp_session_id: str = "",
            instructed: bool = False) -> dict:
        session = {
            "id": uuid.uuid4().hex[:8],
            "name": name,
            "kb_dir": kb_dir,
            "acp_session_id": acp_session_id,
            "instructed": instructed,
        }
        self.data["sessions"].append(session)
        self.data["current"] = session["id"]
        self.save()
        return session
