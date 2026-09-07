from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    sys.modules["requests"] = types.SimpleNamespace(RequestException=Exception)


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
    def _missing_job(self, ledger, job_id="jakkuyagu:flow-reel:game-1"):
        now = datetime(2026, 9, 7, 1, 0, tzinfo=timezone.utc)
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
        return job_id

    def test_recovery_exit_75_is_deferred_without_spending_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = ReliabilityLedger(Path(directory) / "jobs.sqlite3")
            try:
                job_id = self._missing_job(ledger)
                ledger.record_recovery(
                    job_id,
                    succeeded=True,
                    detail="이전 정상 복구 호출",
                    now=datetime(2026, 9, 6, 1, 0, tzinfo=timezone.utc),
                )
                result = types.SimpleNamespace(
                    returncode=75,
                    stdout="다른 야있날 생성·게시 프로세스가 실행 중 — 종료",
                    stderr="",
                )
                with patch.object(watchdog.subprocess, "run", return_value=result):
                    watchdog._run_recovery(
                        ledger, job_id, ["python", "reel_daily.py"], cwd=Path(directory)
                    )
                item = ledger.get(job_id)
                self.assertEqual(item["status"], "recovering")
                self.assertEqual(item["recovery_attempts"], 1)
                self.assertIn("exit=75", item["last_error"])
            finally:
                ledger.close()

    def test_successful_recovery_keeps_existing_success_handling(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = ReliabilityLedger(Path(directory) / "jobs.sqlite3")
            try:
                job_id = self._missing_job(ledger)
                result = types.SimpleNamespace(returncode=0, stdout="게시 완료", stderr="")
                with patch.object(watchdog.subprocess, "run", return_value=result):
                    watchdog._run_recovery(
                        ledger, job_id, ["python", "reel_daily.py"], cwd=Path(directory)
                    )
                item = ledger.get(job_id)
                self.assertEqual(item["status"], "recovering")
                self.assertEqual(item["recovery_attempts"], 1)
            finally:
                ledger.close()

    def test_legacy_lock_message_is_deferred_even_with_exit_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = ReliabilityLedger(Path(directory) / "jobs.sqlite3")
            try:
                job_id = self._missing_job(ledger)
                result = types.SimpleNamespace(
                    returncode=0,
                    stdout="다른 야있날 생성·게시 프로세스가 실행 중 — 종료",
                    stderr="",
                )
                with patch.object(watchdog.subprocess, "run", return_value=result):
                    watchdog._run_recovery(
                        ledger, job_id, ["python", "reel_daily.py"], cwd=Path(directory)
                    )
                self.assertEqual(ledger.get(job_id)["recovery_attempts"], 0)
            finally:
                ledger.close()

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

    def test_weekly_digest_includes_all_four_accounts(self):
        accounts = {
            name: {
                "handle": handle,
                "profile": {"followers_count": 1, "media_count": 1},
                "account_metrics": {"metrics": {}},
                "records": [],
            }
            for name, handle in (
                ("sector4", "sector4.f1"),
                ("yaitnal", "yaitnal"),
                ("jujinmo", "ju.jin.mo"),
                ("gonggu", "09._.ham"),
            )
        }

        lines = watchdog.build_weekly_digest_lines(
            {"latest": {"accounts": accounts}, "history": [], "performance_feedback": {}},
            datetime(2026, 9, 6, 21, 5, tzinfo=KST),
        )

        self.assertEqual(len(lines), 4)
        self.assertTrue(any("**09._.ham**" in line for line in lines))

    def test_weekly_digest_starts_with_reliability_summary(self):
        lines = watchdog.build_weekly_digest_lines(
            {"latest": {"accounts": {}}, "history": [], "performance_feedback": {}},
            datetime(2026, 9, 6, 21, 5, tzinfo=KST),
            {"alerts": 9, "actual_missing": 2, "policy_cancelled": 5},
        )

        self.assertEqual(
            lines,
            ["지난주 알림 9건 / 실제 미게시 2건 / 정책 취소 5건"],
        )

    def test_insights_collection_targets_all_four_accounts(self):
        collect = Mock(
            return_value={
                "latest": {
                    "accounts": {
                        name: {"records": []} for name in watchdog.INSIGHTS_ACCOUNTS
                    }
                }
            }
        )
        fake_portfolio = types.SimpleNamespace(collect_portfolio=collect)
        state = {}
        with patch.dict(sys.modules, {"instagram_portfolio": fake_portfolio}):
            watchdog.collect_portfolio_once(
                state, datetime(2026, 9, 7, 21, 0, tzinfo=KST)
            )

        self.assertEqual(
            collect.call_args.kwargs["accounts"], list(watchdog.INSIGHTS_ACCOUNTS)
        )
        self.assertEqual(
            state["_instagram_insights_accounts"], list(watchdog.INSIGHTS_ACCOUNTS)
        )

    def test_yaitnal_reel_recovery_waits_for_shared_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "jakkuyagu" / "state"
            state_path.mkdir(parents=True)
            (state_path / "daily_content.json").write_text(
                json.dumps(
                    {
                        "2026-09-07:flow:game-1": {
                            "status": "published",
                            "media_id": "flow-media",
                        }
                    }
                ),
                encoding="utf-8",
            )
            (state_path / "reels.json").write_text(
                json.dumps(
                    {
                        "2026-09-07:reel-policy": {
                            "stage": "reel_policy",
                            "featured_game_ids": ["game-1"],
                        }
                    }
                ),
                encoding="utf-8",
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [{
                    "gameId": "game-1",
                    "statusCode": "RESULT",
                    "cancel": None,
                    "gameDateTime": "2026-09-07T12:00:00+09:00",
                }] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once"),
                    patch.object(watchdog, "_run_recovery") as recovery,
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 22, 0, tzinfo=KST), ledger
                    )

                command = recovery.call_args.args[2]
                self.assertEqual(command[-2:], ["--lock-wait", "600"])
                self.assertEqual(recovery.call_args.kwargs["timeout"], 1800)
            finally:
                ledger.close()

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

    def test_feed_policy_skipped_flow_is_cancelled_but_reel_remains_expected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content_path = root / "jakkuyagu" / "state" / "daily_content.json"
            content_path.parent.mkdir(parents=True)
            content_path.write_text(
                json.dumps(
                    {
                        "2026-09-03:flow:game-1": {
                            "status": "skipped",
                            "stage": "feed_policy",
                            "skip_reason": "피드 발행 정책에 따라 제외",
                        }
                    }
                ),
                encoding="utf-8",
            )
            (content_path.parent / "reels.json").write_text(
                json.dumps(
                    {
                        "2026-09-03:flow-reel:featured": {
                            "status": "published",
                            "media_id": "featured-reel",
                        }
                    }
                ),
                encoding="utf-8",
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [
                    {
                        "gameId": "game-1",
                        "statusCode": "RESULT",
                        "cancel": None,
                        "gameDateTime": "2026-09-03T14:00:00+09:00",
                    }
                ] if game_date == "2026-09-03" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch.object(watchdog, "_run_recovery") as recovery,
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 3, 20, 30, tzinfo=KST), ledger
                    )

                flow = ledger.get("jakkuyagu:flow:game-1")
                reel = ledger.get("jakkuyagu:flow-reel:game-1")
                self.assertEqual(flow["status"], "cancelled")
                self.assertEqual(flow["last_error"], "피드 발행 정책에 따라 제외")
                self.assertEqual(reel["status"], "expected")
                alert.assert_not_called()
                recovery.assert_not_called()
            finally:
                ledger.close()

    def test_alerts_only_once_while_recovering_then_once_when_published(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = ReliabilityLedger(Path(directory) / "jobs.sqlite3")
            detected_at = datetime(2026, 9, 7, 10, 0, tzinfo=KST)
            job_id = self._missing_job(ledger)
            try:
                with patch.object(watchdog, "_notify", return_value=True) as notify:
                    watchdog._alert_once(
                        {}, ledger, job_id, "jakkuyagu", "game-flow-reel", "경기 릴스", now=detected_at
                    )
                    ledger.defer_recovery(job_id, detail="락 대기", now=detected_at)
                    for tick in range(1, 5):
                        watchdog._alert_once(
                            {},
                            ledger,
                            job_id,
                            "jakkuyagu",
                            "game-flow-reel",
                            "경기 릴스",
                            now=detected_at + timedelta(minutes=15 * tick),
                        )
                    ledger.sync(
                        job_id=job_id,
                        account="jakkuyagu",
                        content_type="game-flow-reel",
                        source_key="2026-09-07:flow-reel:game-1",
                        expected_at=detected_at - timedelta(hours=2),
                        due_at=detected_at - timedelta(hours=1),
                        published=True,
                        now=detected_at + timedelta(hours=2),
                    )
                    watchdog._alert_once(
                        {},
                        ledger,
                        job_id,
                        "jakkuyagu",
                        "game-flow-reel",
                        "경기 릴스",
                        now=detected_at + timedelta(hours=2),
                    )

                self.assertEqual(notify.call_count, 2)
                self.assertIn("지연 감지·자동 복구 시작", notify.call_args_list[0].args[3])
                self.assertIn("지연 게시 완료", notify.call_args_list[1].args[3])
            finally:
                ledger.close()

    def test_operator_required_sends_one_final_alert(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = ReliabilityLedger(Path(directory) / "jobs.sqlite3")
            now = datetime(2026, 9, 7, 10, 0, tzinfo=KST)
            job_id = self._missing_job(ledger, "jujinmo:close:2026-09-07")
            try:
                with patch.object(watchdog, "_notify", return_value=True) as notify:
                    watchdog._alert_once(
                        {}, ledger, job_id, "jujinmo", "close", "종가 콘텐츠", now=now
                    )
                    for attempt in range(4):
                        ledger.record_recovery(
                            job_id,
                            succeeded=False,
                            detail="복구 실패",
                            now=now + timedelta(hours=attempt + 1),
                        )
                    watchdog._alert_once(
                        {},
                        ledger,
                        job_id,
                        "jujinmo",
                        "close",
                        "종가 콘텐츠",
                        now=now + timedelta(hours=5),
                    )
                    watchdog._alert_once(
                        {},
                        ledger,
                        job_id,
                        "jujinmo",
                        "close",
                        "종가 콘텐츠",
                        now=now + timedelta(hours=6),
                    )

                self.assertEqual(notify.call_count, 2)
                self.assertIn("운영자 확인 필요", notify.call_args_list[1].args[3])
            finally:
                ledger.close()

    def test_flow_alert_waits_until_daily_policy_decision_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "jakkuyagu" / "config"
            config_path.mkdir(parents=True)
            (config_path / "feed_policy.json").write_text(
                json.dumps(
                    {
                        "flow_per_day": 1,
                        "reel_per_day": 0,
                        "flow_decision_deadline_hours_after_last_first_pitch": 5,
                    }
                ),
                encoding="utf-8",
            )
            times = ("14:00", "15:00", "16:00", "17:00", "18:30")
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [
                    {
                        "gameId": f"game-{index}",
                        "statusCode": "RESULT",
                        "cancel": None,
                        "gameDateTime": f"2026-09-07T{start}:00+09:00",
                    }
                    for index, start in enumerate(times, start=1)
                ] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch.object(watchdog, "_run_recovery"),
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 20, 0, tzinfo=KST), ledger
                    )
                    self.assertEqual(
                        ledger.get("jakkuyagu:flow:game-1")["status"], "expected"
                    )
                    alert.assert_not_called()
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 8, 0, 30, tzinfo=KST), ledger
                    )

                self.assertEqual(
                    ledger.get("jakkuyagu:flow:game-1")["status"], "missing"
                )
                self.assertEqual(
                    datetime.fromisoformat(
                        ledger.get("jakkuyagu:flow:game-1")["due_at"]
                    ),
                    datetime(2026, 9, 8, 0, 30, tzinfo=KST),
                )
            finally:
                ledger.close()

    def test_flow_per_day_zero_creates_no_flow_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "jakkuyagu" / "config"
            config_path.mkdir(parents=True)
            (config_path / "feed_policy.json").write_text(
                json.dumps({"flow_per_day": 0, "reel_per_day": 0}), encoding="utf-8"
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [{
                    "gameId": "game-1",
                    "statusCode": "RESULT",
                    "gameDateTime": "2026-09-07T14:00:00+09:00",
                }] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with patch.dict(sys.modules, {"kbo": fake_kbo}), patch.object(
                    watchdog, "HOME", root
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 23, 0, tzinfo=KST), ledger
                    )
                self.assertIsNone(ledger.get("jakkuyagu:flow:game-1"))
            finally:
                ledger.close()

    def test_reel_policy_skipped_job_is_cancelled_without_alert(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "jakkuyagu" / "state"
            state_path.mkdir(parents=True)
            config_path = root / "jakkuyagu" / "config"
            config_path.mkdir(parents=True)
            (config_path / "feed_policy.json").write_text(
                json.dumps({"flow_per_day": 0, "reel_per_day": 1}), encoding="utf-8"
            )
            (state_path / "reels.json").write_text(
                json.dumps(
                    {
                        "2026-09-07:flow-reel:game-1": {
                            "status": "skipped",
                            "stage": "reel_policy",
                            "skip_reason": "하루 대표 릴스 정책 제외",
                        },
                        "2026-09-07:flow-reel:game-2": {
                            "status": "published",
                            "media_id": "featured-reel",
                        }
                    }
                ),
                encoding="utf-8",
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [{
                    "gameId": "game-1",
                    "statusCode": "RESULT",
                    "gameDateTime": "2026-09-07T14:00:00+09:00",
                }] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch.object(watchdog, "_run_recovery") as recovery,
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 8, 1, 0, tzinfo=KST), ledger
                    )
                item = ledger.get("jakkuyagu:flow-reel:game-1")
                self.assertEqual(item["status"], "cancelled")
                self.assertEqual(item["policy_cancelled"], 1)
                alert.assert_not_called()
                recovery.assert_not_called()
            finally:
                ledger.close()

    def test_reel_with_skip_reason_is_cancelled_without_alert_or_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "jakkuyagu" / "state"
            state_path.mkdir(parents=True)
            (state_path / "reels.json").write_text(
                json.dumps(
                    {
                        "2026-09-07:flow-reel:game-1": {
                            "status": "skipped",
                            "stage": "selection",
                            "skip_reason": "다른 경기를 하루 대표 릴스로 선정",
                        },
                        "2026-09-07:flow-reel:game-2": {
                            "status": "published",
                            "media_id": "reel-media",
                        },
                    }
                ),
                encoding="utf-8",
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [
                    {
                        "gameId": game_id,
                        "statusCode": "RESULT",
                        "gameDateTime": f"2026-09-07T{hour}:00:00+09:00",
                    }
                    for game_id, hour in (("game-1", 14), ("game-2", 15))
                ] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch.object(watchdog, "_run_recovery") as recovery,
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 20, 0, tzinfo=KST), ledger
                    )

                item = ledger.get("jakkuyagu:flow-reel:game-1")
                self.assertEqual(item["status"], "cancelled")
                self.assertEqual(item["last_error"], "다른 경기를 하루 대표 릴스로 선정")
                alert.assert_not_called()
                recovery.assert_not_called()
            finally:
                ledger.close()

    def test_reel_of_day_alerts_once_after_last_game_estimated_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [{
                    "gameId": "game-1",
                    "statusCode": "RESULT",
                    "gameDateTime": "2026-09-07T18:30:00+09:00",
                }] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_notify", return_value=True) as notify,
                    patch.object(watchdog, "_run_recovery"),
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 22, 29, tzinfo=KST), ledger
                    )
                    self.assertEqual(notify.call_count, 0)
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 22, 30, tzinfo=KST), ledger
                    )
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 23, 0, tzinfo=KST), ledger
                    )

                self.assertEqual(notify.call_count, 1)
                self.assertEqual(
                    notify.call_args.args[2], "jakkuyagu:reel-of-day:2026-09-07"
                )
                self.assertEqual(
                    ledger.get("jakkuyagu:reel-of-day:2026-09-07")["status"],
                    "missing",
                )
            finally:
                ledger.close()

    def test_reel_of_day_published_has_no_alert(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "jakkuyagu" / "state"
            state_path.mkdir(parents=True)
            (state_path / "reels.json").write_text(
                json.dumps(
                    {
                        "2026-09-07:flow-reel:game-1": {
                            "status": "published",
                            "media_id": "reel-media",
                        }
                    }
                ),
                encoding="utf-8",
            )
            fake_kbo = types.SimpleNamespace(
                fetch_games=lambda game_date: [{
                    "gameId": "game-1",
                    "statusCode": "RESULT",
                    "gameDateTime": "2026-09-07T18:30:00+09:00",
                }] if game_date == "2026-09-07" else []
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.dict(sys.modules, {"kbo": fake_kbo}),
                    patch.object(watchdog, "HOME", root),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch.object(watchdog, "_run_recovery") as recovery,
                ):
                    watchdog.check_jakkuyagu(
                        {}, datetime(2026, 9, 7, 23, 0, tzinfo=KST), ledger
                    )

                self.assertEqual(
                    ledger.get("jakkuyagu:reel-of-day:2026-09-07")["status"],
                    "published",
                )
                alert.assert_not_called()
                recovery.assert_not_called()
            finally:
                ledger.close()

    def test_gonggu_missing_status_file_is_quiet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.object(watchdog, "GONGGU_STATUS_PATH", root / "missing.json"),
                    patch.object(watchdog, "_alert_once") as alert,
                    patch("builtins.print") as output,
                ):
                    watchdog.check_gonggu(
                        {}, datetime(2026, 9, 4, 12, 0, tzinfo=KST), ledger
                    )
                alert.assert_not_called()
                output.assert_called_once()
                self.assertEqual(ledger.unresolved(), [])
            finally:
                ledger.close()

    def test_gonggu_today_published_creates_no_alert(self):
        self._assert_gonggu_state("published", expected_ledger_status="published")

    def test_gonggu_today_skipped_is_cancelled(self):
        self._assert_gonggu_state(
            "skipped",
            detail="오늘은 대상 상품 없음",
            expected_ledger_status="cancelled",
        )

    def test_gonggu_today_failed_alerts_before_due(self):
        self._assert_gonggu_state(
            "failed",
            detail="Instagram API 오류",
            now=datetime(2026, 9, 4, 11, 0, tzinfo=KST),
            expected_ledger_status="expected",
            expected_alerts=1,
        )

    def test_gonggu_past_due_missing_alerts_once(self):
        self._assert_gonggu_state(
            None,
            publication_date="2026-09-03",
            expected_ledger_status="missing",
            expected_alerts=1,
        )

    def _assert_gonggu_state(
        self,
        publication_state,
        *,
        publication_date="2026-09-04",
        detail=None,
        now=datetime(2026, 9, 4, 12, 0, tzinfo=KST),
        expected_ledger_status,
        expected_alerts=0,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status_path = root / "publish_status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "publication_date": publication_date,
                        "state": publication_state,
                        "account": "09._.ham",
                        "instagram_media_id": "media-1" if publication_state == "published" else None,
                        "permalink": "https://www.instagram.com/p/example/"
                        if publication_state == "published"
                        else None,
                        "media_count": 3 if publication_state == "published" else None,
                        "detail": detail,
                        "updated_at": "2026-09-04T11:00:00+09:00",
                    }
                ),
                encoding="utf-8",
            )
            ledger = ReliabilityLedger(root / "jobs.sqlite3")
            try:
                with (
                    patch.object(watchdog, "GONGGU_STATUS_PATH", status_path),
                    patch.object(watchdog, "_alert_once") as alert,
                ):
                    watchdog.check_gonggu({}, now, ledger)
                self.assertEqual(
                    ledger.get("gonggu:daily:2026-09-04")["status"],
                    expected_ledger_status,
                )
                self.assertEqual(alert.call_count, expected_alerts)
                if publication_state == "skipped":
                    self.assertEqual(
                        ledger.get("gonggu:daily:2026-09-04")["last_error"], detail
                    )
            finally:
                ledger.close()


if __name__ == "__main__":
    unittest.main()
