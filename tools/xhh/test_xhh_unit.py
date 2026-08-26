import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent))

import xhh
import xhh_daemon
import xhh_tui


class FakeResponse:
    def __init__(self, data, content_length=None):
        self._data = io.BytesIO(data)
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size=-1):
        return self._data.read(size)


class FakeReader:
    def __init__(self, payload):
        self.payload = payload

    async def readline(self):
        return (json.dumps(self.payload) + "\n").encode()


class FakeWriter:
    def __init__(self):
        self.data = b""

    def write(self, data):
        self.data += data

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


class XhhUnitTests(unittest.IsolatedAsyncioTestCase):
    async def test_attach_reuses_one_session_for_same_target(self):
        class FakeCdp:
            _xhh_session = None
            _xhh_target_id = None

            def __init__(self):
                self.attach_count = 0

            async def call(self, method, params=None, session=None):
                if method == "Target.getTargets":
                    return {"targetInfos": [{"type": "page", "url": xhh.HOME_URL, "targetId": "t1"}]}
                if method == "Target.attachToTarget":
                    self.attach_count += 1
                    return {"sessionId": "s1"}
                raise AssertionError(method)

        cdp = FakeCdp()
        self.assertEqual(await xhh.attach_xhh_tab(cdp), "s1")
        self.assertEqual(await xhh.attach_xhh_tab(cdp), "s1")
        self.assertEqual(cdp.attach_count, 1)

    async def test_comments_navigate_back_to_requested_post(self):
        cdp = AsyncMock()
        cdp._xhh_session = "s1"
        cdp._xhh_target_id = "t1"
        cdp.call.return_value = {
            "targetInfos": [{"type": "page", "url": xhh.HOME_URL, "targetId": "t1"}]
        }
        cdp.eval_js.side_effect = [
            "https://www.xiaoheihe.cn/app/bbs/link/111111",
            json.dumps({"total": "0", "comments": []}),
        ]
        cdp.eval_await_js.return_value = 0
        with patch.object(xhh, "goto_and_wait", new=AsyncMock(return_value=True)) as navigate:
            await xhh.fetch_post_comments(cdp, "222222")
        navigate.assert_awaited_once()
        self.assertEqual(navigate.await_args.args[2], xhh.POST_URL.format("222222"))

    async def test_daemon_reconnects_and_replays_current_command(self):
        class FakeClosed(Exception):
            pass

        cdp = AsyncMock()
        expected = {"ok": True, "data": [1]}
        with (
            patch.object(xhh_daemon, "ConnectionClosed", FakeClosed),
            patch.object(
                xhh_daemon,
                "dispatch",
                new=AsyncMock(side_effect=[FakeClosed(), expected]),
            ),
        ):
            result = await xhh_daemon.dispatch_with_reconnect({"cmd": "feed"}, cdp)
        self.assertEqual(result, expected)
        cdp.connect.assert_awaited_once()

    async def test_daemon_rejects_missing_token(self):
        writer = FakeWriter()
        await xhh_daemon.handle(
            FakeReader({"cmd": "feed"}),
            writer,
            AsyncMock(),
            asyncio.Lock(),
            "secret-token",
            asyncio.Event(),
        )
        response = json.loads(writer.data.decode())
        self.assertEqual(response["code"], "UNAUTHORIZED")

    async def test_daemon_serializes_complete_browser_transactions(self):
        active = 0
        max_active = 0

        async def fake_dispatch(_req, _cdp):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.03)
            active -= 1
            return {"ok": True, "data": []}

        token = "secret-token"
        lock = asyncio.Lock()
        with patch.object(xhh_daemon, "dispatch_with_reconnect", new=fake_dispatch):
            await asyncio.gather(
                xhh_daemon.handle(
                    FakeReader({"cmd": "feed", "token": token}),
                    FakeWriter(),
                    AsyncMock(),
                    lock,
                    token,
                    asyncio.Event(),
                ),
                xhh_daemon.handle(
                    FakeReader({"cmd": "feed", "token": token}),
                    FakeWriter(),
                    AsyncMock(),
                    lock,
                    token,
                    asyncio.Event(),
                ),
            )
        self.assertEqual(max_active, 1)

    async def test_daemon_preserves_captcha_error_code(self):
        writer = FakeWriter()
        with patch.object(
            xhh_daemon,
            "dispatch_with_reconnect",
            new=AsyncMock(side_effect=RuntimeError("CAPTCHA")),
        ):
            await xhh_daemon.handle(
                FakeReader({"cmd": "post_head", "pid": "123456", "token": "token"}),
                writer,
                AsyncMock(),
                asyncio.Lock(),
                "token",
                asyncio.Event(),
            )
        self.assertEqual(json.loads(writer.data.decode())["code"], "CAPTCHA")

    async def test_tui_mounts_comment_images(self):
        content = AsyncMock()
        image_no = await xhh_tui.mount_comment_images(
            content,
            {"images": ["https://example.test/1.jpg", "https://example.test/2.jpg"]},
            3,
            80,
        )
        self.assertEqual(image_no, 5)
        self.assertEqual(content.mount.await_count, 2)
        mounted = [call.args[0] for call in content.mount.await_args_list]
        self.assertTrue(all(isinstance(block, xhh_tui.ImageBlock) for block in mounted))

    def test_download_rejects_declared_oversize(self):
        response = FakeResponse(b"small", xhh.MAX_IMAGE_BYTES + 1)
        with patch("urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "20MB"):
                xhh._download("https://example.test/image")

    def test_download_rejects_streamed_oversize(self):
        response = FakeResponse(b"x" * (xhh.MAX_IMAGE_BYTES + 1))
        with patch("urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "20MB"):
                xhh._download("https://example.test/image")


if __name__ == "__main__":
    unittest.main()
