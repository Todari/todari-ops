import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from instagram_reliability import ReliabilityLedger


UTC = timezone.utc


class ReliabilityLedgerTest(unittest.TestCase):
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
