#!/usr/bin/env python3
"""인스타 파이프라인 침묵 실패 워치독.

크론이 아예 돌지 않거나 조용히 죽으면 실패 알림도 없다(2026-08-24 디스크 풀 사고).
그래서 "나와야 할 게시물이 마감 시한까지 안 나왔는지"를 기대 캘린더와 실제 게시
상태를 대조해 감지하고, 기존 인스타 알림 웹훅(실패 임베드)으로 경고한다.

EC2 호스트 크론(15분 간격)에서 /home/ubuntu/jujinmo/.venv/bin/python 으로 실행한다.
같은 경고는 알림 키 단위로 6시간 동안 중복 발송하지 않는다(state.json).
"""

from __future__ import annotations

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
        detail = (result.stderr or result.stdout or "no output").strip()[-1000:]
        ledger.record_recovery(
            job_id,
            succeeded=result.returncode == 0,
            detail=f"exit={result.returncode}: {detail}",
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


def _alert_once(state: dict, key: str, account: str, content_type: str, message: str) -> None:
    previous = state.get(key)
    if isinstance(previous, str):
        try:
            if datetime.now(KST) < datetime.fromisoformat(previous) + timedelta(hours=6):
                return
        except ValueError:
            pass
    print(f"경고 발송: {key} — {message}")
    if _notify(account, content_type, key, message):
        state[key] = datetime.now(KST).isoformat(timespec="seconds")


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
        if item["status"] == "published":
            state.pop(job_id, None)
            continue
        if item["status"] not in {"missing", "recovering", "operator_required"}:
            continue
        _alert_once(
            state,
            job_id,
            "jujinmo",
            CONTENT_TYPE_BY_PHASE[phase],
            f"{today} {phase} 콘텐츠가 마감 시각까지 게시되지 않아 자동 복구를 시도합니다.",
        )
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
        games = [
            game
            for game in kbo.fetch_games(game_date)
            if game.get("statusCode") == "RESULT" and not game.get("cancel")
        ]
        for game in games:
            game_id = str(game["gameId"])
            scheduled = datetime.fromisoformat(str(game.get("gameDateTime") or game_date))
            if scheduled.tzinfo is None:
                scheduled = scheduled.replace(tzinfo=KST)
            flow_key = f"{game_date}:flow:{game_id}"
            reel_key = f"{game_date}:flow-reel:{game_id}"
            flow = entries.get(flow_key) if isinstance(entries.get(flow_key), dict) else {}
            reel = reels.get(reel_key) if isinstance(reels.get(reel_key), dict) else {}
            flow_published = flow.get("status") == "published" or bool(flow.get("media_id"))
            reel_published = reel.get("status") == "published" or bool(reel.get("media_id"))
            flow_job = f"jakkuyagu:flow:{game_id}"
            reel_job = f"jakkuyagu:flow-reel:{game_id}"
            flow_state = ledger.sync(
                job_id=flow_job,
                account="jakkuyagu",
                content_type="flow",
                source_key=flow_key,
                expected_at=scheduled + timedelta(hours=4),
                due_at=scheduled + timedelta(hours=6),
                published=flow_published,
                permalink=flow.get("permalink"),
                now=now,
            )
            reel_state = ledger.sync(
                job_id=reel_job,
                account="jakkuyagu",
                content_type="game-flow-reel",
                source_key=reel_key,
                expected_at=scheduled + timedelta(hours=4, minutes=30),
                due_at=scheduled + timedelta(hours=7),
                published=reel_published,
                permalink=reel.get("permalink"),
                now=now,
            )
            if flow_published and not _flow_has_reel_source(flow):
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
                if item["status"] == "published":
                    state.pop(job_id, None)
                elif item["status"] in {"missing", "recovering", "operator_required"}:
                    _alert_once(
                        state,
                        job_id,
                        "jakkuyagu",
                        content_type,
                        f"{game_date} {game_id}의 {content_type} 게시가 지연되어 자동 복구를 시도합니다.",
                    )
            if flow_state["status"] in {"missing", "recovering"}:
                missing_flow_jobs.append((flow_job, game_date))
            elif flow_published and reel_state["status"] in {"missing", "recovering"}:
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
            ],
            cwd=HOME / "jakkuyagu",
            timeout=2700,
        )


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
            if item["status"] == "published":
                state.pop(job_id, None)
            elif item["status"] in {"missing", "recovering", "operator_required"}:
                _alert_once(
                    state,
                    job_id,
                    "sector4",
                    task,
                    f"{race.get('raceName', key)} {task} 게시가 지연되어 자동 복구를 시도합니다.",
                )
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
            if reel_item["status"] == "published":
                state.pop(reel_job, None)
            elif reel_item["status"] in {"missing", "recovering", "operator_required"}:
                _alert_once(
                    state,
                    reel_job,
                    "sector4",
                    f"{session_type}-replay-reel",
                    f"{race.get('raceName', reel_key)} {session_type} 순위 변화 릴스가 지연되어 자동 복구를 시도합니다.",
                )
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
    """매일 21시 이후 한 번, 세 계정의 읽기 전용 Insights 스냅샷을 남긴다."""
    date_key = now.date().isoformat()
    if now.hour < 21 or state.get("_instagram_insights_date") == date_key:
        return
    from instagram_portfolio import collect_portfolio

    payload = collect_portfolio(home=HOME, output=INSIGHTS_PATH)
    accounts = payload["latest"]["accounts"]
    successes = [name for name, result in accounts.items() if not result.get("error")]
    failures = [name for name, result in accounts.items() if result.get("error")]
    if not successes:
        raise RuntimeError("세 계정 Insights 수집이 모두 실패함")
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


def weekly_digest_once(state: dict, now: datetime) -> None:
    """일요일 21시 수집 뒤 한 번, 세 계정 성장·성과 요약을 디스코드로 보낸다."""
    week_key = f"{now.isocalendar().year}-w{now.isocalendar().week:02d}"
    if (
        now.weekday() != 6
        or now.hour < 21
        or state.get("_instagram_weekly_digest") == week_key
        or state.get("_instagram_insights_date") != now.date().isoformat()
    ):
        return
    data = json.loads(INSIGHTS_PATH.read_text(encoding="utf-8"))
    lines = build_weekly_digest_lines(data, now)
    title = f"주간 인스타 리포트 · {week_key}"
    if _notify_digest(title, "\n".join(lines)):
        state["_instagram_weekly_digest"] = week_key
        print(f"주간 다이제스트 발송: {week_key}")


def build_weekly_digest_lines(data: dict, now: datetime) -> list[str]:
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
    for name, account in latest.items():
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


def main() -> None:
    now = datetime.now(KST)
    state = _load_state()
    ledger = ReliabilityLedger(LEDGER_PATH)
    for name, check, arg in (
        ("jujinmo", check_jujinmo, now),
        ("jakkuyagu", check_jakkuyagu, now),
        ("sector4", check_sector4, datetime.now(timezone.utc)),
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
        weekly_digest_once(state, now)
    except Exception as error:  # 리포트 실패가 감시를 막지 않는다.
        print(f"warning: 주간 다이제스트 실패 — {type(error).__name__}: {error}")
    _save_state(state)
    ledger.close()


if __name__ == "__main__":
    main()
