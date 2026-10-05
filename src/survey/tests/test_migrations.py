from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql


DSN = os.environ.get("SURVEY_TEST_DSN")
ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "src/survey/migrations/001_initial.sql"


@unittest.skipUnless(DSN, "requires explicit local disposable SURVEY_TEST_DSN")
class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.database = "survey_proof_" + uuid4().hex
        self.admin = psycopg.conninfo.conninfo_to_dict(DSN)
        if self.admin.get("host") != "127.0.0.1":
            raise RuntimeError("Migration proof accepts only a disposable localhost database")
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8' TEMPLATE template0").format(sql.Identifier(self.database)))
        self.options = dict(self.admin, dbname=self.database)
        self.dsn = psycopg.conninfo.make_conninfo(**self.options)
        with psycopg.connect(self.dsn) as conn:
            conn.execute("CREATE TABLE public.request_events (id integer PRIMARY KEY,payload text)")
            conn.execute("INSERT INTO public.request_events VALUES (1,'preserved demo seed')")
            conn.execute("GRANT SELECT,INSERT ON public.request_events TO survey_test")

    def tearDown(self):
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(self.database)))

    def migrate(self, path=MIGRATION):
        return subprocess.run(["psql", self.dsn, "-X", "-v", "ON_ERROR_STOP=1",
                               "-v", "uami_name=survey_test", "-f", str(path)],
                              capture_output=True, text=True)

    def test_repeat_concurrent_migration_preserves_data_grants_and_runtime_ddl_denial(self):
        with psycopg.connect(self.dsn) as conn:
            before = conn.execute("SELECT relacl::text FROM pg_class WHERE oid='public.request_events'::regclass").fetchone()
        with ThreadPoolExecutor(max_workers=2) as workers:
            outputs = list(workers.map(lambda _: self.migrate(), range(2)))
        self.assertEqual([r.returncode for r in outputs], [0, 0])
        self.assertEqual(self.migrate().returncode, 0)
        with psycopg.connect(self.dsn) as conn:
            self.assertEqual(conn.execute("SELECT * FROM public.request_events").fetchall(), [(1, "preserved demo seed")])
            self.assertEqual(conn.execute("SELECT relacl::text FROM pg_class WHERE oid='public.request_events'::regclass").fetchone(), before)
            self.assertEqual(conn.execute("SELECT version FROM survey.schema_migrations").fetchall(), [(1,)])
        with psycopg.connect(**dict(self.options, user="survey_test")) as conn:
            conn.execute("SELECT * FROM survey.surveys")
            conn.execute("SELECT version FROM survey.schema_migrations")
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute("CREATE TABLE survey.forbidden (id int)")

    def test_failure_rolls_back_entire_migration(self):
        for failing_sql in ("SELECT 1/0;", "GRANT SELECT ON survey.surveys TO no_such_role;"):
            with self.subTest(failure=failing_sql.split()[0]):
                with tempfile.NamedTemporaryFile(mode="w", suffix=".sql") as file:
                    file.write(MIGRATION.read_text().replace("INSERT INTO survey.schema_migrations", failing_sql + "\nINSERT INTO survey.schema_migrations"))
                    file.flush()
                    self.assertNotEqual(self.migrate(Path(file.name)).returncode, 0)
                with psycopg.connect(self.dsn) as conn:
                    self.assertIsNone(conn.execute("SELECT to_regnamespace('survey')").fetchone()[0])
                    self.assertEqual(conn.execute("SELECT count(*) FROM public.request_events").fetchone()[0], 1)

    def test_existing_hook_survey_only_does_not_bootstrap_demo(self):
        env = dict(os.environ, PGHOST="127.0.0.1", PGPORT=self.admin["port"],
                   PGDATABASE=self.database, PGUSER=self.admin.get("user", os.environ["USER"]),
                   AZURE_IDENTITY_NAME="survey_test")
        result = subprocess.run(["bash", str(ROOT / "scripts/hooks/postprovision.sh"), "--survey-only"],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SURVEY_MIGRATION_OK version=1", result.stdout)
