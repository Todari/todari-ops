#!/usr/bin/env python3
"""세 Instagram 자동화 계정의 최근 게시물 Insights를 같은 스키마로 수집한다.

토큰은 각 계정 런타임의 ``.env``에서 메모리로만 읽고 결과 파일에는 쓰지 않는다.
게시물 생성·수정·삭제 API는 호출하지 않는다.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


KST = timezone(timedelta(hours=9))
DEFAULT_HOME = Path("/home/ubuntu")
DEFAULT_OUTPUT = DEFAULT_HOME / "ops-watchdog" / "instagram-insights.json"
BASE_METRICS = (
    "views",
    "reach",
    "saved",
    "shares",
    "total_interactions",
    "likes",
    "comments",
)
REEL_METRICS = (
    "ig_reels_avg_watch_time",
    "ig_reels_video_view_total_time",
)
ACCOUNT_METRICS = (
    "views",
    "reach",
    "profile_views",
    "accounts_engaged",
    "total_interactions",
)
ACCOUNT_CONFIG = {
    "sector4": {
        "repo": "sector4",
        "handle": "sector4.f1",
        "state_files": ("state/task_status.json", "state/reels.json"),
        "core_series": {
            "weekend", "quali", "racepreview", "result", "sprintquali",
            "sprintresult", "race-replay-reel", "sprint-replay-reel",
        },
    },
    "yaitnal": {
        "repo": "jakkuyagu",
        "handle": "yaitnal",
        "state_files": ("state/daily_content.json", "state/reels.json"),
        "core_series": {"preview", "flow", "flow-reel"},
    },
    "jujinmo": {
        "repo": "jujinmo",
        "handle": "ju.jin.mo",
        "state_files": ("state/published.json",),
        "core_series": {
            "premarket_hypothesis", "close_explainer", "weekly_market_review",
            "market_term_explainer", "weekly_market_outlook",
            # 배포 전 생성된 패키지의 분류 호환성.
            "premarket_preview", "close_review",
        },
    },
}


class PortfolioInsightsError(RuntimeError):
    """Insights 수집 설정 또는 Graph API 응답 오류."""


def _read_env(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise PortfolioInsightsError(f"환경 파일 없음: {path}")
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise PortfolioInsightsError(f"상태 JSON 읽기 실패: {path}") from error


def _iter_media_records(value: Any, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        if value.get("media_id"):
            yield path, value
        for key, child in value.items():
            yield from _iter_media_records(child, path + (str(key),))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_media_records(child, path + (str(index),))


def _series_for(account: str, source_key: str, item: dict[str, Any]) -> str:
    explicit = item.get("task") or item.get("content_type") or item.get("phase")
    if isinstance(explicit, str) and explicit:
        return explicit
    if account == "yaitnal":
        parts = source_key.split(":")
        if len(parts) >= 2:
            return parts[1]
    if account == "sector4":
        if source_key.startswith("race-reel-"):
            return "race-replay-reel"
        if source_key.startswith("sprint-reel-"):
            return "sprint-replay-reel"
        return source_key.split("-", 1)[0]
    if account == "jujinmo":
        return source_key.rsplit(":", 1)[-1]
    return "unclassified"


def media_index(home: Path, account: str) -> dict[str, dict[str, Any]]:
    config = ACCOUNT_CONFIG[account]
    repo = home / str(config["repo"])
    found: dict[str, dict[str, Any]] = {}
    for relative in config["state_files"]:
        path = repo / str(relative)
        if not path.is_file():
            continue
        for record_path, item in _iter_media_records(_json(path)):
            media_id = str(item["media_id"])
            source_key = str(item.get("key") or (record_path[-1] if record_path else media_id))
            series = _series_for(account, source_key, item)
            candidate = {
                "source_key": source_key,
                "series": series,
                "tier": "core" if series in config["core_series"] else "support",
                "published_at": item.get("published_at"),
                "permalink": item.get("permalink"),
            }
            previous = found.get(media_id)
            if previous is None or sum(bool(value) for value in candidate.values()) > sum(
                bool(value) for value in previous.values()
            ):
                found[media_id] = candidate
    return found


def _graph_get(session, url: str, *, params: dict[str, Any]) -> dict[str, Any]:
    try:
        response = session.get(url, params=params, timeout=25)
    except requests.RequestException as error:
        raise PortfolioInsightsError(
            f"Graph API 네트워크 오류: {type(error).__name__}"
        ) from error
    try:
        payload = response.json()
    except ValueError as error:
        raise PortfolioInsightsError(f"Graph API 비JSON 응답: HTTP {response.status_code}") from error
    if not response.ok:
        graph_error = payload.get("error") or {}
        raise PortfolioInsightsError(
            "Graph API 오류: HTTP {} code={} type={}".format(
                response.status_code,
                graph_error.get("code"),
                graph_error.get("type"),
            )
        )
    if not isinstance(payload, dict):
        raise PortfolioInsightsError("Graph API 응답 형식 오류")
    return payload


def _metric_values(payload: dict[str, Any]) -> dict[str, float | int]:
    metrics: dict[str, float | int] = {}
    for item in payload.get("data") or []:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        value = (item.get("total_value") or {}).get("value")
        values = item.get("values") or []
        if value is None and values and isinstance(values[-1], dict):
            value = values[-1].get("value")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            metrics[item["name"]] = value
    return metrics


def _rates(metrics: dict[str, float | int]) -> dict[str, float]:
    reach = float(metrics.get("reach") or 0)
    rates: dict[str, float] = {}
    if reach > 0:
        for source, target in (
            ("saved", "saves_per_1000_reach"),
            ("shares", "shares_per_1000_reach"),
            ("total_interactions", "interactions_per_1000_reach"),
        ):
            rates[target] = round(float(metrics.get(source) or 0) * 1000 / reach, 2)
    average_watch_ms = metrics.get("ig_reels_avg_watch_time")
    if isinstance(average_watch_ms, (int, float)):
        rates["average_watch_seconds"] = round(float(average_watch_ms) / 1000, 3)
    return rates


def _recent_media(
    session,
    *,
    graph: str,
    token: str,
    since: datetime,
    limit: int,
) -> list[dict[str, Any]]:
    payload = _graph_get(
        session,
        f"{graph}/me/media",
        params={
            "access_token": token,
            "fields": "id,media_type,media_product_type,timestamp,permalink",
            "limit": min(max(1, limit), 100),
        },
    )
    result = []
    for item in payload.get("data") or []:
        try:
            timestamp = datetime.fromisoformat(str(item["timestamp"]).replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            continue
        if timestamp >= since:
            result.append(item)
    return result


def collect_account(
    home: Path,
    account: str,
    *,
    session=requests,
    days: int = 14,
    limit: int = 100,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    config = ACCOUNT_CONFIG[account]
    repo = home / str(config["repo"])
    env = _read_env(repo / ".env")
    token = env.get("IG_ACCESS_TOKEN", "")
    if not token:
        raise PortfolioInsightsError(f"{account}: IG_ACCESS_TOKEN 없음")
    version = env.get("IG_GRAPH_VERSION", "v23.0")
    graph = f"https://graph.instagram.com/{version}"
    errors = []
    profile: dict[str, Any] = {}
    try:
        profile = _graph_get(
            session,
            f"{graph}/me",
            params={
                "access_token": token,
                "fields": "id,username,followers_count,follows_count,media_count",
            },
        )
    except PortfolioInsightsError as error:
        errors.append({"scope": "profile", "error": str(error)})

    account_metrics: dict[str, float | int] = {}
    kst_date = now.astimezone(KST).date()
    account_window = {
        "since": (kst_date - timedelta(days=1)).isoformat(),
        "until": kst_date.isoformat(),
    }
    for metric in ACCOUNT_METRICS:
        try:
            account_metrics.update(
                _metric_values(
                    _graph_get(
                        session,
                        f"{graph}/me/insights",
                        params={
                            "access_token": token,
                            "metric": metric,
                            "metric_type": "total_value",
                            "period": "day",
                            **account_window,
                        },
                    )
                )
            )
        except PortfolioInsightsError as error:
            errors.append(
                {"scope": "account_metric", "metric": metric, "error": str(error)}
            )

    index = media_index(home, account)
    media = _recent_media(
        session,
        graph=graph,
        token=token,
        since=now - timedelta(days=max(1, days)),
        limit=limit,
    )
    records = []
    for item in media:
        media_id = str(item["id"])
        try:
            metrics = _metric_values(
                _graph_get(
                    session,
                    f"{graph}/{media_id}/insights",
                    params={"access_token": token, "metric": ",".join(BASE_METRICS)},
                )
            )
            if item.get("media_type") == "VIDEO":
                metrics.update(
                    _metric_values(
                        _graph_get(
                            session,
                            f"{graph}/{media_id}/insights",
                            params={
                                "access_token": token,
                                "metric": ",".join(REEL_METRICS),
                            },
                        )
                    )
                )
        except PortfolioInsightsError as error:
            errors.append({"media_id": media_id, "error": str(error)})
            continue
        metadata = index.get(
            media_id,
            {
                "source_key": media_id,
                "series": "unclassified",
                "tier": "support",
                "published_at": item.get("timestamp"),
                "permalink": item.get("permalink"),
            },
        )
        published_at = metadata.get("published_at") or item.get("timestamp")
        try:
            published = datetime.fromisoformat(str(published_at).replace("Z", "+00:00"))
            age_hours = round((now - published.astimezone(timezone.utc)).total_seconds() / 3600, 1)
        except (TypeError, ValueError):
            age_hours = None
        records.append(
            {
                "media_id": media_id,
                "media_type": item.get("media_type"),
                "media_product_type": item.get("media_product_type"),
                **metadata,
                "published_at": published_at,
                "age_hours": age_hours,
                "metrics": metrics,
                "rates": _rates(metrics),
            }
        )
    return {
        "handle": config["handle"],
        "collected_at": now.isoformat(),
        "profile": {
            key: profile[key]
            for key in ("id", "username", "followers_count", "follows_count", "media_count")
            if key in profile
        },
        "account_metrics": {
            "window": account_window,
            "metrics": account_metrics,
        },
        "records": records,
        "errors": errors,
    }


def summarize(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        groups[(str(record["tier"]), str(record["series"]))].append(record)
    summaries = []
    for (tier, series), items in sorted(groups.items()):
        totals = {
            metric: sum(float(item["metrics"].get(metric) or 0) for item in items)
            for metric in BASE_METRICS
        }
        reach = totals["reach"]
        reaches = [float(item["metrics"].get("reach") or 0) for item in items]
        views = [float(item["metrics"].get("views") or 0) for item in items]
        watch_seconds = [
            float(item["rates"]["average_watch_seconds"])
            for item in items
            if "average_watch_seconds" in item["rates"]
        ]
        summaries.append(
            {
                "tier": tier,
                "series": series,
                "posts": len(items),
                "totals": {
                    key: int(value) if value.is_integer() else round(value, 3)
                    for key, value in totals.items()
                },
                "rates": {
                    "saves_per_1000_reach": round(totals["saved"] * 1000 / reach, 2)
                    if reach else 0.0,
                    "shares_per_1000_reach": round(totals["shares"] * 1000 / reach, 2)
                    if reach else 0.0,
                    "interactions_per_1000_reach": round(
                        totals["total_interactions"] * 1000 / reach, 2
                    ) if reach else 0.0,
                },
                "per_post": {
                    "average_reach": round(sum(reaches) / len(reaches), 2),
                    "median_reach": round(float(statistics.median(reaches)), 2),
                    "average_views": round(sum(views) / len(views), 2),
                    "median_views": round(float(statistics.median(views)), 2),
                    **(
                        {
                            "average_watch_seconds": round(
                                sum(watch_seconds) / len(watch_seconds), 3
                            )
                        }
                        if watch_seconds else {}
                    ),
                },
            }
        )
    return summaries


def _merge_history(previous: dict[str, Any], latest: dict[str, Any]) -> list[dict[str, Any]]:
    date_key = str(latest["collected_at"])[:10]
    history = [
        item
        for item in previous.get("history", [])
        if isinstance(item, dict) and item.get("date") != date_key
    ]
    history.append(
        {
            "date": date_key,
            "collected_at": latest["collected_at"],
            "accounts": {
                account: {
                    "profile": payload.get("profile", {}),
                    "account_metrics": payload.get("account_metrics", {}),
                    "summary": payload.get("summary", []),
                }
                for account, payload in latest["accounts"].items()
                if "summary" in payload
            },
        }
    )
    return history[-35:]


def _merge_media_samples(
    previous: dict[str, Any], latest: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    date_key = str(latest["collected_at"])[:10]
    samples = previous.get("media_samples", {})
    if not isinstance(samples, dict):
        samples = {}
    merged = json.loads(json.dumps(samples))
    for account, payload in latest["accounts"].items():
        if not isinstance(payload.get("records"), list):
            continue
        account_samples = merged.setdefault(account, {})
        for record in payload["records"]:
            media_id = str(record["media_id"])
            item = account_samples.setdefault(
                media_id,
                {
                    "series": record.get("series"),
                    "tier": record.get("tier"),
                    "published_at": record.get("published_at"),
                    "samples": [],
                },
            )
            current = [
                sample
                for sample in item.get("samples", [])
                if isinstance(sample, dict) and sample.get("date") != date_key
            ]
            current.append(
                {
                    "date": date_key,
                    "collected_at": latest["collected_at"],
                    "age_hours": record.get("age_hours"),
                    "metrics": record.get("metrics", {}),
                    "rates": record.get("rates", {}),
                }
            )
            item["samples"] = current[-35:]

    cutoff = (datetime.fromisoformat(latest["collected_at"]) - timedelta(days=35)).date()
    for account in list(merged):
        account_samples = merged[account]
        if not isinstance(account_samples, dict):
            del merged[account]
            continue
        for media_id in list(account_samples):
            item = account_samples[media_id]
            valid_samples = []
            for sample in item.get("samples", []):
                try:
                    sample_date = datetime.fromisoformat(str(sample["date"])).date()
                except (KeyError, TypeError, ValueError):
                    continue
                if sample_date >= cutoff:
                    valid_samples.append(sample)
            if valid_samples:
                item["samples"] = valid_samples[-35:]
            else:
                del account_samples[media_id]
        if not account_samples:
            del merged[account]
    return merged


def collect_portfolio(
    *,
    home: Path = DEFAULT_HOME,
    output: Path = DEFAULT_OUTPUT,
    accounts: list[str] | None = None,
    session=requests,
    days: int = 14,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    selected = accounts or list(ACCOUNT_CONFIG)
    latest: dict[str, Any] = {
        "collected_at": now.isoformat(),
        "accounts": {},
    }
    for account in selected:
        if account not in ACCOUNT_CONFIG:
            latest["accounts"][account] = {"error": "알 수 없는 계정"}
            continue
        try:
            result = collect_account(
                home,
                account,
                session=session,
                days=days,
                now=now,
            )
            result["summary"] = summarize(result["records"])
            latest["accounts"][account] = result
        except Exception as error:  # 한 계정 실패가 다른 계정 수집을 막지 않는다.
            latest["accounts"][account] = {
                "handle": ACCOUNT_CONFIG[account]["handle"],
                "error": f"{type(error).__name__}: {error}",
            }
    previous = _json(output) if output.is_file() else {}
    payload = {
        "schema_version": 2,
        "latest": latest,
        "history": _merge_history(previous, latest),
        "media_samples": _merge_media_samples(previous, latest),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, output)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--account", action="append", choices=tuple(ACCOUNT_CONFIG))
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args()
    payload = collect_portfolio(
        home=args.home,
        output=args.output,
        accounts=args.account,
        days=args.days,
    )
    for account, result in payload["latest"]["accounts"].items():
        if result.get("error"):
            print(f"{account}: 실패 — {result['error']}")
        else:
            print(
                f"{account}: {len(result['records'])}건 수집 · "
                f"{len(result['summary'])}개 시리즈"
            )


if __name__ == "__main__":
    main()
