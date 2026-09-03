from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location(
    "instagram_watchdog", SCRIPT_DIR / "instagram-watchdog.py"
)
assert SPEC and SPEC.loader
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)

from instagram_reliability import ReliabilityLedger


KST = timezone(timedelta(hours=9))


class InstagramWatchdogTest(unittest.TestCase):
    def test_weekly_digest_lists_funnel_and_pause_candidates(self):
        data = {
            "latest": {
                "accounts": {
                    "yaitnal": {
                        "handle": "yaitnal",
                        "profile": {"followers_count": 11, "media_count": 95},
                        "account_metrics": {"metrics": {"views": 949, "reach": 667}},
                        "records": [{
                            "series": "flow-reel",
                            "published_at": "2026-09-02T03:16:00+09:00",
                            "metrics": {"reach": 193},
                            "permalink": "https://instagram.example/reel/x",
                        }],
                    }
                }
            },
            "history": [],
            "performance_feedback": {
                "yaitnal": {
                    "account_outcomes": {
                        "profile_views_1d": 7,
                        "profile_visits_per_1000_reach": 10.49,
                        "follower_delta_7d": 0,
                        "follower_delta_window_days": 3,
                    },
                    "pause_candidates": [
                        {"series": "preview", "format": "feed", "posts": 34, "median_reach": 5.0},
                    ],
                    "series": {
                        "preview": {
                            "status": "ready",
                            "experiment": {"variable": "pause_series"},
                        },
                        "flow-reel": {
                            "status": "ready",
                            "experiment": {"variable": "opening_hook"},
                        },
                    },
                }
            },
        }

        lines = watchdog.build_weekly_digest_lines(
            data, datetime(2026, 9, 6, 21, 5, tzinfo=KST)
        )

        self.assertEqual(
            lines[1],
            "  ↳ 퍼널: 도달 1,000당 프로필 방문 10.49 (방문 7) · 팔로워 +0 (3일 창)",
        )
        self.assertIn("  ↳ 다음 실험: flow-reel=opening_hook", lines)
        self.assertIn(
            "  ↳ 중단 후보 시리즈: preview(feed, 34편, 도달 중앙값 5.0)", lines
        )
        self.assertFalse(any("preview=pause_series" in line for line in lines))

    def test_graph_only_flow_is_not_scheduled_as_a_reel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "graph-only.json"
            manifest = root / "carousel.json"
            config.write_text(
                json.dumps(
                    {
                        "clips": [],
                        "verification": {
                            "release_fallback": {"mode": "verified_relay_graph_only"}
                        },
                    }
                ),
                encoding="utf-8",
            )
            manifest.write_text(
                json.dumps({"game_config": str(config)}), encoding="utf-8"
            )

            self.assertFalse(
                watchdog._flow_has_reel_source({"manifest_path": str(manifest)})
            )

    def test_flush_outbox_removes_success_and_keeps_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for account in ("jakkuyagu", "sector4"):
                state_path = root / account / "state" / "notification_outbox.json"
                state_path.parent.mkdir(parents=True)
                state_path.write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "events": {
                                account: {
                                    "payload": {"account": account},
                                    "attempts": 0,
                                }
                            },
                        }
                    ),
                    encoding="utf-8",
                )
            with (
                patch.object(watchdog, "HOME", root),
                patch.object(
                    watchdog,
                    "_post_signed_payload",
                    side_effect=[(True, "HTTP 200"), (False, "HTTP 500")],
                ),
            ):
                result = watchdog.flush_notification_outboxes()

            self.assertEqual(result, {"sent": 1, "remaining": 1})
            success = json.loads(
                (root / "jakkuyagu" / "state" / "notification_outbox.json").read_text()
            )
            failure = json.loads(
                (root / "sector4" / "state" / "notification_outbox.json").read_text()
            )
            self.assertEqual(success["events"], {})
            self.assertEqual(failure["events"]["sector4"]["attempts"], 1)

    def test_jujinmo_recognizes_canonical_content_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            published_path = root / "jujinmo" / "state" / "published.json"
            published_path.parent.mkdir(parents=True)
            published_path.write_text(
                json.dumps(
                    {
                        "posts": {
                            "morning": {
                                "status": "published",
                                "market_date": "2026-08-31",
                                "content_type": "premarket_hypothesis",
                                "permalink": "https://www.instagram.com/p/morning/",
                            },
                            "close": {
                                "status": "published",
                                "market_date": "2026-08-31",
                                "content_type": "close_explainer",
                                "permalink": "https://www.instagram.com/p/close/",
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )
            fake_krx = types.SimpleNamespace(is_trading_day=lambda _date: True)
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with patch.dict(sys.modules, {"krx_data": fake_krx}), patch.object(
                    watchdog, "HOME", root
                ):
                    watchdog.check_jujinmo(
                        {}, datetime(2026, 8, 31, 18, 0, tzinfo=KST), ledger
                    )
                self.assertEqual(
                    ledger.get("jujinmo:premarket:2026-08-31")["status"], "published"
                )
                self.assertEqual(
                    ledger.get("jujinmo:close:2026-08-31")["status"], "published"
                )
            finally:
                ledger.close()

    def test_cancelled_baseball_game_creates_no_expected_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda _date: [
                    {"gameId": "cancelled", "statusCode": "RESULT", "cancel": "우천취소"}
                ]
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with patch.dict(sys.modules, {"kbo": fake_kbo}), patch.object(
                    watchdog, "HOME", root
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 8, 31, 22, 0, tzinfo=KST), ledger
                    )
                self.assertEqual(ledger.unresolved(), [])
            finally:
                ledger.close()


if __name__ == "__main__":
    unittest.main()
