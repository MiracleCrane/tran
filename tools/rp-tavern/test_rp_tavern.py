import json
import unittest

from rp_tavern_client import (
    Character,
    RuntimeConfig,
    append_exchange,
    build_messages,
    continue_last_assistant,
    replace_last_assistant,
    replace_macros,
)


def runtime() -> RuntimeConfig:
    return RuntimeConfig(
        source="custom",
        url="https://example.invalid/v1",
        model="model",
        secret_id="secret",
        preset={
            "prompts": [
                {"identifier": "main", "content": "全程中文，扮演{{char}}。"},
                {"identifier": "jailbreak", "content": "推动剧情。"},
            ],
            "impersonation_prompt": "替{{user}}拟一句话。",
        },
        settings={"name1": "玩家"},
    )


class ClientLogicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.character = Character("Lana", "Lana.png", {
            "description": "朋友",
            "personality": "温柔",
            "scenario": "客厅",
            "character_book": {"entries": [{"keys": ["门铃"], "content": "门外有人。", "enabled": True}]},
        })
        self.chat = [
            {"chat_metadata": {}, "user_name": "等风来", "character_name": "Lana"},
            {"name": "等风来", "is_user": True, "mes": "门铃响了"},
            {"name": "Lana", "is_user": False, "mes": "我去看看。"},
        ]

    def test_replace_macros(self) -> None:
        self.assertEqual(replace_macros("{{user}}和{{char}}", "甲", "乙"), "甲和乙")

    def test_normal_prompt_contains_character_history_and_world_info(self) -> None:
        messages, user = build_messages(self.character, self.chat, runtime(), "normal", "等等")
        self.assertEqual(user, "等风来")
        self.assertIn("全程中文", messages[0]["content"])
        self.assertIn("门外有人", messages[0]["content"])
        self.assertEqual(messages[-1], {"role": "user", "content": "等等"})

    def test_retry_removes_last_assistant_from_prompt(self) -> None:
        messages, _ = build_messages(self.character, self.chat, runtime(), "retry")
        self.assertNotIn("我去看看。", [item["content"] for item in messages])

    def test_help_answer_uses_user_identity(self) -> None:
        messages, _ = build_messages(self.character, self.chat, runtime(), "impersonate")
        self.assertEqual(messages[-1]["content"], "替等风来拟一句话。")

    def test_chat_mutations_preserve_swipes(self) -> None:
        append_exchange(self.chat, "等风来", "Lana", "你好", "你好呀")
        replace_last_assistant(self.chat, "晚上好")
        self.assertEqual(self.chat[-1]["mes"], "晚上好")
        self.assertEqual(self.chat[-1]["swipes"], ["你好呀", "晚上好"])
        continue_last_assistant(self.chat, "我们出去走走。")
        self.assertIn("出去走走", self.chat[-1]["mes"])
        self.assertEqual(self.chat[-1]["swipes"][self.chat[-1]["swipe_id"]], self.chat[-1]["mes"])


class RuntimeConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_connection_uses_its_bound_preset(self) -> None:
        from rp_tavern_client import TavernClient

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


if __name__ == "__main__":
    unittest.main()
