#!/usr/bin/env python3
"""세 Instagram 자동화 계정의 최근 게시물 Insights를 같은 스키마로 수집한다.

토큰은 각 계정 런타임의 ``.env``에서 메모리로만 읽고 결과 파일에는 쓰지 않는다.
게시물 생성·수정·삭제 API는 호출하지 않는다.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


KST = timezone(timedelta(hours=9))
DEFAULT_HOME = Path("/home/ubuntu")
DEFAULT_OUTPUT = DEFAULT_HOME / "ops-watchdog" / "instagram-insights.json"
PERFORMANCE_MINIMUM_POSTS = 5
PERFORMANCE_CHECKPOINTS = (24, 72)
# 성장 실험 변수 선택 기준(2026-09-03 진단: 릴스 시청 3~8초·프로필 방문 1~2/1000도달·피드 도달=팔로워).
HOOK_WATCH_SECONDS = 5.0          # 릴스 시청 중앙값이 이보다 짧으면 훅부터 고친다.
SHORT_WATCH_SECONDS = 4.0         # 이 미만 시청 릴스 비중을 유지율 대리 지표로 본다.
PROFILE_VISIT_RATE_FLOOR = 3.0    # 도달 1,000당 프로필 방문이 이보다 적으면 팔로우 약속을 점검한다.
SAVE_SHARE_RATE_FLOOR = 1.0       # 도달 1,000당 저장+공유가 이보다 적으면 저장 가치를 점검한다.
PAUSE_MEDIAN_REACH = 20           # 5편 이상인데 24시간 도달 중앙값이 이 미만이면 중단 후보.
MIN_REACH_FOR_VISIT_RATE = 100    # 일간 도달이 이보다 작으면 방문 비율이 요동쳐서(1/4=250) 계산하지 않는다.
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
        watch_stats = _watch_statistics(watch_seconds)
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
                    **watch_stats,
                },
            }
        )
    return summaries


def _watch_statistics(watch_seconds: list[float]) -> dict[str, float]:
    """릴스 평균 시청 시간 목록을 유지율 대리 지표로 요약한다."""
    if not watch_seconds:
        return {}
    return {
        "average_watch_seconds": round(sum(watch_seconds) / len(watch_seconds), 3),
        "median_watch_seconds": round(float(statistics.median(watch_seconds)), 3),
        "watch_under_4s_share": round(
            sum(1 for value in watch_seconds if value < SHORT_WATCH_SECONDS)
            / len(watch_seconds),
            3,
        ),
    }


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
            # 구버전 history에도 다음 수집부터 정규 게시/백필 판정을 위한 메타데이터를 채운다.
            item["series"] = record.get("series")
            item["tier"] = record.get("tier")
            item["source_key"] = record.get("source_key")
            item["published_at"] = record.get("published_at")
            item["media_product_type"] = record.get("media_product_type")
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


def _checkpoint_sample(
    samples: list[dict[str, Any]], checkpoint_hours: int
) -> dict[str, Any] | None:
    """체크포인트를 지난 첫 샘플을 고른다.

    수집기는 하루 한 번 실행되므로 정확히 +24h/+72h인 샘플이 없을 수 있다. 이때
    체크포인트 이전 값을 당겨 쓰지 않고, 기준을 지난 샘플 가운데 가장 가까운 값을 쓴다.
    """
    candidates = [
        sample
        for sample in samples
        if isinstance(sample, dict)
        and isinstance(sample.get("age_hours"), (int, float))
        and float(sample["age_hours"]) >= checkpoint_hours
    ]
    return min(candidates, key=lambda sample: float(sample["age_hours"])) if candidates else None


def _checkpoint_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = ("reach", "views", "saved", "shares", "total_interactions")
    totals = {
        metric: sum(float((sample.get("metrics") or {}).get(metric) or 0) for sample in samples)
        for metric in metrics
    }
    medians = {
        metric: round(
            float(statistics.median(
                float((sample.get("metrics") or {}).get(metric) or 0)
                for sample in samples
            )),
            3,
        )
        for metric in ("reach", "views")
    }
    reach = totals["reach"]
    watch = [
        float((sample.get("rates") or {})["average_watch_seconds"])
        for sample in samples
        if isinstance((sample.get("rates") or {}).get("average_watch_seconds"), (int, float))
    ]
    return {
        "posts": len(samples),
        "median_reach": medians["reach"],
        "median_views": medians["views"],
        "saves_per_1000_reach": round(totals["saved"] * 1000 / reach, 2) if reach else 0.0,
        "shares_per_1000_reach": round(totals["shares"] * 1000 / reach, 2) if reach else 0.0,
        "interactions_per_1000_reach": round(
            totals["total_interactions"] * 1000 / reach, 2
        ) if reach else 0.0,
        **_watch_statistics(watch),
    }


def _is_reel_series(items: list[dict[str, Any]]) -> bool:
    """릴스 시리즈 판정. 구버전 샘플엔 media_product_type이 없어 시청 시간 유무로 보완한다."""
    for item in items:
        if item.get("media_product_type") == "REELS":
            return True
        for sample in item.get("samples") or []:
            if isinstance((sample.get("rates") or {}).get("average_watch_seconds"), (int, float)):
                return True
    return False


def _pause_experiment(reason: str) -> dict[str, str]:
    return {
        "variable": "pause_series",
        "reason": reason,
        "guidance": "비팔로워 노출 0 — 발행량을 줄이고 릴스에 집중",
    }


def _experiment_for(
    checkpoint: dict[str, Any],
    account_outcomes: dict[str, Any],
    *,
    is_reel: bool = True,
) -> dict[str, str]:
    """실적이 충분할 때 한 번에 바꿀 성장 변수 하나만 고른다.

    순서: 중단 규칙(도달 중앙값 < 20) → 피드의 팔로워 밖 노출 0 → 릴스 훅(시청 중앙값 < 5초)
    → 프로필 전환(도달 1,000당 방문 < 3) → 저장·공유(도달 1,000당 < 1) → 관찰.
    `pause_series`는 생성기 프롬프트에 넘기지 않고 운영 판단(발행량 조정)에만 쓴다.
    """
    posts = int(checkpoint.get("posts") or 0)
    median_reach = checkpoint.get("median_reach")
    followers = account_outcomes.get("followers")
    if isinstance(median_reach, (int, float)) and float(median_reach) < PAUSE_MEDIAN_REACH:
        return _pause_experiment(
            f"{posts}편의 24시간 도달 중앙값 {float(median_reach):g} < {PAUSE_MEDIAN_REACH}"
        )
    if (
        not is_reel
        and isinstance(median_reach, (int, float))
        and isinstance(followers, int)
        and float(median_reach) <= followers
    ):
        return _pause_experiment(
            f"피드 도달 중앙값 {float(median_reach):g}이 팔로워 {followers}명을 넘지 못함"
        )
    watch_seconds = checkpoint.get("median_watch_seconds", checkpoint.get("average_watch_seconds"))
    if (
        is_reel
        and isinstance(watch_seconds, (int, float))
        and float(watch_seconds) < HOOK_WATCH_SECONDS
    ):
        return {
            "variable": "opening_hook",
            "reason": (
                f"릴스 시청 중앙값 {float(watch_seconds):g}초 < {HOOK_WATCH_SECONDS:g}초 — "
                "테스트 노출 뒤 확산이 끊기는 원인"
            ),
            "guidance": (
                "첫 프레임에 결과를 놓고 12자 이내 훅 한 줄만 얹는다. 인트로·제목 카드를 없애고 "
                "전체 길이를 15초 이하로 줄이며 검증 사실과 장면 순서는 유지한다."
            ),
        }
    visit_rate = account_outcomes.get("profile_visits_per_1000_reach")
    if isinstance(visit_rate, (int, float)) and float(visit_rate) < PROFILE_VISIT_RATE_FLOOR:
        delta = account_outcomes.get("follower_delta_7d")
        if isinstance(delta, int) and delta <= 0:
            reason = (
                f"도달 1,000당 프로필 방문 {float(visit_rate):g} < {PROFILE_VISIT_RATE_FLOOR:g} · "
                f"팔로워 증가 {delta:+d}"
            )
        else:
            reason = f"도달 1,000당 프로필 방문 {float(visit_rate):g} < {PROFILE_VISIT_RATE_FLOOR:g}"
        return {
            "variable": "follow_promise",
            "reason": reason,
            "guidance": (
                "마지막 장면과 캡션에서 다음에 무엇을 언제 확인해 주는 계정인지 한 문장으로 "
                "화면에 약속하고 상투적인 팔로우 요청은 쓰지 않는다."
            ),
        }
    share_save_rate = float(checkpoint.get("saves_per_1000_reach") or 0) + float(
        checkpoint.get("shares_per_1000_reach") or 0
    )
    if share_save_rate < SAVE_SHARE_RATE_FLOOR:
        return {
            "variable": "save_share_value",
            "reason": (
                f"도달 1,000당 저장+공유 {share_save_rate:g} < {SAVE_SHARE_RATE_FLOOR:g}"
            ),
            "guidance": (
                "검증된 사실과 기존 레이아웃 안에서 저장하거나 친구에게 보낼 이유가 되는 "
                "한 가지 요약·질문만 강화하고 다른 구조는 유지한다."
            ),
        }
    return {
        "variable": "observe",
        "reason": "시청·프로필 전환·저장 기준을 모두 통과 — 현재 구조 유지",
        "guidance": "기존 계약과 문체를 유지하고 성과 표본을 더 수집한다.",
    }


def _follower_delta(
    account: str,
    followers: Any,
    history: list[dict[str, Any]] | None,
    *,
    generated_date,
) -> tuple[int | None, int | None]:
    """7일 전 기준선이 있으면 그 값을, 없으면 보유한 가장 오래된 이력을 써서 증감을 계산한다.

    반환: (증감, 실제 사용한 창 일수). 이력이 하루치도 없으면 (None, None).
    """
    if not isinstance(followers, int):
        return None, None
    entries = []
    for entry in history or []:
        if not isinstance(entry, dict):
            continue
        date_text = str(entry.get("date") or entry.get("collected_at") or "")[:10]
        base = ((((entry.get("accounts") or {}).get(account) or {}).get("profile") or {})
                .get("followers_count"))
        try:
            entry_date = datetime.fromisoformat(date_text).date()
        except ValueError:
            continue
        if isinstance(base, int) and entry_date < generated_date:
            entries.append((entry_date, base))
    if not entries:
        return None, None
    baseline_date = generated_date - timedelta(days=7)
    older = [item for item in entries if item[0] <= baseline_date]
    chosen = max(older) if older else min(entries)
    return followers - chosen[1], (generated_date - chosen[0]).days


def _published_datetime(item: dict[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(item["published_at"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return None


def _growth_eligible_items(
    account: str, series: str, items: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    """백필·재게시 묶음이 정규 시리즈의 성장 기준을 왜곡하지 않게 제외한다."""
    excluded: set[int] = set()
    if account == "yaitnal":
        for item in items:
            match = re.match(r"(\d{4}-\d{2}-\d{2}):", str(item.get("source_key") or ""))
            published = _published_datetime(item)
            if not match or published is None:
                continue
            event_date = datetime.fromisoformat(match.group(1)).date()
            if (published.astimezone(KST).date() - event_date).days > 1:
                excluded.add(id(item))
    elif account == "sector4":
        by_publish_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in items:
            published = _published_datetime(item)
            if published is not None:
                by_publish_date[published.astimezone(KST).date().isoformat()].append(item)
        # 한 세션 유형이 하루에 세 편 이상 올라오면 과거 라운드 백필 묶음이다.
        for same_day in by_publish_date.values():
            if len(same_day) >= 3:
                excluded.update(id(item) for item in same_day)
    eligible = [item for item in items if id(item) not in excluded]
    return eligible, len(excluded)


def build_performance_feedback(
    latest: dict[str, Any], media_samples: dict[str, Any], *, generated_at: str,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """실제 반응을 다음 생성기가 읽을 수 있는 계정·시리즈별 컨텍스트로 바꾼다."""
    feedback: dict[str, Any] = {}
    generated_date = datetime.fromisoformat(generated_at).date()
    for account, account_samples in media_samples.items():
        if not isinstance(account_samples, dict):
            continue
        by_series: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in account_samples.values():
            if not isinstance(item, dict) or not isinstance(item.get("series"), str):
                continue
            by_series[item["series"]].append(item)
        latest_account = (latest.get("accounts") or {}).get(account) or {}
        profile = latest_account.get("profile") or {}
        followers = profile.get("followers_count")
        follower_delta, delta_window_days = _follower_delta(
            account, followers, history, generated_date=generated_date
        )
        account_metrics = (latest_account.get("account_metrics") or {}).get("metrics") or {}
        profile_views = account_metrics.get("profile_views")
        account_reach = account_metrics.get("reach")
        visit_rate = None
        if (
            isinstance(profile_views, (int, float))
            and isinstance(account_reach, (int, float))
            and float(account_reach) >= MIN_REACH_FOR_VISIT_RATE
        ):
            visit_rate = round(float(profile_views) * 1000 / float(account_reach), 2)
        account_outcomes = {
            "profile_views_1d": profile_views,
            "reach_1d": account_reach,
            "profile_visits_per_1000_reach": visit_rate,
            "followers": followers,
            "follower_delta_7d": follower_delta,
            "follower_delta_window_days": delta_window_days,
            "attribution": "account_level_not_per_post",
        }
        series_feedback = {}
        pause_candidates = []
        for series, items in sorted(by_series.items()):
            is_reel = _is_reel_series(items)
            items, excluded_backfill_posts = _growth_eligible_items(
                account, series, items
            )
            checkpoints = {}
            for checkpoint in PERFORMANCE_CHECKPOINTS:
                samples = [
                    sample
                    for item in items
                    if (sample := _checkpoint_sample(item.get("samples") or [], checkpoint))
                    is not None
                ]
                checkpoints[f"{checkpoint}h"] = _checkpoint_summary(samples) if samples else {
                    "posts": 0
                }
            mature = checkpoints["24h"]
            eligible = int(mature.get("posts") or 0) >= PERFORMANCE_MINIMUM_POSTS
            experiment = (
                _experiment_for(mature, account_outcomes, is_reel=is_reel)
                if eligible
                else {
                    "variable": "observe",
                    "reason": (
                        f"24시간 성과 {mature.get('posts', 0)}건 수집 · "
                        f"최소 {PERFORMANCE_MINIMUM_POSTS}건 필요"
                    ),
                    "guidance": "기존 계약과 문체를 유지하고 성과 표본을 더 수집한다.",
                }
            )
            if experiment["variable"] == "pause_series":
                pause_candidates.append(
                    {
                        "series": series,
                        "format": "reel" if is_reel else "feed",
                        "posts": int(mature.get("posts") or 0),
                        "median_reach": mature.get("median_reach"),
                        "reason": experiment["reason"],
                    }
                )
            series_feedback[series] = {
                "status": "ready" if eligible else "collecting",
                "minimum_posts": PERFORMANCE_MINIMUM_POSTS,
                "format": "reel" if is_reel else "feed",
                "excluded_backfill_posts": excluded_backfill_posts,
                "checkpoints": checkpoints,
                "experiment": experiment,
            }
        feedback[account] = {
            "generated_at": generated_at,
            "handle": latest_account.get("handle"),
            "followers": profile.get("followers_count"),
            "account_outcomes": account_outcomes,
            "policy": {
                "facts_are_not_content_sources": True,
                "one_experiment_variable_at_a_time": True,
                "minimum_posts": PERFORMANCE_MINIMUM_POSTS,
                "pause_rule": (
                    f"24시간 표본 {PERFORMANCE_MINIMUM_POSTS}편 이상이고 도달 중앙값이 "
                    f"{PAUSE_MEDIAN_REACH} 미만이거나, 피드 도달이 팔로워 수를 넘지 못하면 중단 후보"
                ),
            },
            "pause_candidates": pause_candidates,
            "series": series_feedback,
        }
    return feedback


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
    history = _merge_history(previous, latest)
    media_samples = _merge_media_samples(previous, latest)
    payload = {
        "schema_version": 3,
        "latest": latest,
        "history": history,
        "media_samples": media_samples,
        "performance_feedback": build_performance_feedback(
            latest,
            media_samples,
            generated_at=latest["collected_at"],
            history=history,
        ),
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
