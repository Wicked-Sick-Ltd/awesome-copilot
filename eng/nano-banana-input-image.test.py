"""Security regression tests for nano-banana-pro-openrouter input images."""

import base64
import importlib.util
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
JPEG_HEADER = b"\xff\xd8\xff\xe0"
WEBP_HEADER = b"RIFF\x00\x00\x00\x00WEBPVP8 "
PLACEHOLDER_SECRET = b"OPENROUTER_API_KEY=placeholder-not-a-real-key\n"


class RecordingCompletions:
    def __init__(self):
        self.requests = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        image = {"image_url": {"url": "data:image/png;base64," + base64.b64encode(PNG_HEADER).decode()}}
        message = types.SimpleNamespace(images=[image])
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


def load_generate_image_module(completions):
    openai_stub = types.ModuleType("openai")

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.chat = types.SimpleNamespace(completions=completions)

    openai_stub.OpenAI = FakeOpenAI
    sys.modules["openai"] = openai_stub

    module_path = (
        pathlib.Path(__file__).parents[1]
        / "skills"
        / "nano-banana-pro-openrouter"
        / "scripts"
        / "generate_image.py"
    )
    spec = importlib.util.spec_from_file_location("generate_image", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InputImageTests(unittest.TestCase):
    def setUp(self):
        self.completions = RecordingCompletions()
        self.module = load_generate_image_module(self.completions)
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.cwd = os.getcwd()
        os.chdir(self.dir)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()
        sys.modules.pop("openai", None)

    def write(self, name, data):
        path = self.dir / name
        path.write_bytes(data)
        return path

    def run_main(self, *input_images):
        argv = ["generate_image.py", "--prompt", "edit", "--filename", "out.png"]
        for image in input_images:
            argv += ["--input-image", str(image)]
        with mock.patch.object(sys, "argv", argv), mock.patch.dict(
            os.environ, {"OPENROUTER_API_KEY": "placeholder"}
        ):
            self.module.main()

    def sent_payloads(self):
        payloads = []
        for request in self.completions.requests:
            for message in request["messages"]:
                content = message["content"]
                if isinstance(content, list):
                    for part in content:
                        if part.get("type") == "image_url":
                            payloads.append(part["image_url"]["url"])
        return payloads

    def assert_rejected_without_request(self, *input_images):
        with self.assertRaises(SystemExit):
            self.run_main(*input_images)
        self.assertEqual(self.completions.requests, [])

    def test_env_file_is_not_uploaded(self):
        self.assert_rejected_without_request(self.write(".env", PLACEHOLDER_SECRET))

    def test_text_file_with_image_extension_is_not_uploaded(self):
        self.assert_rejected_without_request(self.write("photo.png", PLACEHOLDER_SECRET))

    def test_source_file_is_not_uploaded(self):
        self.assert_rejected_without_request(self.write("app.py", b"API_KEY = 'placeholder'\n"))

    def test_non_image_after_valid_image_aborts_whole_request(self):
        good = self.write("good.png", PNG_HEADER + b"\x00" * 16)
        bad = self.write("id_rsa", b"-----BEGIN PLACEHOLDER KEY-----\n")
        self.assert_rejected_without_request(good, bad)

    def test_oversized_image_is_not_uploaded(self):
        cap = getattr(self.module, "MAX_INPUT_IMAGE_BYTES", 20 * 1024 * 1024)
        big = self.write("big.png", PNG_HEADER + b"\x00" * cap)
        self.assert_rejected_without_request(big)

    def test_directory_is_rejected(self):
        self.assert_rejected_without_request(self.dir)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires mkfifo")
    def test_fifo_is_rejected_without_blocking(self):
        fifo = self.dir / "pipe.png"
        os.mkfifo(fifo)
        self.assert_rejected_without_request(fifo)

    def test_symlink_to_non_image_is_not_uploaded(self):
        target = self.write("credentials.json", b'{"token": "placeholder"}')
        link = self.dir / "link.png"
        link.symlink_to(target)
        self.assert_rejected_without_request(link)

    def test_valid_images_are_sent_with_sniffed_mime(self):
        png = self.write("a.jpg", PNG_HEADER + b"\x00" * 16)
        jpeg = self.write("b", JPEG_HEADER + b"\x00" * 16)
        webp = self.write("c.webp", WEBP_HEADER + b"\x00" * 16)
        self.run_main(png, jpeg, webp)
        payloads = self.sent_payloads()
        self.assertEqual(len(payloads), 3)
        self.assertTrue(payloads[0].startswith("data:image/png;base64,"))
        self.assertTrue(payloads[1].startswith("data:image/jpeg;base64,"))
        self.assertTrue(payloads[2].startswith("data:image/webp;base64,"))
        self.assertEqual(
            base64.b64decode(payloads[1].split(",", 1)[1]), JPEG_HEADER + b"\x00" * 16
        )


if __name__ == "__main__":
    unittest.main()
