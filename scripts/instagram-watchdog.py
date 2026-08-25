#!/usr/bin/env python3
"""인스타 파이프라인 침묵 실패 워치독.

크론이 아예 돌지 않거나 조용히 죽으면 실패 알림도 없다(2026-08-24 디스크 풀 사고).
그래서 "나와야 할 게시물이 마감 시한까지 안 나왔는지"를 기대 캘린더와 실제 게시
상태를 대조해 감지하고, 기존 인스타 알림 웹훅(실패 임베드)으로 경고한다.

EC2 호스트 크론(매시)에서 /home/ubuntu/jujinmo/.venv/bin/python 으로 실행한다.
같은 경고는 알림 키 단위로 한 번만 보낸다(state.json).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

KST = timezone(timedelta(hours=9))
HOME = Path("/home/ubuntu")
STATE_PATH = HOME / "ops-watchdog" / "state.json"

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


def _notify(account: str, content_type: str, source_key: str, message: str) -> bool:
    env = _env(HOME / "jujinmo" / ".env")
    url = env.get("INSTAGRAM_NOTIFY_URL", "")
    secret = env.get("INSTAGRAM_NOTIFY_SECRET", "")
    if not url or not secret:
        print("warning: 알림 설정 없음")
        return False
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
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    response = requests.post(
        url,
        data=body,
        headers={"Content-Type": "application/json", "X-Instagram-Signature": signature},
        timeout=15,
    )
    return response.ok


def _alert_once(state: dict, key: str, account: str, content_type: str, message: str) -> None:
    if key in state:
        return
    print(f"경고 발송: {key} — {message}")
    if _notify(account, content_type, key, message):
        state[key] = datetime.now(KST).isoformat(timespec="seconds")


def check_jujinmo(state: dict, now: datetime) -> None:
    import krx_data

    today = now.date()
    if not krx_data.is_trading_day(today):
        return
    published_path = HOME / "jujinmo" / "state" / "published.json"
    posts = {}
    if published_path.is_file():
        posts = json.loads(published_path.read_text(encoding="utf-8")).get("posts", {})

    def published(content_type: str) -> bool:
        return any(
            item.get("status") == "published"
            and item.get("market_date") == today.isoformat()
            and item.get("content_type") == content_type
            for item in posts.values()
            if isinstance(item, dict)
        )

    if now.hour * 60 + now.minute >= 9 * 60 + 35 and not published("premarket_preview"):
        _alert_once(
            state, f"jujinmo:premarket:{today}", "jujinmo", "premarket_preview",
            f"{today} 거래일 장전 릴스가 09:35까지 게시되지 않았습니다. 크론·로그 확인 필요.",
        )
    if now.hour >= 17 and published("premarket_preview") and not published("close_review"):
        _alert_once(
            state, f"jujinmo:close:{today}", "jujinmo", "close_review",
            f"{today} 마감 릴스가 17:00까지 게시되지 않았습니다(장전은 게시됨). 크론·로그 확인 필요.",
        )


def check_jakkuyagu(state: dict, now: datetime) -> None:
    if now.hour < 10:
        return
    import kbo

    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    games = [g for g in kbo.fetch_games(yesterday) if g.get("statusCode") == "RESULT"]
    if not games:
        return
    content_path = HOME / "jakkuyagu" / "state" / "daily_content.json"
    entries = {}
    if content_path.is_file():
        entries = json.loads(content_path.read_text(encoding="utf-8"))
    missing = []
    for game in games:
        item = entries.get(f"{yesterday}:flow:{game['gameId']}") or {}
        if not (item.get("status") == "published" or item.get("media_id")):
            missing.append(game["gameId"])
    if missing:
        _alert_once(
            state, f"jakkuyagu:flow:{yesterday}", "jakkuyagu", "flow",
            f"{yesterday} 종료 경기 {len(games)}건 중 {len(missing)}건의 승부의 흐름이 "
            f"다음날 10:00까지 게시되지 않았습니다: {', '.join(missing)}",
        )


def check_sector4(state: dict, now_utc: datetime) -> None:
    import f1data

    posted = []
    posted_path = HOME / "sector4" / "state" / "posted.json"
    if posted_path.is_file():
        posted = json.loads(posted_path.read_text(encoding="utf-8"))
    for race in f1data.schedule(now_utc.year):
        time_part = race.get("time") or "14:00:00Z"
        race_start = datetime.fromisoformat(
            f"{race['date']}T{time_part.replace('Z', '+00:00')}"
        )
        deadline = race_start + timedelta(hours=14)
        if not (deadline < now_utc < race_start + timedelta(days=7)):
            continue
        key = f"{now_utc.year}-r{int(race['round']):02d}"
        if key not in posted:
            _alert_once(
                state, f"sector4:result:{key}", "sector4", "result",
                f"{race.get('raceName', key)} 결과 게시물이 레이스 종료 후 12시간이 지나도 "
                f"게시되지 않았습니다({key}). 폴러·로그 확인 필요.",
            )


def main() -> None:
    now = datetime.now(KST)
    state = _load_state()
    for name, check, arg in (
        ("jujinmo", check_jujinmo, now),
        ("jakkuyagu", check_jakkuyagu, now),
        ("sector4", check_sector4, datetime.now(timezone.utc)),
    ):
        try:
            check(state, arg)
        except Exception as error:  # noqa: BLE001 - 한 계정 실패가 다른 검사를 막지 않는다
            print(f"warning: {name} 검사 실패 — {type(error).__name__}: {error}")
    _save_state(state)


if __name__ == "__main__":
    main()
