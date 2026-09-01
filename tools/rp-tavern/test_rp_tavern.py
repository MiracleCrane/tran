import json
import unittest

from rp_tavern_client import Character, RuntimeConfig, TavernClient, replace_macros
from rp_tavern_engine import BrowserGenerationResult


class ClientLogicTests(unittest.TestCase):
    def test_replace_macros(self) -> None:
        self.assertEqual(replace_macros("{{user}}和{{char}}", "甲", "乙"), "甲和乙")


class RuntimeConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_connection_uses_its_bound_preset(self) -> None:
        client = TavernClient()
        settings = {
            "preset_settings_openai": "DMX preset",
            "oai_settings": {"custom_url": "https://dmx.invalid/v1", "custom_model": "dmx"},
            "extension_settings": {
                "connectionManager": {
                    "selectedProfile": "xai",
                    "profiles": [{
                        "id": "xai",
                        "api": "custom",
                        "api-url": "https://api.x.ai/v1",
                        "model": "grok-4.3",
                        "preset": "xAI preset",
                        "secret-id": "xai-secret",
                    }],
                }
            },
        }
        payload = {
            "settings": json.dumps(settings),
            "openai_setting_names": ["DMX preset", "xAI preset"],
            "openai_settings": [
                json.dumps({"custom_include_body": ""}),
                json.dumps({"custom_include_body": "reasoning_effort: none"}),
            ],
        }

        async def fake_post(path, _body):
            self.assertEqual(path, "/api/settings/get")
            return payload

        client._post = fake_post
        try:
            runtime_config = await client.runtime_config()
        finally:
            await client.close()
        self.assertEqual(runtime_config.url, "https://api.x.ai/v1")
        self.assertEqual(runtime_config.model, "grok-4.3")
        self.assertEqual(runtime_config.preset["custom_include_body"], "reasoning_effort: none")

    async def test_generation_delegates_to_original_browser_engine(self) -> None:
        client = TavernClient()
        character = Character("Lana", "Lana.png", {})
        chat = [{"chat_metadata": {}, "user_name": "玩家", "character_name": "Lana"}]
        updated = chat + [
            {"name": "玩家", "is_user": True, "mes": "我在外面"},
            {"name": "Lana", "is_user": False, "mes": "街边的风吹过来。"},
        ]
        calls = []

        class FakeEngine:
            async def generate(self, avatar, chat_id, mode, user_text, on_chunk):
                calls.append((avatar, chat_id, mode, user_text, on_chunk is not None))
                return BrowserGenerationResult("街边的风吹过来。", updated, "玩家")

            async def close(self):
                return None

        async def fake_runtime():
            return RuntimeConfig("custom", "https://api.x.ai/v1", "grok-4.3", "secret", {}, {})

        client.engine = FakeEngine()
        client.runtime_config = fake_runtime
        client.active_chat_id = "lzc-chat"
        try:
            text, user_name, runtime, returned_chat = await client.generate(
                character,
                chat,
                "normal",
                "我在外面",
                lambda _value: None,
            )
        finally:
            await client.close()
        self.assertEqual(calls, [("Lana.png", "lzc-chat", "normal", "我在外面", True)])
        self.assertEqual(text, "街边的风吹过来。")
        self.assertEqual(user_name, "玩家")
        self.assertEqual(runtime.model, "grok-4.3")
        self.assertEqual(returned_chat, updated)


if __name__ == "__main__":
    unittest.main()
