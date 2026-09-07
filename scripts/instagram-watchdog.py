#!/usr/bin/env python3
"""인스타 파이프라인 침묵 실패 워치독.

크론이 아예 돌지 않거나 조용히 죽으면 실패 알림도 없다(2026-08-24 디스크 풀 사고).
그래서 "나와야 할 게시물이 마감 시한까지 안 나왔는지"를 기대 캘린더와 실제 게시
상태를 대조해 감지하고, 기존 인스타 알림 웹훅(실패 임베드)으로 경고한다.

EC2 호스트 크론(15분 간격)에서 /home/ubuntu/jujinmo/.venv/bin/python 으로 실행한다.
같은 job은 ledger에 기록된 단계에 따라 최초 감지와 최종 결과만 알리고,
복구가 24시간을 넘긴 경우에만 리마인더를 한 번 허용한다.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from instagram_reliability import ReliabilityLedger

KST = timezone(timedelta(hours=9))
HOME = Path("/home/ubuntu")
STATE_PATH = HOME / "ops-watchdog" / "state.json"
INSIGHTS_PATH = HOME / "ops-watchdog" / "instagram-insights.json"
LEDGER_PATH = HOME / "ops-watchdog" / "instagram-jobs.sqlite3"
GONGGU_STATUS_PATH = Path("/opt/gonggu-radar/data/publish_status.json")
INSIGHTS_ACCOUNTS = ("sector4", "yaitnal", "jujinmo", "gonggu")
RECOVERY_LOCK_MESSAGE = "다른 야있날 생성·게시 프로세스가 실행 중"
JAKKUYAGU_POLICY_DEFAULTS = {
    "flow_per_day": 1,
    "reel_per_day": 1,
    "flow_decision_deadline_hours_after_last_first_pitch": 5,
    "reel_decision_deadline_kst": "23:30",
}
REEL_POLICY_STAGE = "reel_policy"

JUJINMO_CONTENT_TYPES = {
    "premarket": {"premarket_hypothesis", "premarket_preview"},
    "close": {"close_explainer", "close_review"},
    "weekly_review": {"weekly_market_review"},
    "glossary": {"market_term_explainer"},
    "weekly_outlook": {"weekly_market_outlook"},
}
CONTENT_TYPE_BY_PHASE = {
    "premarket": "premarket_hypothesis",
    "close": "close_explainer",
    "weekly_review": "weekly_market_review",
    "glossary": "market_term_explainer",
    "weekly_outlook": "weekly_market_outlook",
}

sys.path.insert(0, str(HOME / "jujinmo" / "src"))
sys.path.insert(0, str(HOME / "jakkuyagu" / "src"))
sys.path.insert(0, str(HOME / "sector4" / "src"))


def _env(path: Path) -> dict:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def _load_state() -> dict:
    if STATE_PATH.is_file():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except ValueError:
            return {}
    return {}


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def _post_signed_payload(env_path: Path, payload: dict) -> tuple[bool, str]:
    env = _env(env_path)
    url = env.get("INSTAGRAM_NOTIFY_URL", "")
    secret = env.get("INSTAGRAM_NOTIFY_SECRET", "")
    if not url or not secret:
        return False, "notification configuration missing"
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    try:
        response = requests.post(
            url,
            data=body,
            headers={"Content-Type": "application/json", "X-Instagram-Signature": signature},
            timeout=15,
        )
    except requests.RequestException as error:
        return False, type(error).__name__
    return response.ok, f"HTTP {response.status_code}: {response.text[:300]}"


def flush_notification_outboxes() -> dict[str, int]:
    """Retry producer-side notification events without touching publish state."""
    result = {"sent": 0, "remaining": 0}
    for account in ("jakkuyagu", "sector4", "jujinmo"):
        path = HOME / account / "state" / "notification_outbox.json"
        if not path.is_file():
            continue
        with path.with_suffix(".lock").open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            events = state.get("events") if isinstance(state, dict) else None
            if not isinstance(events, dict):
                continue
            remaining = {}
            for key, item in events.items():
                payload = item.get("payload") if isinstance(item, dict) else None
                if not isinstance(payload, dict):
                    continue
                sent, detail = _post_signed_payload(HOME / account / ".env", payload)
                if sent:
                    result["sent"] += 1
                    continue
                remaining[key] = {
                    **item,
                    "attempts": int(item.get("attempts") or 0) + 1,
                    "last_error": detail[:500],
                    "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            result["remaining"] += len(remaining)
            _atomic_json(path, {"version": 1, "events": remaining})
    return result


def _run_recovery(
    ledger: ReliabilityLedger,
    job_id: str,
    command: list[str],
    *,
    cwd: Path,
    timeout: int = 1800,
) -> None:
    if not ledger.due_for_recovery(job_id):
        return
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = "\n".join(value for value in (result.stdout, result.stderr) if value)
        detail = output.strip()[-1000:] or "no output"
        recovery_detail = f"exit={result.returncode}: {detail}"
        if result.returncode == 75 or RECOVERY_LOCK_MESSAGE in output:
            ledger.defer_recovery(job_id, detail=recovery_detail)
            return
        ledger.record_recovery(
            job_id,
            succeeded=result.returncode == 0,
            detail=recovery_detail,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        ledger.record_recovery(
            job_id,
            succeeded=False,
            detail=f"{type(error).__name__}: {error}",
        )


def _notify(account: str, content_type: str, source_key: str, message: str) -> bool:
    payload = {
        "status": "failed",
        "account": account,
        "error_type": "PublishWatchdog",
        "error_message": message,
        "content_type": content_type,
        "source_key": source_key,
        "stage": "publish_watchdog",
        "failure_category": "watchdog",
        "attempt": 1,
        "next_retry_at": None,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    sent, detail = _post_signed_payload(HOME / "jujinmo" / ".env", payload)
    if not sent:
        print(f"warning: 워치독 알림 전송 실패 — {detail}")
    return sent


def _alert_once(
    state: dict,
    ledger: ReliabilityLedger,
    key: str,
    account: str,
    content_type: str,
    message: str,
    *,
    now: datetime | None = None,
    force_initial: bool = False,
) -> None:
    """job 단계별 최초·24시간 리마인더·최종 알림을 각각 한 번만 보낸다."""
    current = now or datetime.now(KST)
    item = ledger.get(key)
    if not item:
        return
    status = item["status"]
    initial_at = ledger.alert_time(key, "initial")
    legacy_alerted_at = state.get(key)
    if initial_at is None and isinstance(legacy_alerted_at, str):
        try:
            parsed = datetime.fromisoformat(legacy_alerted_at)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=KST)
            ledger.record_alert(key, "initial", now=parsed)
            initial_at = parsed
            state.pop(key, None)
        except ValueError:
            pass
    stage = None
    alert_message = message
    if initial_at is None and (status in {"missing", "recovering"} or force_initial):
        stage = "initial"
        alert_message = f"지연 감지·자동 복구 시작 — {message}"
    elif initial_at is None and status == "operator_required":
        stage = "final_operator_required"
        alert_message = f"자동 복구 실패·운영자 확인 필요 — {message}"
    elif initial_at is not None and not ledger.has_final_alert(key):
        if status == "published":
            stage = "final_published"
            alert_message = f"지연 게시 완료 — {message}"
        elif status == "operator_required":
            stage = "final_operator_required"
            alert_message = f"자동 복구 실패·운영자 확인 필요 — {message}"
        elif status == "cancelled" and not item.get("policy_cancelled"):
            stage = "final_cancelled"
            alert_message = f"게시 취소 — {message}"
    if (
        stage is None
        and initial_at is not None
        and status == "recovering"
        and ledger.alert_time(key, "reminder_24h") is None
        and current >= initial_at.astimezone(current.tzinfo) + timedelta(hours=24)
    ):
        stage = "reminder_24h"
        alert_message = f"복구 24시간 경과 — {message}"
    if stage is None:
        return
    print(f"경고 발송: {key} [{stage}] — {alert_message}")
    if _notify(account, content_type, key, alert_message):
        ledger.record_alert(key, stage, now=current)
        state.pop(key, None)  # 예전 6시간 중복 방지 키는 더 이상 사용하지 않는다.


def _job_needs_alert_check(ledger: ReliabilityLedger, item: dict) -> bool:
    status = item["status"]
    if status in {"missing", "recovering", "operator_required"}:
        return True
    if status not in {"published", "cancelled"} or item.get("policy_cancelled"):
        return False
    return bool(
        ledger.alert_time(item["job_id"], "initial")
        and not ledger.has_final_alert(item["job_id"])
    )


def check_jujinmo(state: dict, now: datetime, ledger: ReliabilityLedger) -> None:
    import krx_data

    today = now.date()
    published_path = HOME / "jujinmo" / "state" / "published.json"
    posts = {}
    if published_path.is_file():
        posts = json.loads(published_path.read_text(encoding="utf-8")).get("posts", {})

    def published(phase: str) -> dict | None:
        aliases = JUJINMO_CONTENT_TYPES[phase]
        return next(
            (
                item
                for item in posts.values()
                if isinstance(item, dict)
                and item.get("status") == "published"
                and item.get("market_date") == today.isoformat()
                and item.get("content_type") in aliases
            ),
            None,
        )

    plans = []
    if krx_data.is_trading_day(today):
        plans.extend(
            [
                ("premarket", 7, 40, 8, 35),
                ("close", 15, 40, 17, 0),
            ]
        )
    if now.weekday() == 5:
        plans.extend([("weekly_review", 11, 0, 12, 0), ("glossary", 19, 0, 20, 0)])
    if now.weekday() == 6:
        plans.append(("weekly_outlook", 18, 0, 19, 0))

    for phase, expected_hour, expected_minute, due_hour, due_minute in plans:
        actual = published(phase)
        expected_at = datetime.combine(
            today,
            datetime.min.time(),
            tzinfo=KST,
        ).replace(hour=expected_hour, minute=expected_minute)
        due_at = expected_at.replace(hour=due_hour, minute=due_minute)
        job_id = f"jujinmo:{phase}:{today}"
        item = ledger.sync(
            job_id=job_id,
            account="jujinmo",
            content_type=CONTENT_TYPE_BY_PHASE[phase],
            source_key=today.isoformat(),
            expected_at=expected_at,
            due_at=due_at,
            published=actual is not None,
            permalink=(actual or {}).get("permalink"),
            now=now,
        )
        if _job_needs_alert_check(ledger, item):
            _alert_once(
                state,
                ledger,
                job_id,
                "jujinmo",
                CONTENT_TYPE_BY_PHASE[phase],
                f"{today} {phase} 콘텐츠",
                now=now,
            )
        if item["status"] == "published":
            state.pop(job_id, None)
            continue
        if item["status"] not in {"missing", "recovering", "operator_required"}:
            continue
        within_recovery_window = (
            (phase == "premarket" and now.hour < 9)
            or (phase == "close" and now.hour < 20)
            or phase in {"weekly_review", "glossary", "weekly_outlook"}
        )
        if within_recovery_window:
            _run_recovery(
                ledger,
                job_id,
                [str(HOME / "jujinmo" / ".venv" / "bin" / "python"), "src/scheduled.py", phase, "--publish"],
                cwd=HOME / "jujinmo",
            )


def check_jakkuyagu(state: dict, now: datetime, ledger: ReliabilityLedger) -> None:
    import kbo

    content_path = HOME / "jakkuyagu" / "state" / "daily_content.json"
    reels_path = HOME / "jakkuyagu" / "state" / "reels.json"
    policy = _load_jakkuyagu_feed_policy()
    entries = {}
    reels = {}
    if content_path.is_file():
        entries = json.loads(content_path.read_text(encoding="utf-8"))
    if reels_path.is_file():
        reels = json.loads(reels_path.read_text(encoding="utf-8"))
    missing_flow_jobs = []
    missing_reel_jobs = []
    for game_date in (
        now.date().isoformat(),
        (now.date() - timedelta(days=1)).isoformat(),
    ):
        day_games = [
            game
            for game in kbo.fetch_games(game_date)
            if game.get("roundCode") in {None, "kbo_r"}
            and not _jakkuyagu_game_cancelled(game)
        ]
        games = [game for game in day_games if game.get("statusCode") == "RESULT"]
        starts = [
            scheduled
            for game in day_games
            if (scheduled := _game_start(game, game_date))
        ]
        last_start = max(starts) if starts else None
        flow_decision_due = (
            last_start
            + timedelta(
                hours=float(
                    policy["flow_decision_deadline_hours_after_last_first_pitch"]
                )
                + 1
            )
            if last_start
            else None
        )
        reel_decision = reels.get(f"{game_date}:reel-policy")
        reel_decided = isinstance(reel_decision, dict) and (
            reel_decision.get("featured_game_ids") is not None
        )
        reel_decision_due = _reel_policy_alert_due(game_date, policy)
        published_reels = [
            item
            for key, item in reels.items()
            if str(key).startswith(f"{game_date}:")
            and isinstance(item, dict)
            and (item.get("status") == "published" or bool(item.get("media_id")))
        ]
        if games and last_start and int(policy["reel_per_day"]) > 0:
            reel_of_day_job = f"jakkuyagu:reel-of-day:{game_date}"
            day_end = datetime.combine(
                datetime.fromisoformat(game_date).date(),
                datetime.min.time(),
                tzinfo=KST,
            ).replace(hour=23, minute=45)
            reel_of_day_due = min(last_start + timedelta(hours=4), day_end)
            reel_of_day_state = ledger.sync(
                job_id=reel_of_day_job,
                account="jakkuyagu",
                content_type="reel-of-day",
                source_key=game_date,
                expected_at=last_start,
                due_at=reel_of_day_due,
                published=bool(published_reels),
                permalink=(published_reels[0].get("permalink") if published_reels else None),
                now=now,
            )
            if _job_needs_alert_check(ledger, reel_of_day_state):
                _alert_once(
                    state,
                    ledger,
                    reel_of_day_job,
                    "jakkuyagu",
                    "reel-of-day",
                    f"{game_date} 하루 대표 릴스 게시",
                    now=now,
                )
            if reel_of_day_state["status"] == "published":
                state.pop(reel_of_day_job, None)
        for game in games:
            game_id = str(game["gameId"])
            scheduled = _game_start(game, game_date)
            if scheduled is None:
                continue
            flow_key = f"{game_date}:flow:{game_id}"
            reel_key = f"{game_date}:flow-reel:{game_id}"
            flow = entries.get(flow_key) if isinstance(entries.get(flow_key), dict) else {}
            reel = reels.get(reel_key) if isinstance(reels.get(reel_key), dict) else {}
            flow_published = flow.get("status") == "published" or bool(flow.get("media_id"))
            flow_skipped = (
                flow.get("status") == "skipped"
                and flow.get("stage") == "feed_policy"
            )
            reel_published = reel.get("status") == "published" or bool(reel.get("media_id"))
            reel_skipped = (
                reel.get("status") == "skipped"
                and (
                    reel.get("stage") == REEL_POLICY_STAGE
                    or "skip_reason" in reel
                )
            )
            flow_job = f"jakkuyagu:flow:{game_id}"
            reel_job = f"jakkuyagu:flow-reel:{game_id}"
            flow_state = None
            if int(policy["flow_per_day"]) > 0:
                flow_due = scheduled + timedelta(hours=6)
                if flow_decision_due:
                    flow_due = max(flow_due, flow_decision_due)
                flow_state = ledger.sync(
                    job_id=flow_job,
                    account="jakkuyagu",
                    content_type="flow",
                    source_key=flow_key,
                    expected_at=scheduled + timedelta(hours=4),
                    due_at=flow_due,
                    published=flow_published,
                    permalink=flow.get("permalink"),
                    now=now,
                )
            elif ledger.get(flow_job):
                flow_state = ledger.cancel(
                    flow_job,
                    detail="flow_per_day=0 피드 발행 정책",
                    now=now,
                    policy=True,
                )
            reel_state = None
            if int(policy["reel_per_day"]) > 0 or reel_skipped:
                reel_due = scheduled + timedelta(hours=7)
                if not reel_decided:
                    reel_due = max(reel_due, reel_decision_due)
                reel_state = ledger.sync(
                    job_id=reel_job,
                    account="jakkuyagu",
                    content_type="game-flow-reel",
                    source_key=reel_key,
                    expected_at=scheduled + timedelta(hours=4, minutes=30),
                    due_at=reel_due,
                    published=reel_published,
                    permalink=reel.get("permalink"),
                    now=now,
                )
            elif ledger.get(reel_job):
                reel_state = ledger.cancel(
                    reel_job,
                    detail="reel_per_day=0 릴스 발행 정책",
                    now=now,
                    policy=True,
                )
            if flow_skipped:
                if flow_state:
                    flow_state = ledger.cancel(
                        flow_job,
                        detail=str(flow.get("skip_reason") or "피드 발행 정책에 따라 제외"),
                        now=now,
                        policy=True,
                    )
                state.pop(flow_job, None)
            if reel_skipped and reel_state:
                reel_state = ledger.cancel(
                    reel_job,
                    detail=str(
                        reel.get("skip_reason")
                        or reel.get("reason")
                        or "릴스 발행 정책에 따라 제외"
                    ),
                    now=now,
                    policy=True,
                )
                state.pop(reel_job, None)
            elif reel_state and not _flow_has_reel_source(flow):
                reel_state = ledger.cancel(
                    reel_job,
                    detail="검증된 영상 소스가 없어 그래프 캐러셀만 출고됨",
                    now=now,
                )
                state.pop(reel_job, None)
            for job_id, item, content_type in (
                (flow_job, flow_state, "flow"),
                (reel_job, reel_state, "game-flow-reel"),
            ):
                if item is None:
                    continue
                if _job_needs_alert_check(ledger, item):
                    _alert_once(
                        state,
                        ledger,
                        job_id,
                        "jakkuyagu",
                        content_type,
                        f"{game_date} {game_id}의 {content_type} 게시",
                        now=now,
                    )
                if item["status"] == "published":
                    state.pop(job_id, None)
            if flow_state and flow_state["status"] in {"missing", "recovering"}:
                missing_flow_jobs.append((flow_job, game_date))
            elif reel_state and reel_state["status"] in {"missing", "recovering"}:
                missing_reel_jobs.append((reel_job, game_date, game_id))

    if missing_flow_jobs:
        job_id, game_date = missing_flow_jobs[0]
        _run_recovery(
            ledger,
            job_id,
            [
                str(HOME / "jakkuyagu" / ".venv" / "bin" / "python"),
                "src/daily_content.py",
                "--date",
                game_date,
                "--phase",
                "flow",
                "--publish",
            ],
            cwd=HOME / "jakkuyagu",
            timeout=2700,
        )
    elif missing_reel_jobs:
        job_id, game_date, game_id = missing_reel_jobs[0]
        _run_recovery(
            ledger,
            job_id,
            [
                str(HOME / "jakkuyagu" / ".venv" / "bin" / "python"),
                "src/reel_daily.py",
                "--date",
                game_date,
                "--game-id",
                game_id,
                "--publish",
                "--lock-wait",
                "600",
            ],
            cwd=HOME / "jakkuyagu",
            timeout=1800,
        )


def _load_jakkuyagu_feed_policy() -> dict:
    path = HOME / "jakkuyagu" / "config" / "feed_policy.json"
    policy = dict(JAKKUYAGU_POLICY_DEFAULTS)
    if path.is_file():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("야있날 피드 정책 파일은 JSON 객체여야 합니다.")
        policy.update(
            {key: loaded[key] for key in JAKKUYAGU_POLICY_DEFAULTS if key in loaded}
        )
    for key in ("flow_per_day", "reel_per_day"):
        value = policy[key]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"야있날 피드 정책 {key}는 0 이상의 정수여야 합니다.")
    try:
        deadline_hours = float(
            policy["flow_decision_deadline_hours_after_last_first_pitch"]
        )
    except (TypeError, ValueError) as error:
        raise ValueError("야있날 flow 결정 시한이 숫자가 아닙니다.") from error
    if deadline_hours < 0:
        raise ValueError("야있날 flow 결정 시한은 0 이상이어야 합니다.")
    policy["flow_decision_deadline_hours_after_last_first_pitch"] = deadline_hours
    try:
        hour, minute = (
            int(value)
            for value in str(policy["reel_decision_deadline_kst"]).split(":")
        )
    except (TypeError, ValueError) as error:
        raise ValueError("야있날 릴스 결정 시한은 HH:MM 형식이어야 합니다.") from error
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("야있날 릴스 결정 시한은 HH:MM 형식이어야 합니다.")
    return policy


def _jakkuyagu_game_cancelled(game: dict) -> bool:
    return bool(game.get("cancel")) or str(game.get("statusCode") or "").upper() in {
        "CANCEL",
        "CANCELED",
        "CANCELLED",
    }


def _game_start(game: dict, game_date: str) -> datetime | None:
    value = str(game.get("gameDateTime") or game_date)
    try:
        scheduled = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if scheduled.tzinfo is None:
        scheduled = scheduled.replace(tzinfo=KST)
    return scheduled.astimezone(KST)


def _reel_policy_alert_due(game_date: str, policy: dict) -> datetime:
    hour, minute = (
        int(value) for value in str(policy["reel_decision_deadline_kst"]).split(":")
    )
    return datetime.combine(
        datetime.fromisoformat(game_date).date(), datetime.min.time(), tzinfo=KST
    ).replace(hour=hour, minute=minute) + timedelta(hours=1)


def _flow_has_reel_source(flow: dict) -> bool:
    """Return false only when an existing manifest explicitly has no verified clips."""
    value = flow.get("manifest_path")
    if not value:
        return True
    manifest_path = Path(str(value))
    if not manifest_path.is_file():
        return True
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        config_value = manifest.get("game_config")
        if not config_value:
            return True
        config_path = Path(str(config_value))
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    fallback = (config.get("verification") or {}).get("release_fallback") or {}
    return not (
        not config.get("clips")
        and str(fallback.get("mode", "")).endswith("graph_only")
    )


def check_gonggu(state: dict, now: datetime, ledger: ReliabilityLedger) -> None:
    """Check the daily gonggu publication; its systemd timer owns retries."""
    if not GONGGU_STATUS_PATH.is_file():
        print(f"안내: 공구함 상태 파일 없음 — {GONGGU_STATUS_PATH}")
        return

    status = json.loads(GONGGU_STATUS_PATH.read_text(encoding="utf-8"))
    today = now.astimezone(KST).date()
    today_text = today.isoformat()
    publication_state = status.get("state") if status.get("publication_date") == today_text else None
    published = publication_state in {"published", "already_published"}
    expected_at = datetime.combine(today, datetime.min.time(), tzinfo=KST).replace(
        hour=10, minute=35
    )
    due_at = expected_at.replace(hour=11, minute=50)
    job_id = f"gonggu:daily:{today_text}"
    item = ledger.sync(
        job_id=job_id,
        account="gonggu",
        content_type="gonggu-daily",
        source_key=today_text,
        expected_at=expected_at,
        due_at=due_at,
        published=published,
        permalink=status.get("permalink") if published else None,
        now=now,
    )

    if published:
        if _job_needs_alert_check(ledger, item):
            _alert_once(
                state,
                ledger,
                job_id,
                "gonggu",
                "gonggu-daily",
                f"{today_text} 공구 일일 다이제스트",
                now=now,
            )
        state.pop(job_id, None)
        return
    if publication_state == "skipped":
        ledger.cancel(
            job_id,
            detail=str(status.get("detail") or "공구함 게시가 의도적으로 건너뛰어짐"),
            now=now,
            policy=True,
        )
        state.pop(job_id, None)
        return
    if publication_state == "failed" or item["status"] in {
        "missing",
        "recovering",
        "operator_required",
    }:
        detail = status.get("detail") if publication_state == "failed" else None
        message = detail or f"{today_text} 공구 일일 다이제스트가 마감 시각까지 게시되지 않았습니다."
        _alert_once(
            state,
            ledger,
            job_id,
            "gonggu",
            "gonggu-daily",
            str(message),
            now=now,
            force_initial=publication_state == "failed",
        )


def check_sector4(state: dict, now_utc: datetime, ledger: ReliabilityLedger) -> None:
    import f1data

    posted = set()
    posted_path = HOME / "sector4" / "state" / "posted.json"
    if posted_path.is_file():
        posted = set(json.loads(posted_path.read_text(encoding="utf-8")))
    reels = {}
    reels_path = HOME / "sector4" / "state" / "reels.json"
    if reels_path.is_file():
        reels = json.loads(reels_path.read_text(encoding="utf-8"))

    def session_start(race: dict, field: str) -> datetime | None:
        if field == "Race":
            date_value, time_value = race.get("date"), race.get("time")
        else:
            session = race.get(field)
            if not isinstance(session, dict):
                return None
            date_value, time_value = session.get("date"), session.get("time")
        if not date_value:
            return None
        return datetime.fromisoformat(
            f"{date_value}T{str(time_value or '00:00:00Z').replace('Z', '+00:00')}"
        )

    for race in f1data.schedule(now_utc.year):
        season = now_utc.year
        rnd = int(race["round"])
        missing_carousel_job = None
        for field, task, due_hours in (
            ("SprintQualifying", "sprintquali", 3),
            ("Sprint", "sprintresult", 4),
            ("Qualifying", "quali", 3),
            ("Race", "result", 14),
        ):
            started_at = session_start(race, field)
            if started_at is None or not (started_at < now_utc < started_at + timedelta(days=7)):
                continue
            key = f"{season}-r{rnd:02d}" if task == "result" else f"{task}-{season}-r{rnd:02d}"
            job_id = f"sector4:{task}:{season}-r{rnd:02d}"
            item = ledger.sync(
                job_id=job_id,
                account="sector4",
                content_type=task,
                source_key=key,
                expected_at=started_at + timedelta(hours=2),
                due_at=started_at + timedelta(hours=due_hours),
                published=key in posted,
                now=now_utc,
            )
            if _job_needs_alert_check(ledger, item):
                _alert_once(
                    state,
                    ledger,
                    job_id,
                    "sector4",
                    task,
                    f"{race.get('raceName', key)} {task}",
                    now=now_utc,
                )
            if item["status"] == "published":
                state.pop(job_id, None)
            elif item["status"] in {"missing", "recovering", "operator_required"}:
                if item["status"] != "operator_required":
                    missing_carousel_job = missing_carousel_job or job_id

        missing_reel_job = None
        missing_reel_session = None
        for session_type, field, expected_hours, due_hours in (
            ("sprint", "Sprint", 2, 10),
            ("race", "Race", 3, 18),
        ):
            started_at = session_start(race, field)
            if started_at is None or not (started_at < now_utc < started_at + timedelta(days=7)):
                continue
            reel_key = f"{session_type}-reel-{season}-r{rnd:02d}"
            reel = reels.get(reel_key) if isinstance(reels.get(reel_key), dict) else {}
            reel_published = reel.get("status") == "published" or bool(reel.get("media_id"))
            reel_job = f"sector4:{session_type}-reel:{season}-r{rnd:02d}"
            reel_item = ledger.sync(
                job_id=reel_job,
                account="sector4",
                content_type=f"{session_type}-replay-reel",
                source_key=reel_key,
                expected_at=started_at + timedelta(hours=expected_hours),
                due_at=started_at + timedelta(hours=due_hours),
                published=reel_published,
                permalink=reel.get("permalink"),
                now=now_utc,
            )
            if _job_needs_alert_check(ledger, reel_item):
                _alert_once(
                    state,
                    ledger,
                    reel_job,
                    "sector4",
                    f"{session_type}-replay-reel",
                    f"{race.get('raceName', reel_key)} {session_type} 순위 변화 릴스",
                    now=now_utc,
                )
            if reel_item["status"] == "published":
                state.pop(reel_job, None)
            elif reel_item["status"] in {"missing", "recovering", "operator_required"}:
                if reel_item["status"] != "operator_required" and missing_reel_job is None:
                    missing_reel_job = reel_job
                    missing_reel_session = session_type

        if missing_carousel_job:
            _run_recovery(
                ledger,
                missing_carousel_job,
                [str(HOME / "sector4" / ".venv" / "bin" / "python"), "src/poller.py"],
                cwd=HOME / "sector4",
                timeout=2700,
            )
        elif missing_reel_job and missing_reel_session:
            _run_recovery(
                ledger,
                missing_reel_job,
                [
                    str(HOME / "sector4" / ".venv" / "bin" / "python"),
                    "src/reel_poller.py",
                    "--season",
                    str(season),
                    "--round",
                    str(rnd),
                    "--session",
                    missing_reel_session,
                    "--publish",
                ],
                cwd=HOME / "sector4",
                timeout=2700,
            )


def collect_portfolio_once(state: dict, now: datetime) -> None:
    """매일 21시 이후 한 번, 네 계정의 읽기 전용 Insights 스냅샷을 남긴다."""
    date_key = now.date().isoformat()
    if now.hour < 21 or state.get("_instagram_insights_date") == date_key:
        return
    from instagram_portfolio import collect_portfolio

    payload = collect_portfolio(
        home=HOME,
        output=INSIGHTS_PATH,
        accounts=list(INSIGHTS_ACCOUNTS),
    )
    accounts = payload["latest"]["accounts"]
    successes = [name for name, result in accounts.items() if not result.get("error")]
    failures = [name for name, result in accounts.items() if result.get("error")]
    if not successes:
        raise RuntimeError("네 계정 Insights 수집이 모두 실패함")
    state["_instagram_insights_date"] = date_key
    state["_instagram_insights_accounts"] = successes
    print(
        "Instagram Insights 수집: "
        + ", ".join(successes)
        + (f" · 실패: {', '.join(failures)}" if failures else "")
    )


def _notify_digest(title: str, body: str) -> bool:
    env = _env(HOME / "jujinmo" / ".env")
    url = env.get("INSTAGRAM_NOTIFY_URL", "")
    secret = env.get("INSTAGRAM_NOTIFY_SECRET", "")
    if not url or not secret:
        return False
    payload = {"status": "digest", "title": title, "body": body}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()
    response = requests.post(
        url,
        data=data,
        headers={"Content-Type": "application/json", "X-Instagram-Signature": signature},
        timeout=15,
    )
    return response.ok


def weekly_digest_once(
    state: dict, now: datetime, ledger: ReliabilityLedger | None = None
) -> None:
    """일요일 21시 수집 뒤 한 번, 네 계정 성장·성과 요약을 디스코드로 보낸다."""
    week_key = f"{now.isocalendar().year}-w{now.isocalendar().week:02d}"
    if (
        now.weekday() != 6
        or now.hour < 21
        or state.get("_instagram_weekly_digest") == week_key
        or state.get("_instagram_insights_date") != now.date().isoformat()
    ):
        return
    data = json.loads(INSIGHTS_PATH.read_text(encoding="utf-8"))
    reliability_summary = (
        ledger.weekly_alert_summary(now - timedelta(days=7), now) if ledger else None
    )
    lines = build_weekly_digest_lines(data, now, reliability_summary)
    title = f"주간 인스타 리포트 · {week_key}"
    if _notify_digest(title, "\n".join(lines)):
        state["_instagram_weekly_digest"] = week_key
        print(f"주간 다이제스트 발송: {week_key}")


def build_weekly_digest_lines(
    data: dict,
    now: datetime,
    reliability_summary: dict[str, int] | None = None,
) -> list[str]:
    """insights 파일에서 계정별 성장·퍼널·실험·중단 후보 요약 줄을 만든다(순수 함수)."""
    latest = data["latest"]["accounts"]
    performance_feedback = data.get("performance_feedback") or {}
    history = data.get("history") or []
    week_ago = (now - timedelta(days=7)).date().isoformat()
    baseline = next(
        (
            entry
            for entry in history
            if str(entry.get("collected_at") or entry.get("date") or "")[:10] <= week_ago
        ),
        None,
    )
    lines = []
    if reliability_summary is not None:
        lines.append(
            "지난주 알림 "
            f"{reliability_summary['alerts']}건 / 실제 미게시 "
            f"{reliability_summary['actual_missing']}건 / 정책 취소 "
            f"{reliability_summary['policy_cancelled']}건"
        )
    account_names = [name for name in INSIGHTS_ACCOUNTS if name in latest]
    account_names.extend(name for name in latest if name not in INSIGHTS_ACCOUNTS)
    for name in account_names:
        account = latest[name]
        if account.get("error"):
            lines.append(f"**{name}** — 수집 실패")
            continue
        profile = account.get("profile") or {}
        followers = profile.get("followers_count")
        delta = ""
        if baseline:
            base_profile = (
                (baseline.get("accounts") or {}).get(name) or {}
            ).get("profile") or {}
            base_followers = base_profile.get("followers_count")
            if isinstance(base_followers, int) and isinstance(followers, int):
                delta = f" ({followers - base_followers:+d})"
        metrics = (account.get("account_metrics") or {}).get("metrics") or {}
        lines.append(
            f"**{account.get('handle', name)}** — 팔로워 {followers}{delta} · "
            f"게시물 {profile.get('media_count')} · "
            f"일간 조회 {metrics.get('views', '—')} · 도달 {metrics.get('reach', '—')}"
        )
        account_feedback = performance_feedback.get(name) or {}
        outcomes = account_feedback.get("account_outcomes") or {}
        visit_rate = outcomes.get("profile_visits_per_1000_reach")
        funnel_parts = []
        if isinstance(visit_rate, (int, float)):
            funnel_parts.append(
                f"도달 1,000당 프로필 방문 {visit_rate:g} (방문 {outcomes.get('profile_views_1d', '—')})"
            )
        elif isinstance(outcomes.get("profile_views_1d"), (int, float)):
            funnel_parts.append(
                f"프로필 방문 {outcomes['profile_views_1d']} (도달 {outcomes.get('reach_1d', '—')}, 비율 표본 부족)"
            )
        if isinstance(outcomes.get("follower_delta_7d"), int):
            funnel_parts.append(
                f"팔로워 {outcomes['follower_delta_7d']:+d} "
                f"({outcomes.get('follower_delta_window_days', '?')}일 창)"
            )
        if funnel_parts:
            lines.append("  ↳ 퍼널: " + " · ".join(funnel_parts))
        records = [
            record
            for record in account.get("records") or []
            if str(record.get("published_at") or "")[:10] >= week_ago
            and isinstance((record.get("metrics") or {}).get("reach"), (int, float))
        ]
        if records:
            top = max(records, key=lambda record: record["metrics"]["reach"])
            lines.append(
                f"  ↳ 이번 주 최고 도달: {top.get('series', '?')} · "
                f"도달 {top['metrics']['reach']} · {top.get('permalink', '')}"
            )
        ready_experiments = []
        for series, item in (account_feedback.get("series") or {}).items():
            if item.get("status") != "ready":
                continue
            experiment = item.get("experiment") or {}
            if experiment.get("variable") == "pause_series":
                continue  # 중단 후보는 아래 줄에 따로 적는다.
            ready_experiments.append(
                f"{series}={experiment.get('variable', 'observe')}"
            )
        if ready_experiments:
            lines.append("  ↳ 다음 실험: " + " · ".join(ready_experiments[:3]))
        pause_candidates = account_feedback.get("pause_candidates") or []
        if pause_candidates:
            lines.append(
                "  ↳ 중단 후보 시리즈: "
                + " · ".join(
                    f"{item.get('series')}({item.get('format', '?')}, "
                    f"{item.get('posts', '?')}편, 도달 중앙값 {item.get('median_reach', '?')})"
                    for item in pause_candidates[:4]
                )
            )
    return lines


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--reset-recovery",
        metavar="GLOB",
        help="미해결 작업의 복구 횟수 초기화(예: jakkuyagu:flow-reel:*)",
    )
    args = parser.parse_args(argv)
    if args.reset_recovery:
        ledger = ReliabilityLedger(LEDGER_PATH)
        try:
            count = ledger.reset_recovery(args.reset_recovery)
        finally:
            ledger.close()
        print(f"복구 시도 초기화: {args.reset_recovery} — {count}건")
        return

    now = datetime.now(KST)
    state = _load_state()
    ledger = ReliabilityLedger(LEDGER_PATH)
    for name, check, arg in (
        ("jujinmo", check_jujinmo, now),
        ("jakkuyagu", check_jakkuyagu, now),
        ("sector4", check_sector4, datetime.now(timezone.utc)),
        ("gonggu", check_gonggu, now),
    ):
        try:
            check(state, arg, ledger)
        except Exception as error:  # noqa: BLE001 - 한 계정 실패가 다른 검사를 막지 않는다
            print(f"warning: {name} 검사 실패 — {type(error).__name__}: {error}")
    try:
        outbox = flush_notification_outboxes()
        if outbox["sent"] or outbox["remaining"]:
            print(f"알림 아웃박스: 전송 {outbox['sent']}건 · 대기 {outbox['remaining']}건")
    except Exception as error:  # 알림 재전송 실패가 콘텐츠 복구를 막지 않는다.
        print(f"warning: 알림 아웃박스 처리 실패 — {type(error).__name__}: {error}")
    try:
        collect_portfolio_once(state, now)
    except Exception as error:  # 성과 수집 실패가 게시 침묵 감시를 막지 않는다.
        print(f"warning: Insights 수집 실패 — {type(error).__name__}: {error}")
    try:
        weekly_digest_once(state, now, ledger)
    except Exception as error:  # 리포트 실패가 감시를 막지 않는다.
        print(f"warning: 주간 다이제스트 실패 — {type(error).__name__}: {error}")
    _save_state(state)
    ledger.close()


if __name__ == "__main__":
    main()
