"""Security regression tests for SQL identifier handling."""

import importlib.util
import json
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

    module_path = (
        pathlib.Path(__file__).parents[1]
        / "skills"
        / "sql-server-table-reconciliation"
        / "scripts"
        / "reconcile.py"
    )
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

    def test_extract_sql_is_static_and_uses_bind_placeholders(self):
        for sql in (self.reconcile.EXTRACT_TABLE_SQL, self.reconcile.EXTRACT_HASHES_SQL):
            self.assertIn("DECLARE @schema sysname = ?;", sql)
            self.assertIn("QUOTENAME(@schema)", sql)
            self.assertIn("QUOTENAME(@table)", sql)
            self.assertNotRegex(sql, r"\{[a-zA-Z_][a-zA-Z0-9_]*\}")

    def test_extract_table_binds_schema_table_and_pk_json(self):
        calls = []

        class FakeCursor:
            def execute(self, query, params=None):
                calls.append((query, params))

            def arrow(self):
                return "arrow"

        conn = types.SimpleNamespace(cursor=lambda: FakeCursor())
        result = self.reconcile.extract_table(conn, "dbo.Orders", ["OrderId", "LineNo"])

        self.assertEqual(result, "arrow")
        self.assertEqual(len(calls), 1)
        query, params = calls[0]
        self.assertIs(query, self.reconcile.EXTRACT_TABLE_SQL)
        self.assertEqual(params[0], "dbo")
        self.assertEqual(params[1], "Orders")
        self.assertEqual(json.loads(params[2]), ["OrderId", "LineNo"])

    def test_extract_hashes_binds_column_lists(self):
        calls = []

        class FakeCursor:
            def execute(self, query, params=None):
                calls.append((query, params))

            def arrow(self):
                return "hashes"

        conn = types.SimpleNamespace(cursor=lambda: FakeCursor())
        result = self.reconcile.extract_hashes(
            conn, "sales.Order Details", ["Id"], ["Amount", "Status"]
        )

        self.assertEqual(result, "hashes")
        query, params = calls[0]
        self.assertIs(query, self.reconcile.EXTRACT_HASHES_SQL)
        self.assertEqual(params[:2], ["sales", "Order Details"])
        self.assertEqual(json.loads(params[2]), ["Id"])
        self.assertEqual(json.loads(params[3]), ["Amount", "Status"])

    def test_identifier_json_rejects_empty_and_nul(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            self.reconcile.identifier_json([])
        with self.assertRaisesRegex(ValueError, "NUL"):
            self.reconcile.identifier_json(["ok", "bad\x00name"])


if __name__ == "__main__":
    unittest.main()
