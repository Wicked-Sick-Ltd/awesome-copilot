"""Credential storage must not write the API key to disk."""

import os
import stat
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import namecheap


def _backend_type(module, name):
    class Backend:
        def __init__(self):
            self.saved = None
            self.stored = "from-keyring"

        def set_password(self, service, account, secret):
            self.saved = (service, account, secret)
            self.stored = secret

        def get_password(self, service, account):
            return self.stored

    Backend.__name__ = name
    Backend.__qualname__ = name
    Backend.__module__ = module
    return Backend


_SecretServiceKeyring = _backend_type("keyring.backends.SecretService", "Keyring")
_PlaintextKeyring = _backend_type("keyrings.alt.file", "PlaintextKeyring")


class _Chainer:
    def __init__(self, backends):
        self.backends = backends


_Chainer.__module__ = "keyring.backends.chainer"


def _keyring_module(backend):
    fake = unittest.mock.Mock()
    fake.get_keyring.return_value = backend
    return fake


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
        with unittest.mock.patch.dict(sys.modules, {"keyring": None}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        with open(self.path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(text, 'NAMECHEAP_API_USER="alice"\n')
        self.assertNotIn("super-secret", text)
        mode = stat.S_IMODE(os.stat(self.path).st_mode)
        self.assertEqual(mode & 0o077, 0)

    def test_save_uses_an_os_keyring_and_still_omits_the_key_from_disk(self):
        backend = _SecretServiceKeyring()
        fake = _keyring_module(backend)
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertTrue(stored)
        self.assertEqual(backend.saved, ("namecheap-api", "alice", "super-secret"))
        with open(self.path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("super-secret", text)
        self.assertNotIn("NAMECHEAP_API_KEY", text)

    def test_plaintext_keyring_is_not_used(self):
        fake = _keyring_module(_PlaintextKeyring())
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        with open(self.path, encoding="utf-8") as fh:
            self.assertNotIn("super-secret", fh.read())

    def test_does_not_claim_success_when_the_owning_backend_rejects_the_update(self):
        owner = _backend_type("keyring.backends.SecretService", "Keyring")()
        owner.stored = "old-key"

        def reject(service, account, secret):
            raise OSError("read-only")

        owner.set_password = reject
        later = _backend_type("keyring.backends.kwallet", "DBusKeyring")()
        fake = _keyring_module(_Chainer([owner, later]))
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        self.assertIsNone(later.saved)
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            _user, key = namecheap.load_config()
        self.assertEqual(key, "old-key")

    def test_get_continues_to_a_later_os_backend(self):
        empty = _backend_type("keyring.backends.SecretService", "Keyring")()
        empty.stored = None
        kwallet = _backend_type("keyring.backends.kwallet", "DBusKeyring")()
        kwallet.stored = "from-kwallet"
        fake = _keyring_module(_Chainer([empty, kwallet]))
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\n')
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-kwallet"))

    def test_chainer_skips_plaintext_and_uses_the_os_backend(self):
        secure = _SecretServiceKeyring()
        chainer = _Chainer([_PlaintextKeyring(), secure])
        fake = _keyring_module(chainer)
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertTrue(stored)
        self.assertEqual(secure.saved, ("namecheap-api", "alice", "super-secret"))

    def test_keyring_failure_does_not_fall_back_to_the_file(self):
        backend = _SecretServiceKeyring()
        backend.set_password = unittest.mock.Mock(side_effect=OSError("locked"))
        fake = _keyring_module(backend)
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            stored = namecheap.save_config("alice", "super-secret")
        self.assertFalse(stored)
        with open(self.path, encoding="utf-8") as fh:
            self.assertNotIn("super-secret", fh.read())

    def test_load_prefers_env_and_ignores_a_legacy_file_key(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\nNAMECHEAP_API_KEY="legacy"\n')
        os.environ["NAMECHEAP_API_KEY"] = "from-env"
        fake = _keyring_module(_SecretServiceKeyring())
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-env"))
        fake.get_keyring.assert_not_called()

    def test_load_uses_keyring_when_env_is_unset(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\n')
        backend = _SecretServiceKeyring()
        fake = _keyring_module(backend)
        with unittest.mock.patch.dict(sys.modules, {"keyring": fake}):
            user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-keyring"))

    def test_load_does_not_return_a_key_that_exists_only_in_the_file(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('NAMECHEAP_API_USER="alice"\nNAMECHEAP_API_KEY="legacy"\n')
        with unittest.mock.patch.dict(sys.modules, {"keyring": None}):
            user, key = namecheap.load_config()
        self.assertEqual(user, "alice")
        self.assertIsNone(key)

    def test_env_credentials_do_not_read_a_corrupt_config_file(self):
        with open(self.path, "wb") as fh:
            fh.write(b"\xff")
        os.environ["NAMECHEAP_API_USER"] = "alice"
        os.environ["NAMECHEAP_API_KEY"] = "from-env"
        user, key = namecheap.load_config()
        self.assertEqual((user, key), ("alice", "from-env"))


if __name__ == "__main__":
    unittest.main()
