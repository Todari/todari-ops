import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
import instagram_portfolio  # noqa: E402


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.ok = 200 <= status < 300

    def json(self):
        return self._payload


class FakeSession:
    def get(self, url, *, params, timeout):
        self.last_token = params.get("access_token")
        if url.endswith("/me"):
            return FakeResponse(
                {
                    "id": "account-1",
                    "username": "ju.jin.mo",
                    "followers_count": 12,
                    "follows_count": 3,
                    "media_count": 5,
                }
            )
        if url.endswith("/me/insights"):
            values = {
                "views": 140,
                "reach": 100,
                "profile_views": 9,
                "accounts_engaged": 7,
                "total_interactions": 11,
            }
            return FakeResponse(
                {
                    "data": [
                        {
                            "name": params["metric"],
                            "total_value": {"value": values[params["metric"]]},
                        }
                    ]
                }
            )
        if url.endswith("/me/media"):
            return FakeResponse(
                {
                    "data": [
                        {
                            "id": "media-1",
                            "media_type": "VIDEO",
                            "media_product_type": "REELS",
                            "timestamp": "2026-08-27T23:00:00+00:00",
                            "permalink": "https://instagram.example/reel/1",
                        }
                    ]
                }
            )
        if params["metric"] == ",".join(instagram_portfolio.REEL_METRICS):
            return FakeResponse(
                {
                    "data": [
                        {
                            "name": "ig_reels_avg_watch_time",
                            "values": [{"value": 3250}],
                        },
                        {
                            "name": "ig_reels_video_view_total_time",
                            "values": [{"value": 32500}],
                        },
                    ]
                }
            )
        return FakeResponse(
            {
                "data": [
                    {"name": "views", "values": [{"value": 100}]},
                    {"name": "reach", "values": [{"value": 80}]},
                    {"name": "saved", "values": [{"value": 4}]},
                    {"name": "shares", "values": [{"value": 2}]},
                    {"name": "total_interactions", "values": [{"value": 10}]},
                    {"name": "likes", "values": [{"value": 4}]},
                    {"name": "comments", "values": [{"value": 0}]},
                ]
            }
        )


