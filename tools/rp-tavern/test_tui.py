import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rich.console import Console
from textual.widgets import TextArea

from rp_tavern_client import Character, ChatRef, RuntimeConfig
from rp_tavern_tui import (
    TavernApp,
    load_boss_key,
    message_log_line,
    message_log_lines,
    render_message,
    save_boss_key,
    validate_boss_key,
)


class FakeClient:
    def __init__(self) -> None:
        self.character = Character("Lana", "Lana.png", {"description": "测试角色"}, 1)
        self.ref = ChatRef("lzc-test-chat", "lzc-test-chat.jsonl")
        self.chat = [
            {"chat_metadata": {}, "user_name": "玩家", "character_name": "Lana"},
            {"name": "玩家", "is_user": True, "is_system": False, "mes": "你好"},
            {
                "name": "Lana",
                "is_user": False,
                "is_system": False,
                "mes": "*她轻轻点头* 你好呀",
                "swipes": ["*她轻轻点头* 你好呀"],
                "swipe_id": 0,
            },
        ]
        self.saved: list[list[dict]] = []
        self.closed = False

    async def close(self) -> None:
        self.closed = True

    async def health(self) -> bool:
        return True

    async def prepare_generation(self) -> None:
        return None

    async def list_characters(self):
        return [self.character]

    async def get_character(self, _avatar):
        return self.character

    async def list_chats(self, _character):
        return [self.ref]

    async def load_chat(self, _character, _ref):
        return copy.deepcopy(self.chat)

    async def save_chat(self, _character, _ref, chat):
        self.saved.append(copy.deepcopy(chat))

    async def runtime_config(self):
        return RuntimeConfig("custom", "https://api.x.ai/v1", "grok-4.3", "secret", {}, {})

    async def generate(self, _character, _chat, mode, _user_text="", on_chunk=None):
        values = {
            "normal": "普通回复",
            "impersonate": "帮答草稿",
            "retry": "重试回复",
            "continue": "续写段落",
        }
        updated = copy.deepcopy(_chat)
        if mode == "normal":
            updated.extend([
                {"name": "玩家", "is_user": True, "is_system": False, "mes": _user_text},
                {"name": "Lana", "is_user": False, "is_system": False, "mes": values[mode], "swipes": [values[mode]], "swipe_id": 0},
            ])
        elif mode == "retry":
            updated[-1]["mes"] = values[mode]
            updated[-1]["swipes"] = ["普通回复", values[mode]]
            updated[-1]["swipe_id"] = 1
        elif mode == "continue":
            updated[-1]["mes"] = f"{updated[-1]['mes']}\n{values[mode]}"
            updated[-1]["swipes"][updated[-1].get("swipe_id", 0)] = updated[-1]["mes"]
        if on_chunk:
            await on_chunk("流式片段")
        return values[mode], "玩家", await self.runtime_config(), updated


async def wait_until(pilot, predicate, attempts=40):
    for _ in range(attempts):
        if predicate():
            return
        await pilot.pause(0.05)
    raise AssertionError("condition was not reached")


class TuiHelperTests(unittest.TestCase):
    def test_markdown_action_markers_are_rendered_not_printed(self) -> None:
        console = Console(record=True, width=80, force_terminal=False)
        console.print(render_message({"name": "Lana", "is_user": False, "mes": "*她轻轻点头* 你好"}))
        rendered = console.export_text(styles=False)
        self.assertIn("她轻轻点头", rendered)
        self.assertNotIn("*她轻轻点头*", rendered)

    def test_roles_have_distinct_muted_colors_and_log_separators(self) -> None:
        user = {"name": "玩家", "is_user": True, "mes": "你好", "send_date": "2026-09-01 09:47:58.885"}
        assistant = {"name": "Lana", "is_user": False, "mes": "你好呀", "send_date": "2026-09-01 09:47:59.1"}
        user_group = render_message(user, 7)
        assistant_group = render_message(assistant, 8)
        self.assertNotEqual(str(user_group.renderables[-2].style), str(assistant_group.renderables[-2].style))
        self.assertIn("DEBUG request.dispatch seq=0007", message_log_line(user, 7).plain)
        self.assertIn("INFO  response.commit seq=0008", message_log_line(assistant, 8).plain)
        self.assertIn("[09:47:58.885]", message_log_line(user, 7).plain)
        self.assertIn("[09:47:59.100]", message_log_line(assistant, 8).plain)
        self.assertGreaterEqual(len(message_log_lines(user, 7)), 3)
        self.assertGreaterEqual(len(message_log_lines(assistant, 8)), 3)
        self.assertTrue(any("WARN" in line.plain and "recovered" in line.plain for line in message_log_lines(user, 9)))

    def test_boss_key_validation_and_persistence_support_mouse(self) -> None:
        self.assertEqual(validate_boss_key(" Ctrl+B "), "ctrl+b")
        self.assertEqual(validate_boss_key("mouse4"), "mouse4")
        self.assertEqual(validate_boss_key("mouse5"), "mouse5")
        self.assertEqual(validate_boss_key("middle"), "middle")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            save_boss_key(path, "mouse5")
            self.assertEqual(load_boss_key(path), "mouse5")


class TuiWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_actions_boss_mode_and_remap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            app = TavernApp("http://127.0.0.1:8000", boss_key="f12", config_path=config_path)
            fake = FakeClient()
            app.client = fake
            with patch("rp_tavern_tui.webbrowser.open") as open_web, patch("rp_tavern_tui.activate_console_window"):
                async with app.run_test(size=(120, 36)) as pilot:
                    await wait_until(pilot, lambda: app.chat_ref is not None)
                    self.assertEqual(app.character.name, "Lana")

                    await pilot.press("f2")
                    await wait_until(pilot, lambda: app.query_one("#input", TextArea).text == "帮答草稿")

                    field = app.query_one("#input", TextArea)
                    field.load_text("第一行")
                    field.action_cursor_line_end()
                    field.focus()
                    await pilot.press("shift+enter")
                    self.assertIn("\n", field.text)
                    field.insert("第二行")
                    await pilot.press("enter")
                    await wait_until(pilot, lambda: app.chat[-1].get("mes") == "普通回复")
                    self.assertEqual(app.chat[-2]["mes"], "第一行\n第二行")
                    self.assertIs(app.focused, field)

                    await pilot.press("f4")
                    await wait_until(pilot, lambda: app.chat[-1].get("mes") == "重试回复")
                    self.assertEqual(app.chat[-1]["swipes"], ["普通回复", "重试回复"])

                    await pilot.press("f3")
                    await wait_until(pilot, lambda: "续写段落" in app.chat[-1].get("mes", ""))
                    self.assertEqual(len(fake.saved), 0)

                    await pilot.press("f9")
                    open_web.assert_called_once_with("http://127.0.0.1:8000")

                    await pilot.press("f12")
                    self.assertTrue(app.decoy_mode)
                    self.assertTrue(app.screen.has_class("decoy"))
                    await pilot.press("f12")
                    self.assertFalse(app.decoy_mode)

                    field.load_text("/bosskey ctrl+b")
                    field.focus()
                    await pilot.press("enter")
                    await wait_until(pilot, lambda: app.boss_key == "ctrl+b")
                    self.assertEqual(load_boss_key(config_path), "ctrl+b")
                    await pilot.press("ctrl+b")
                    self.assertTrue(app.decoy_mode)
                    app.action_boss()
                    self.assertFalse(app.decoy_mode)

                    app.boss_key = "mouse4"
                    with patch("rp_tavern_tui.set_console_title"), patch(
                        "rp_tavern_tui.ctypes.windll.user32.GetAsyncKeyState",
                        return_value=0x8000,
                    ):
                        app.poll_boss_mouse()
                        self.assertTrue(app.decoy_mode)
                        app.poll_boss_mouse()
                        self.assertTrue(app.decoy_mode, "按住侧键不应反复切换")
                    with patch(
                        "rp_tavern_tui.ctypes.windll.user32.GetAsyncKeyState",
                        return_value=0,
                    ):
                        app.poll_boss_mouse()
                        self.assertFalse(app.mouse_boss_down)
            self.assertTrue(fake.closed)


if __name__ == "__main__":
    unittest.main()
