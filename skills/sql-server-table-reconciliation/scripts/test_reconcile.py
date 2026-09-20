"""Security regression tests for SQL identifier handling."""

import importlib.util
import pathlib
import sys
import types
import unittest


def load_reconcile_module():
    """Load reconcile.py without requiring its optional runtime dependencies."""
    for module_name in ("pandas", "pyarrow", "pyarrow.compute"):
        sys.modules.setdefault(module_name, types.ModuleType(module_name))

    mssql_python = types.ModuleType("mssql_python")
    mssql_python.connect = lambda _connection_string: None
    sys.modules.setdefault("mssql_python", mssql_python)

    module_path = pathlib.Path(__file__).with_name("reconcile.py")
    spec = importlib.util.spec_from_file_location("reconcile", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SqlIdentifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reconcile = load_reconcile_module()

    def test_identifier_closes_brackets_without_exposing_sql(self):
        self.assertEqual(
            self.reconcile.quote_identifier("Users]; DROP TABLE Audit;--"),
            "[Users]]; DROP TABLE Audit;--]",
        )

    def test_qualified_table_quotes_each_component(self):
        self.assertEqual(
            self.reconcile.quote_qualified_table("sales.Order Details"),
            "[sales].[Order Details]",
        )

    def test_qualified_table_rejects_extra_components(self):
        with self.assertRaisesRegex(ValueError, "schema.table"):
            self.reconcile.quote_qualified_table("server.database.schema.table")


if __name__ == "__main__":
    unittest.main()
