import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from instagram_reliability import ReliabilityLedger


UTC = timezone.utc


class ReliabilityLedgerTest(unittest.TestCase):
    def test_existing_database_is_migrated_with_alert_columns(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "jobs.sqlite3"
            connection = sqlite3.connect(path)
            connection.execute(
                """
                CREATE TABLE jobs (
                    job_id TEXT PRIMARY KEY,
                    account TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    source_key TEXT NOT NULL,
                    expected_at TEXT NOT NULL,
                    due_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    permalink TEXT,
                    last_error TEXT,
                    recovery_attempts INTEGER NOT NULL DEFAULT 0,
                    next_recovery_at TEXT,
                    first_seen_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    resolved_at TEXT
                )
                """
            )
            connection.commit()
            connection.close()

            ledger = ReliabilityLedger(path)
            try:
                columns = {
                    row["name"]
                    for row in ledger.connection.execute(
                        "PRAGMA table_info(jobs)"
                    ).fetchall()
                }
                self.assertTrue(
                    {"alert_stage", "alerted_at", "policy_cancelled"} <= columns
                )
                now = datetime(2026, 9, 7, 1, 0, tzinfo=UTC)
                item = ledger.sync(
                    job_id="legacy:job",
                    account="legacy",
                    content_type="post",
                    source_key="legacy",
                    expected_at=now - timedelta(hours=2),
                    due_at=now - timedelta(hours=1),
                    published=False,
                    now=now,
                )
                self.assertEqual(item["status"], "missing")
            finally:
                ledger.close()

    def test_expected_job_becomes_missing_then_published(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = ReliabilityLedger(Path(temporary) / "jobs.sqlite3")
            due = datetime(2026, 8, 31, 1, 0, tzinfo=UTC)
            expected = due - timedelta(hours=1)

            waiting = ledger.sync(
                job_id="jakkuyagu:flow:game",
                account="jakkuyagu",
                content_type="flow",
                source_key="game",
                expected_at=expected,
                due_at=due,
                published=False,
                now=due - timedelta(minutes=1),
            )
            missing = ledger.sync(
                job_id="jakkuyagu:flow:game",
                account="jakkuyagu",
                content_type="flow",
                source_key="game",
                expected_at=expected,
                due_at=due,
                published=False,
                now=due,
            )
            published = ledger.sync(
                job_id="jakkuyagu:flow:game",
                account="jakkuyagu",
                content_type="flow",
                source_key="game",
                expected_at=expected,
                due_at=due,
                published=True,
                permalink="https://instagram.example/post",
                now=due + timedelta(minutes=2),
            )

            self.assertEqual(waiting["status"], "expected")
            self.assertEqual(missing["status"], "missing")
            self.assertEqual(published["status"], "published")
            self.assertEqual(ledger.unresolved(), [])
            ledger.close()

    def test_recovery_is_bounded_and_escalates(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = ReliabilityLedger(Path(temporary) / "jobs.sqlite3")
            now = datetime(2026, 8, 31, 1, 0, tzinfo=UTC)
            ledger.sync(
                job_id="jujinmo:close:2026-08-31",
                account="jujinmo",
                content_type="close_explainer",
                source_key="2026-08-31",
                expected_at=now - timedelta(hours=1),
                due_at=now,
                published=False,
                now=now,
            )
            for attempt in range(4):
                item = ledger.record_recovery(
                    "jujinmo:close:2026-08-31",
                    succeeded=False,
                    detail="same deterministic failure",
                    now=now + timedelta(hours=attempt),
                )

            self.assertEqual(item["status"], "operator_required")
            self.assertIsNone(item["next_recovery_at"])
            ledger.close()

    def test_later_policy_due_resets_recovering_job_to_expected(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = ReliabilityLedger(Path(temporary) / "jobs.sqlite3")
            now = datetime(2026, 9, 7, 11, 0, tzinfo=UTC)
            job_id = "jakkuyagu:flow:game"
            ledger.sync(
                job_id=job_id,
                account="jakkuyagu",
                content_type="flow",
                source_key="game",
                expected_at=now - timedelta(hours=2),
                due_at=now - timedelta(hours=1),
                published=False,
                now=now,
            )
            ledger.defer_recovery(job_id, detail="기존 조기 복구", now=now)

            item = ledger.sync(
                job_id=job_id,
                account="jakkuyagu",
                content_type="flow",
                source_key="game",
                expected_at=now - timedelta(hours=2),
                due_at=now + timedelta(hours=4),
                published=False,
                now=now + timedelta(minutes=15),
            )

            self.assertEqual(item["status"], "expected")
            self.assertIsNone(item["next_recovery_at"])
            ledger.close()

    def test_ineligible_job_can_be_resolved_as_cancelled(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = ReliabilityLedger(Path(temporary) / "jobs.sqlite3")
            now = datetime(2026, 8, 31, 1, 0, tzinfo=UTC)
            ledger.sync(
                job_id="jakkuyagu:flow-reel:no-video",
                account="jakkuyagu",
                content_type="game-flow-reel",
                source_key="no-video",
                expected_at=now - timedelta(hours=1),
                due_at=now,
                published=False,
                now=now,
            )

            item = ledger.cancel(
                "jakkuyagu:flow-reel:no-video",
                detail="verified source video unavailable",
                now=now,
            )

            self.assertEqual(item["status"], "cancelled")
            self.assertEqual(ledger.unresolved(), [])
            ledger.close()

    def test_deferred_recovery_preserves_attempts_and_can_be_reset(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger = ReliabilityLedger(Path(temporary) / "jobs.sqlite3")
            now = datetime(2026, 9, 7, 1, 0, tzinfo=UTC)
            job_id = "jakkuyagu:flow-reel:game-1"
            ledger.sync(
                job_id=job_id,
                account="jakkuyagu",
                content_type="game-flow-reel",
                source_key="2026-09-07:flow-reel:game-1",
                expected_at=now - timedelta(hours=2),
                due_at=now - timedelta(hours=1),
                published=False,
                now=now,
            )

            deferred = ledger.defer_recovery(
                job_id, detail="exit=75: 락 충돌", now=now
            )
            reset_count = ledger.reset_recovery("jakkuyagu:flow-reel:*", now=now)
            reset = ledger.get(job_id)

            self.assertEqual(deferred["status"], "recovering")
            self.assertEqual(deferred["recovery_attempts"], 0)
            self.assertEqual(reset_count, 1)
            self.assertEqual(reset["status"], "missing")
            self.assertEqual(reset["recovery_attempts"], 0)
            self.assertIsNone(reset["next_recovery_at"])
            ledger.close()


if __name__ == "__main__":
    unittest.main()