class InstagramPortfolioTest(unittest.TestCase):
    def _jujinmo_home(self, root: Path) -> Path:
        repo = root / "jujinmo"
        (repo / "state").mkdir(parents=True)
        (repo / ".env").write_text(
            "IG_ACCESS_TOKEN=secret-token\nIG_GRAPH_VERSION=v23.0\n",
            encoding="utf-8",
        )
        (repo / "state" / "published.json").write_text(
            json.dumps(
                {
                    "posts": {
                        "ju.jin.mo:2026-08-28:premarket_hypothesis": {
                            "status": "published",
                            "content_type": "premarket_hypothesis",
                            "media_id": "media-1",
                            "published_at": "2026-08-27T23:00:00+00:00",
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        return root

    def test_media_index_classifies_core_series(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = self._jujinmo_home(Path(temporary))
            index = instagram_portfolio.media_index(home, "jujinmo")

        self.assertEqual(index["media-1"]["series"], "premarket_hypothesis")
        self.assertEqual(index["media-1"]["tier"], "core")

    def test_collect_account_normalizes_metrics_and_watch_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = self._jujinmo_home(Path(temporary))
            session = FakeSession()
            result = instagram_portfolio.collect_account(
                home,
                "jujinmo",
                session=session,
                now=datetime(2026, 8, 28, 0, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(session.last_token, "secret-token")
        record = result["records"][0]
        self.assertEqual(record["series"], "premarket_hypothesis")
        self.assertEqual(record["metrics"]["reach"], 80)
        self.assertEqual(record["rates"]["saves_per_1000_reach"], 50.0)
        self.assertEqual(record["rates"]["average_watch_seconds"], 3.25)
        self.assertEqual(result["profile"]["followers_count"], 12)
        self.assertEqual(result["account_metrics"]["metrics"]["profile_views"], 9)
        self.assertNotIn("secret-token", json.dumps(result))

    def test_portfolio_keeps_one_summary_per_collection_date(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self._jujinmo_home(root)
            output = root / "insights.json"
            now = datetime(2026, 8, 28, 0, 0, tzinfo=timezone.utc)
            for _ in range(2):
                payload = instagram_portfolio.collect_portfolio(
                    home=home,
                    output=output,
                    accounts=["jujinmo"],
                    session=FakeSession(),
                    now=now,
                )

        self.assertEqual(len(payload["history"]), 1)
        account = payload["latest"]["accounts"]["jujinmo"]
        summary = account["summary"][0]
        self.assertEqual(summary["series"], "premarket_hypothesis")
        self.assertEqual(summary["rates"]["interactions_per_1000_reach"], 125.0)
        self.assertEqual(summary["per_post"]["median_reach"], 80.0)
        history_account = payload["history"][0]["accounts"]["jujinmo"]
        self.assertEqual(history_account["profile"]["followers_count"], 12)
        self.assertEqual(history_account["account_metrics"]["metrics"]["profile_views"], 9)
        samples = payload["media_samples"]["jujinmo"]["media-1"]["samples"]
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["metrics"]["reach"], 80)
        self.assertEqual(payload["schema_version"], 3)
        feedback = payload["performance_feedback"]["jujinmo"]["series"][
            "premarket_hypothesis"
        ]
        self.assertEqual(feedback["status"], "collecting")
        self.assertEqual(feedback["experiment"]["variable"], "observe")

    def test_performance_feedback_uses_mature_checkpoint_and_one_experiment(self):
        latest = {
            "accounts": {
                "yaitnal": {
                    "handle": "yaitnal",
                    "profile": {"followers_count": 11},
                    "account_metrics": {"metrics": {"profile_views": 3}},
                }
            }
        }
        media_samples = {"yaitnal": {}}
        for index in range(5):
            media_samples["yaitnal"][f"media-{index}"] = {
                "series": "flow-reel",
                "samples": [
                    {
                        "age_hours": 23.0,
                        "metrics": {"reach": 999, "views": 999},
                        "rates": {"average_watch_seconds": 12.0},
                    },
                    {
                        "age_hours": 25.0,
                        "metrics": {
                            "reach": 100 + index,
                            "views": 120 + index,
                            "saved": 0,
                            "shares": 0,
                            "total_interactions": 2,
                        },
                        "rates": {"average_watch_seconds": 7.0},
                    },
                    {
                        "age_hours": 74.0,
                        "metrics": {
                            "reach": 150 + index,
                            "views": 180 + index,
                            "saved": 0,
                            "shares": 1,
                            "total_interactions": 3,
                        },
                        "rates": {"average_watch_seconds": 7.5},
                    },
                ],
            }

        feedback = instagram_portfolio.build_performance_feedback(
            latest,
            media_samples,
            generated_at="2026-08-31T00:00:00+00:00",
            history=[{
                "date": "2026-08-24",
                "accounts": {"yaitnal": {"profile": {"followers_count": 10}}},
            }],
        )["yaitnal"]

        series_feedback = feedback["series"]["flow-reel"]

        self.assertEqual(series_feedback["status"], "ready")
        self.assertEqual(series_feedback["checkpoints"]["24h"]["posts"], 5)
        self.assertEqual(series_feedback["checkpoints"]["24h"]["median_reach"], 102.0)
        self.assertEqual(series_feedback["checkpoints"]["72h"]["posts"], 5)
        self.assertEqual(series_feedback["experiment"]["variable"], "save_share_value")
        self.assertEqual(feedback["account_outcomes"]["follower_delta_7d"], 1)

    def _reel_samples(self, series, *, count=5, reach=100, watch=3.0, saved=0, shares=0):
        return {
            f"{series}-{index}": {
                "series": series,
                "media_product_type": "REELS",
                "samples": [{
                    "age_hours": 26.0,
                    "metrics": {
                        "reach": reach + index, "views": reach + 10 + index,
                        "saved": saved, "shares": shares, "total_interactions": 1,
                    },
                    "rates": {"average_watch_seconds": watch + index * 0.1},
                }],
            }
            for index in range(count)
        }

    def _feed_samples(self, series, *, count=5, reach=5):
        return {
            f"{series}-{index}": {
                "series": series,
                "media_product_type": "FEED",
                "samples": [{
                    "age_hours": 26.0,
                    "metrics": {"reach": reach, "views": reach * 3, "saved": 0, "shares": 0},
                    "rates": {},
                }],
            }
            for index in range(count)
        }

    def test_short_watch_reels_choose_opening_hook_and_report_retention_proxy(self):
        latest = {
            "accounts": {
                "jujinmo": {
                    "handle": "ju.jin.mo",
                    "profile": {"followers_count": 1},
                    "account_metrics": {"metrics": {"profile_views": 2, "reach": 210}},
                }
            }
        }
        media_samples = {"jujinmo": self._reel_samples("close_explainer", reach=40, watch=3.0)}

        feedback = instagram_portfolio.build_performance_feedback(
            latest, media_samples, generated_at="2026-09-02T12:00:00+00:00",
        )["jujinmo"]

        series = feedback["series"]["close_explainer"]
        self.assertEqual(series["format"], "reel")
        self.assertEqual(series["experiment"]["variable"], "opening_hook")
        self.assertIn("15초", series["experiment"]["guidance"])
        self.assertEqual(series["checkpoints"]["24h"]["median_watch_seconds"], 3.2)
        self.assertEqual(series["checkpoints"]["24h"]["watch_under_4s_share"], 1.0)
        self.assertEqual(feedback["account_outcomes"]["profile_visits_per_1000_reach"], 9.52)
        self.assertEqual(feedback["pause_candidates"], [])

    def test_visit_rate_is_withheld_when_daily_reach_is_too_small(self):
        latest = {
            "accounts": {
                "sector4": {
                    "handle": "sector4.f1",
                    "profile": {"followers_count": 5},
                    "account_metrics": {"metrics": {"profile_views": 1, "reach": 4}},
                }
            }
        }

        outcomes = instagram_portfolio.build_performance_feedback(
            latest, {"sector4": {}}, generated_at="2026-09-02T12:00:00+00:00",
        )["sector4"]["account_outcomes"]

        self.assertIsNone(outcomes["profile_visits_per_1000_reach"])
        self.assertEqual(outcomes["reach_1d"], 4)

    def test_low_profile_visit_rate_chooses_follow_promise_before_save_share(self):
        latest = {
            "accounts": {
                "yaitnal": {
                    "handle": "yaitnal",
                    "profile": {"followers_count": 11},
                    "account_metrics": {"metrics": {"profile_views": 1, "reach": 667}},
                }
            }
        }
        media_samples = {"yaitnal": self._reel_samples("flow-reel", reach=140, watch=7.0)}

        feedback = instagram_portfolio.build_performance_feedback(
            latest, media_samples, generated_at="2026-09-02T12:00:00+00:00",
        )["yaitnal"]

        self.assertEqual(feedback["account_outcomes"]["profile_visits_per_1000_reach"], 1.5)
        self.assertEqual(
            feedback["series"]["flow-reel"]["experiment"]["variable"], "follow_promise"
        )

    def test_healthy_visit_rate_but_no_saves_chooses_save_share_value(self):
        latest = {
            "accounts": {
                "yaitnal": {
                    "handle": "yaitnal",
                    "profile": {"followers_count": 11},
                    "account_metrics": {"metrics": {"profile_views": 5, "reach": 600}},
                }
            }
        }
        media_samples = {"yaitnal": self._reel_samples("flow-reel", reach=140, watch=7.0)}

        feedback = instagram_portfolio.build_performance_feedback(
            latest, media_samples, generated_at="2026-09-02T12:00:00+00:00",
        )["yaitnal"]

        self.assertEqual(
            feedback["series"]["flow-reel"]["experiment"]["variable"], "save_share_value"
        )

    def test_feed_series_reaching_only_followers_becomes_pause_candidate(self):
        latest = {
            "accounts": {
                "yaitnal": {
                    "handle": "yaitnal",
                    "profile": {"followers_count": 30},
                    "account_metrics": {"metrics": {"profile_views": 5, "reach": 600}},
                }
            }
        }
        media_samples = {
            "yaitnal": {
                **self._feed_samples("preview", reach=25),
                **self._reel_samples("flow-reel", reach=140, watch=7.0, saved=1),
            }
        }

        feedback = instagram_portfolio.build_performance_feedback(
            latest, media_samples, generated_at="2026-09-02T12:00:00+00:00",
        )["yaitnal"]

        preview = feedback["series"]["preview"]
        self.assertEqual(preview["format"], "feed")
        self.assertEqual(preview["experiment"]["variable"], "pause_series")
        self.assertIn("팔로워 30명", preview["experiment"]["reason"])
        self.assertEqual(
            [item["series"] for item in feedback["pause_candidates"]], ["preview"]
        )
        self.assertEqual(feedback["pause_candidates"][0]["median_reach"], 25.0)
        self.assertNotEqual(
            feedback["series"]["flow-reel"]["experiment"]["variable"], "pause_series"
        )

    def test_reel_series_with_median_reach_under_20_is_paused_by_kill_rule(self):
        latest = {
            "accounts": {
                "jujinmo": {
                    "handle": "ju.jin.mo",
                    "profile": {"followers_count": 1},
                    "account_metrics": {"metrics": {"profile_views": 2, "reach": 21}},
                }
            }
        }
        media_samples = {"jujinmo": self._reel_samples("premarket_hypothesis", reach=6, watch=1.0)}

        feedback = instagram_portfolio.build_performance_feedback(
            latest, media_samples, generated_at="2026-09-02T12:00:00+00:00",
        )["jujinmo"]

        experiment = feedback["series"]["premarket_hypothesis"]["experiment"]
        self.assertEqual(experiment["variable"], "pause_series")
        self.assertIn("< 20", experiment["reason"])
        self.assertEqual(feedback["pause_candidates"][0]["posts"], 5)

    def test_legacy_samples_without_product_type_are_classified_by_watch_time(self):
        reel_items = self._reel_samples("race-replay-reel", reach=100, watch=6.0)
        for item in reel_items.values():
            del item["media_product_type"]
        feed_items = self._feed_samples("quali", reach=50)
        for item in feed_items.values():
            del item["media_product_type"]
        latest = {
            "accounts": {
                "sector4": {
                    "handle": "sector4.f1",
                    "profile": {"followers_count": 5},
                    "account_metrics": {"metrics": {"profile_views": 4, "reach": 400}},
                }
            }
        }

        feedback = instagram_portfolio.build_performance_feedback(
            latest, {"sector4": {**reel_items, **feed_items}},
            generated_at="2026-09-02T12:00:00+00:00",
        )["sector4"]

        self.assertEqual(feedback["series"]["race-replay-reel"]["format"], "reel")
        self.assertEqual(feedback["series"]["quali"]["format"], "feed")

    def test_follower_delta_falls_back_to_shortest_available_window(self):
        latest = {
            "accounts": {
                "yaitnal": {"handle": "yaitnal", "profile": {"followers_count": 13}}
            }
        }
        history = [
            {"date": "2026-08-31", "accounts": {"yaitnal": {"profile": {"followers_count": 11}}}},
            {"date": "2026-09-01", "accounts": {"yaitnal": {"profile": {"followers_count": 12}}}},
        ]

        outcomes = instagram_portfolio.build_performance_feedback(
            latest, {"yaitnal": {}}, generated_at="2026-09-02T12:00:00+00:00",
            history=history,
        )["yaitnal"]["account_outcomes"]

        self.assertEqual(outcomes["follower_delta_7d"], 2)
        self.assertEqual(outcomes["follower_delta_window_days"], 2)
        self.assertIsNone(outcomes["profile_visits_per_1000_reach"])

    def test_summary_exposes_median_watch_and_short_watch_share(self):
        records = [
            {
                "tier": "core", "series": "close_explainer",
                "metrics": {"reach": 10, "views": 12},
                "rates": {"average_watch_seconds": watch},
            }
            for watch in (1.5, 3.9, 5.0)
        ]

        summary = instagram_portfolio.summarize(records)[0]["per_post"]

        self.assertEqual(summary["median_watch_seconds"], 3.9)
        self.assertEqual(summary["watch_under_4s_share"], 0.667)

    def test_performance_feedback_excludes_sector4_backfill_batch(self):
        latest = {
            "accounts": {
                "sector4": {
                    "handle": "sector4.f1",
                    "profile": {"followers_count": 5},
                }
            }
        }
        media_samples = {"sector4": {}}
        for index in range(5):
            media_samples["sector4"][f"media-{index}"] = {
                "series": "race-replay-reel",
                "published_at": f"2026-08-25T1{index}:00:00+09:00",
                "samples": [{
                    "age_hours": 30,
                    "metrics": {"reach": 100, "views": 120},
                    "rates": {"average_watch_seconds": 5.0},
                }],
            }

        feedback = instagram_portfolio.build_performance_feedback(
            latest,
            media_samples,
            generated_at="2026-08-31T00:00:00+00:00",
        )["sector4"]["series"]["race-replay-reel"]

        self.assertEqual(feedback["excluded_backfill_posts"], 5)
        self.assertEqual(feedback["checkpoints"]["24h"]["posts"], 0)
        self.assertEqual(feedback["status"], "collecting")

    def test_performance_feedback_excludes_late_yaitnal_backfill(self):
        latest = {
            "accounts": {
                "yaitnal": {"handle": "yaitnal", "profile": {"followers_count": 11}}
            }
        }
        media_samples = {
            "yaitnal": {
                "backfill": {
                    "series": "flow-reel",
                    "source_key": "2026-08-23:flow-reel:game",
                    "published_at": "2026-08-25T16:00:00+09:00",
                    "samples": [{
                        "age_hours": 30,
                        "metrics": {"reach": 200, "views": 220},
                        "rates": {"average_watch_seconds": 8.0},
                    }],
                },
                "regular": {
                    "series": "flow-reel",
                    "source_key": "2026-08-24:flow-reel:game",
                    "published_at": "2026-08-25T01:00:00+09:00",
                    "samples": [{
                        "age_hours": 30,
                        "metrics": {"reach": 100, "views": 120},
                        "rates": {"average_watch_seconds": 7.0},
                    }],
                },
            }
        }

        feedback = instagram_portfolio.build_performance_feedback(
            latest,
            media_samples,
            generated_at="2026-08-31T00:00:00+00:00",
        )["yaitnal"]["series"]["flow-reel"]

        self.assertEqual(feedback["excluded_backfill_posts"], 1)
        self.assertEqual(feedback["checkpoints"]["24h"]["posts"], 1)


if __name__ == "__main__":
    unittest.main()
