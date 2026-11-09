"""Credential storage must not write the API key to disk."""

import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import namecheap


class CredentialStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "namecheap-api")
        self._config = namecheap.CONFIG_FILE
        namecheap.CONFIG_FILE = self.path
        self._saved = {
            key: os.environ.pop(key, None)
            for key in ("NAMECHEAP_API_USER", "NAMECHEAP_API_KEY")
        }

    def tearDown(self):
        namecheap.CONFIG_FILE = self._config
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def test_save_writes_username_only_with_mode_0600(self):
        with mock.patch.dict(sys.modules, {"keyring": None}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        with open(self.path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(text, 'NAMECHEAP_API_USER="alice"\n')
        self.assertNotIn("super-secret", text)
        mode = stat.S_IMODE(os.stat(self.path).st_mode)
        self.assertEqual(mode & 0o077, 0)

    def test_save_uses_keyring_and_still_omits_the_key_from_disk(self):
        fake = mock.Mock()
        with mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertTrue(stored)
        fake.set_password.assert_called_once_with("namecheap-api", "alice", "super-secret")
        with open(self.path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("super-secret", text)
        self.assertNotIn("NAMECHEAP_API_KEY", text)

    def test_keyring_failure_does_not_fall_back_to_the_file(self):
        fake = mock.Mock()
        fake.set_password.side_effect = OSError("locked")
        with mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        with open(self.path, encoding="utf-8") as fh:
            self.assertNotIn("super-secret", fh.read())

    def test_load_prefers_env_and_ignores_a_legacy_file_key(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\nNAMECHEAP_API_KEY="legacy"\n')
        os.environ["NAMECHEAP_API_KEY"] = "from-env"
        fake = mock.Mock()
        fake.get_password.return_value = "from-keyring"
        with mock.patch.dict(sys.modules, {"keyring": fake}):
            user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-env"))
        fake.get_password.assert_not_called()

    def test_load_uses_keyring_when_env_is_unset(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\n')
        fake = mock.Mock()
        fake.get_password.return_value = "from-keyring"
        with mock.patch.dict(sys.modules, {"keyring": fake}):
            user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-keyring"))
        fake.get_password.assert_called_once_with("namecheap-api", "alice")

    def test_load_does_not_return_a_key_that_exists_only_in_the_file(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\nNAMECHEAP_API_KEY="legacy"\n')
        with mock.patch.dict(sys.modules, {"keyring": None}):
            user, key = namecheap.load_config()
        self.assertEqual(user, "alice")
        self.assertIsNone(key)


if __name__ == "__main__":
    unittest.main()
