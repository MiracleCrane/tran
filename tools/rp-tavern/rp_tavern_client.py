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


def _prompt_content(preset: dict, identifier: str) -> str:
    for prompt in preset.get("prompts", []):
        if prompt.get("identifier") == identifier and prompt.get("enabled", True):
            return str(prompt.get("content") or "")
    return ""


def _world_info(character: Character, corpus: str) -> str:
    book = character.data.get("character_book") or {}
    entries = book.get("entries") if isinstance(book, dict) else []
    if not isinstance(entries, list):
        return ""
    lowered = corpus.casefold()
    matched: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("enabled") is False:
            continue
        keys = entry.get("keys") or entry.get("key") or []
        if isinstance(keys, str):
            keys = [keys]
        constant = bool(entry.get("constant"))
        hit = constant or any(str(key).casefold() in lowered for key in keys if str(key).strip())
        if hit and entry.get("content"):
            matched.append(str(entry["content"]))
        if sum(map(len, matched)) >= 12_000:
            break
    return "\n\n".join(matched)


def build_messages(
    character: Character,
    chat: list[dict],
    runtime: RuntimeConfig,
    mode: GenerationMode,
    user_text: str = "",
) -> tuple[list[dict], str]:
    metadata = chat[0] if chat and "chat_metadata" in chat[0] else {}
    user_name = str(metadata.get("user_name") or runtime.settings.get("name1") or "用户")
    char_name = character.name
    history = [dict(item) for item in chat if "mes" in item and not item.get("is_system")]
    if mode == "retry" and history and not history[-1].get("is_user"):
        history.pop()

    corpus = "\n".join(str(item.get("mes") or "") for item in history[-20:]) + "\n" + user_text
    pieces = [
        _prompt_content(runtime.preset, "main"),
        str(character.data.get("system_prompt") or ""),
        f"角色名称：{char_name}\n角色设定：\n{character.data.get('description') or ''}",
        f"角色性格：\n{character.data.get('personality') or ''}",
        f"当前场景：\n{character.data.get('scenario') or ''}",
        _world_info(character, corpus),
    ]
    system_prompt = "\n\n".join(
        replace_macros(piece, user_name, char_name).strip() for piece in pieces if piece and piece.strip()
    )
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for item in history[-80:]:
        role = "user" if item.get("is_user") else "assistant"
        messages.append({"role": role, "content": str(item.get("mes") or "")})

    post_history = "\n\n".join(
        value for value in (
            _prompt_content(runtime.preset, "jailbreak"),
            str(character.data.get("post_history_instructions") or ""),
        ) if value.strip()
    )
    if post_history:
        messages.append({
            "role": "system",
            "content": replace_macros(post_history, user_name, char_name),
        })

    if mode == "normal":
        messages.append({"role": "user", "content": user_text})
    elif mode == "continue":
        nudge = runtime.preset.get("continue_nudge_prompt") or "自然续写上一条角色回复，不要重复已有内容。"
        messages.append({"role": "system", "content": replace_macros(str(nudge), user_name, char_name)})
    elif mode == "impersonate":
        prompt = runtime.preset.get("impersonation_prompt") or (
            "根据上下文，以{{user}}的身份拟一条自然、简洁、能推动剧情的下一句回复。"
            "只输出回复正文，不要解释，不要替{{char}}行动。"
        )
        messages.append({"role": "system", "content": replace_macros(str(prompt), user_name, char_name)})

    # Keep a bounded context even when a long-running chat contains huge messages.
    while len(messages) > 3 and sum(len(str(m["content"])) for m in messages) > 300_000:
        messages.pop(1)
    return messages, user_name


