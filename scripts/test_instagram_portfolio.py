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


if __name__ == "__main__":
    unittest.main()
