"""A small client interface over SillyTavern's localhost endpoints.

The TUI never reads or stores plaintext API keys. Generation goes back through
SillyTavern, which resolves the selected secret and applies its request proxy.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Callable, Literal

import httpx

from rp_tavern_engine import SillyTavernBrowserEngine

GenerationMode = Literal["normal", "retry", "continue", "impersonate"]
ChunkHandler = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class Character:
    name: str
    avatar: str
    data: dict
    last_chat_at: float = 0


@dataclass(frozen=True)
class ChatRef:
    file_id: str
    file_name: str


@dataclass(frozen=True)
class RuntimeConfig:
    source: str
    url: str
    model: str
    secret_id: str | None
    preset: dict
    settings: dict


def replace_macros(value: str, user_name: str, character_name: str) -> str:
    return (
        (value or "")
        .replace("{{user}}", user_name)
        .replace("{{char}}", character_name)
        .replace("<USER>", user_name)
        .replace("<BOT>", character_name)
    )


class TavernClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8000") -> None:
        self.base_url = base_url.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(180.0, connect=10.0))
        self._csrf_token: str | None = None
        self.engine = SillyTavernBrowserEngine(self.base_url)

    async def close(self) -> None:
        await self.engine.close()
        await self.http.aclose()

    async def _ensure_csrf(self) -> None:
        if self._csrf_token:
            return
        response = await self.http.get("/csrf-token")
        response.raise_for_status()
        self._csrf_token = str(response.json()["token"])

    async def _post(self, path: str, body: dict) -> object:
        await self._ensure_csrf()
        response = await self.http.post(path, json=body, headers={"x-csrf-token": self._csrf_token or ""})
        if response.status_code == 403:
            self._csrf_token = None
            await self._ensure_csrf()
            response = await self.http.post(path, json=body, headers={"x-csrf-token": self._csrf_token or ""})
        response.raise_for_status()
        return response.json()

    async def health(self) -> bool:
        try:
            response = await self.http.get("/", timeout=3.0)
            return response.is_success
        except httpx.HTTPError:
            return False

    async def prepare_generation(self) -> None:
        await self.engine.start()

    async def list_characters(self) -> list[Character]:
        data = await self._post("/api/characters/all", {})
        characters = [
            Character(
                str(item["name"]),
                str(item["avatar"]),
                dict(item.get("data") or {}),
                float(item.get("date_last_chat") or 0),
            )
            for item in data if isinstance(item, dict) and item.get("name") and item.get("avatar")
        ]
        return sorted(characters, key=lambda item: (-item.last_chat_at, item.name.casefold()))

    async def get_character(self, avatar: str) -> Character:
        item = await self._post("/api/characters/get", {"avatar_url": avatar})
        return Character(
            str(item["name"]),
            str(item["avatar"]),
            dict(item.get("data") or {}),
            float(item.get("date_last_chat") or 0),
        )

    async def list_chats(self, character: Character) -> list[ChatRef]:
        data = await self._post("/api/characters/chats", {"avatar_url": character.avatar, "simple": True})
        if not isinstance(data, list):
            return []
        refs = [ChatRef(str(item["file_id"]), str(item["file_name"])) for item in data if item.get("file_id")]
        return sorted(refs, key=lambda item: item.file_name, reverse=True)

    async def load_chat(self, character: Character, ref: ChatRef) -> list[dict]:
        data = await self._post("/api/chats/get", {"avatar_url": character.avatar, "file_name": ref.file_id})
        if not isinstance(data, list):
            raise RuntimeError("酒馆返回了无效的聊天记录")
        self.active_chat_id = ref.file_id
        return [dict(item) for item in data if isinstance(item, dict)]

    async def create_chat(self, character: Character) -> tuple[ChatRef, list[dict]]:
        now = datetime.now()
        file_id = f"{character.name} - {now.strftime('%Y-%m-%d@%Hh%Mm%Ss%f')[:-3]}ms"
        metadata = {"chat_metadata": {}, "user_name": "用户", "character_name": character.name}
        chat = [metadata]
        first_message = str(character.data.get("first_mes") or "").strip()
        if first_message:
            chat.append({
                "name": character.name,
                "is_user": False,
                "is_system": False,
                "send_date": now.strftime("%Y-%m-%d %H:%M:%S"),
                "mes": replace_macros(first_message, "用户", character.name),
                "extra": {},
                "swipes": [first_message],
                "swipe_id": 0,
            })
        ref = ChatRef(file_id, f"{file_id}.jsonl")
        await self.save_chat(character, ref, chat)
        self.active_chat_id = ref.file_id
        return ref, chat

    async def save_chat(self, character: Character, ref: ChatRef, chat: list[dict]) -> None:
        result = await self._post("/api/chats/save", {
            "avatar_url": character.avatar,
            "file_name": ref.file_id,
            "chat": chat,
            "force": False,
        })
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError(f"聊天保存失败：{result}")

    async def runtime_config(self) -> RuntimeConfig:
        settings_payload = await self._post("/api/settings/get", {})
        settings = json.loads(settings_payload["settings"])
        manager = settings.get("extension_settings", {}).get("connectionManager", {})
        selected_id = manager.get("selectedProfile")
        profile = next((p for p in manager.get("profiles", []) if p.get("id") == selected_id), {})
        preset_name = str(profile.get("preset") or settings.get("preset_settings_openai") or "Default")
        preset_names = list(settings_payload.get("openai_setting_names") or [])
        preset_values = list(settings_payload.get("openai_settings") or [])
        preset = dict(settings.get("oai_settings") or {})
        if preset_name in preset_names:
            raw = preset_values[preset_names.index(preset_name)]
            preset = json.loads(raw) if isinstance(raw, str) else dict(raw)

        oai = settings.get("oai_settings", {})
        source = str(profile.get("api") or oai.get("chat_completion_source") or "custom")
        url = str(profile.get("api-url") or oai.get("custom_url") or "")
        model = str(profile.get("model") or oai.get("custom_model") or "")
        secret_id = profile.get("secret-id")
        if not secret_id:
            states = await self._post("/api/secrets/read", {})
            custom_states = states.get("api_key_custom") if isinstance(states, dict) else []
            active = next((item for item in custom_states or [] if item.get("active")), None)
            secret_id = active.get("id") if active else None
        if not url or not model:
            raise RuntimeError("当前酒馆连接配置缺少 URL 或模型，请按 F9 在网页中设置")
        return RuntimeConfig(source, url, model, str(secret_id) if secret_id else None, preset, settings)

    async def generate(
        self,
        character: Character,
        chat: list[dict],
        mode: GenerationMode,
        user_text: str = "",
        on_chunk: ChunkHandler | None = None,
    ) -> tuple[str, str, RuntimeConfig, list[dict]]:
        runtime = await self.runtime_config()
        result = await self.engine.generate(
            character.avatar,
            self._chat_id(character, chat),
            mode,
            user_text,
            on_chunk,
        )
        return result.text, result.user_name, runtime, result.chat

    def _chat_id(self, character: Character, chat: list[dict]) -> str:
        metadata = chat[0] if chat and isinstance(chat[0], dict) else {}
        chat_id = metadata.get("chat_metadata", {}).get("chat_id") if isinstance(metadata.get("chat_metadata"), dict) else None
        if chat_id:
            return str(chat_id)
        # SillyTavern metadata normally omits the file name. The active character
        # carries it, and list/load callers set this hint before generation.
        hinted = getattr(self, "active_chat_id", None)
        if hinted:
            return str(hinted)
        raise RuntimeError(f"当前对话缺少文件标识：{character.name}")