def append_exchange(chat: list[dict], user_name: str, character_name: str, user_text: str, reply: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    chat.append({"name": user_name, "is_user": True, "is_system": False, "send_date": now, "mes": user_text, "extra": {}})
    chat.append({
        "name": character_name,
        "is_user": False,
        "is_system": False,
        "send_date": now,
        "mes": reply,
        "extra": {},
        "swipes": [reply],
        "swipe_id": 0,
    })


def replace_last_assistant(chat: list[dict], reply: str) -> None:
    for item in reversed(chat):
        if "mes" not in item or item.get("is_user") or item.get("is_system"):
            continue
        old = str(item.get("mes") or "")
        swipes = list(item.get("swipes") or [old])
        if old and old not in swipes:
            swipes.append(old)
        swipes.append(reply)
        item["swipes"] = swipes
        item["swipe_id"] = len(swipes) - 1
        item["mes"] = reply
        return
    raise ValueError("当前对话没有可重试的角色回复")


def continue_last_assistant(chat: list[dict], continuation: str) -> None:
    for item in reversed(chat):
        if "mes" in item and not item.get("is_user") and not item.get("is_system"):
            combined = f"{str(item.get('mes') or '').rstrip()}\n{continuation.lstrip()}"
            item["mes"] = combined
            swipes = list(item.get("swipes") or [])
            swipe_id = int(item.get("swipe_id") or 0)
            if swipes and 0 <= swipe_id < len(swipes):
                swipes[swipe_id] = combined
            else:
                swipes = [combined]
                swipe_id = 0
            item["swipes"] = swipes
            item["swipe_id"] = swipe_id
            return
    raise ValueError("当前对话没有可续写的角色回复")


class TavernClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8000") -> None:
        self.base_url = base_url.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(180.0, connect=10.0))
        self._csrf_token: str | None = None

    async def close(self) -> None:
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
    ) -> tuple[str, str, RuntimeConfig]:
        runtime = await self.runtime_config()
        messages, user_name = build_messages(character, chat, runtime, mode, user_text)
        preset = runtime.preset
        body = {
            "chat_completion_source": runtime.source,
            "custom_url": runtime.url,
            "secret_id": runtime.secret_id,
            "model": runtime.model,
            "messages": messages,
            "temperature": preset.get("temp_openai", 1),
            "max_tokens": preset.get("openai_max_tokens", 1024),
            "top_p": preset.get("top_p_openai", 1),
            "top_k": preset.get("top_k_openai"),
            "presence_penalty": preset.get("pres_pen_openai", 0),
            "frequency_penalty": preset.get("freq_pen_openai", 0),
            "seed": preset.get("seed", -1),
            "stream": True,
            "custom_include_body": preset.get("custom_include_body", ""),
            "custom_exclude_body": preset.get("custom_exclude_body", ""),
            "custom_include_headers": preset.get("custom_include_headers", ""),
            "custom_prompt_post_processing": preset.get("custom_prompt_post_processing", "none"),
        }
        await self._ensure_csrf()
        chunks: list[str] = []
        non_sse_lines: list[str] = []
        async with self.http.stream(
            "POST",
            "/api/backends/chat-completions/generate",
            json=body,
            headers={"x-csrf-token": self._csrf_token or ""},
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    if line.strip():
                        non_sse_lines.append(line)
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                data = json.loads(payload)
                if data.get("error"):
                    raise RuntimeError(str(data["error"].get("message") or data["error"]))
                delta = ((data.get("choices") or [{}])[0].get("delta") or {})
                chunk = delta.get("content") or ""
                if chunk:
                    chunks.append(str(chunk))
                    if on_chunk:
                        await on_chunk("".join(chunks))
        text = "".join(chunks).strip()
        if not text:
            if non_sse_lines:
                try:
                    error_payload = json.loads("\n".join(non_sse_lines))
                    upstream_error = error_payload.get("error")
                    if isinstance(upstream_error, dict):
                        raise RuntimeError(str(upstream_error.get("message") or upstream_error))
                    if upstream_error:
                        raise RuntimeError(str(upstream_error))
                except json.JSONDecodeError:
                    pass
            raise RuntimeError("模型没有返回正文")
        return text, user_name, runtime
