#!/usr/bin/env python3
"""Durable expected-vs-actual job ledger for Instagram automations."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


STATUSES = {"expected", "missing", "recovering", "published", "cancelled", "operator_required"}


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


class ReliabilityLedger:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                account TEXT NOT NULL,
                content_type TEXT NOT NULL,
                source_key TEXT NOT NULL,
                expected_at TEXT NOT NULL,
                due_at TEXT NOT NULL,
                status TEXT NOT NULL,
                permalink TEXT,
                last_error TEXT,
                recovery_attempts INTEGER NOT NULL DEFAULT 0,
                next_recovery_at TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                resolved_at TEXT,
                alert_stage TEXT,
                alerted_at TEXT,
                policy_cancelled INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self._migrate_jobs_table()
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS alert_events (
                job_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                sent_at TEXT NOT NULL,
                PRIMARY KEY (job_id, stage)
            )
            """
        )
        self.connection.commit()

    def _migrate_jobs_table(self) -> None:
        """기존 운영 DB에 알림 상태 컬럼을 비파괴적으로 추가한다."""
        columns = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(jobs)").fetchall()
        }
        additions = {
            "alert_stage": "TEXT",
            "alerted_at": "TEXT",
            "policy_cancelled": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in additions.items():
            if name not in columns:
                self.connection.execute(
                    f"ALTER TABLE jobs ADD COLUMN {name} {definition}"
                )

    def close(self) -> None:
        self.connection.close()

    def sync(
        self,
        *,
        job_id: str,
        account: str,
        content_type: str,
        source_key: str,
        expected_at: datetime,
        due_at: datetime,
        published: bool,
        permalink: str | None = None,
        now: datetime | None = None,
    ) -> dict:
        now = now or datetime.now(timezone.utc)
        current = self.get(job_id)
        if published:
            status = "published"
        elif (
            current
            and current["status"] in {"missing", "recovering"}
            and now < due_at
        ):
            status = "expected"
        elif current and current["status"] in {
            "recovering", "operator_required", "cancelled",
        }:
            status = current["status"]
        elif now >= due_at:
            status = "missing"
        else:
            status = "expected"
        stamp = _timestamp(now)
        if current:
            self.connection.execute(
                """
                UPDATE jobs
                SET account=?, content_type=?, source_key=?, expected_at=?, due_at=?,
                    status=?, permalink=COALESCE(?, permalink), updated_at=?,
                    resolved_at=CASE WHEN ?='published' THEN ? ELSE resolved_at END,
                    next_recovery_at=CASE
                        WHEN ? IN ('expected', 'published') THEN NULL
                        ELSE next_recovery_at
                    END
                WHERE job_id=?
                """,
                (
                    account,
                    content_type,
                    source_key,
                    expected_at.isoformat(),
                    due_at.isoformat(),
                    status,
                    permalink,
                    stamp,
                    status,
                    stamp,
                    status,
                    job_id,
                ),
            )
        else:
            self.connection.execute(
                """
                INSERT INTO jobs (
                    job_id, account, content_type, source_key, expected_at, due_at,
                    status, permalink, first_seen_at, updated_at, resolved_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    account,
                    content_type,
                    source_key,
                    expected_at.isoformat(),
                    due_at.isoformat(),
                    status,
                    permalink,
                    stamp,
                    stamp,
                    stamp if published else None,
                ),
            )
        self.connection.commit()
        return self.get(job_id) or {}

    def due_for_recovery(self, job_id: str, now: datetime | None = None) -> bool:
        now = now or datetime.now(timezone.utc)
        item = self.get(job_id)
        if not item or item["status"] not in {"missing", "recovering"}:
            return False
        next_at = item.get("next_recovery_at")
        return not next_at or now >= datetime.fromisoformat(next_at)

    def record_recovery(
        self,
        job_id: str,
        *,
        succeeded: bool,
        detail: str,
        now: datetime | None = None,
    ) -> dict:
        now = now or datetime.now(timezone.utc)
        item = self.get(job_id)
        if not item:
            raise KeyError(job_id)
        attempts = int(item["recovery_attempts"]) + 1
        if succeeded:
            status = "recovering"
            delay = min(15 * (2 ** max(0, attempts - 1)), 180)
            next_at = now + timedelta(minutes=delay)
        elif attempts >= 4:
            status = "operator_required"
            next_at = None
        else:
            status = "missing"
            delay = min(15 * (2 ** max(0, attempts - 1)), 180)
            next_at = now + timedelta(minutes=delay)
        self.connection.execute(
            """
            UPDATE jobs
            SET status=?, recovery_attempts=?, next_recovery_at=?, last_error=?, updated_at=?
                , resolved_at=CASE WHEN ?='operator_required' THEN ? ELSE resolved_at END
            WHERE job_id=?
            """,
            (
                status,
                attempts,
                next_at.isoformat() if next_at else None,
                detail[:1000],
                _timestamp(now),
                status,
                _timestamp(now),
                job_id,
            ),
        )
        self.connection.commit()
        return self.get(job_id) or {}

    def defer_recovery(
        self,
        job_id: str,
        *,
        detail: str,
        now: datetime | None = None,
        delay_minutes: int = 5,
    ) -> dict:
        """일시적인 외부 락 충돌은 시도 횟수를 쓰지 않고 다음 틱으로 미룬다."""
        now = now or datetime.now(timezone.utc)
        if not self.get(job_id):
            raise KeyError(job_id)
        next_at = now + timedelta(minutes=max(0, delay_minutes))
        self.connection.execute(
            """
            UPDATE jobs
            SET status='recovering', next_recovery_at=?, last_error=?, updated_at=?
            WHERE job_id=?
            """,
            (next_at.isoformat(), detail[:1000], _timestamp(now), job_id),
        )
        self.connection.commit()
        return self.get(job_id) or {}

    def reset_recovery(
        self,
        pattern: str,
        *,
        now: datetime | None = None,
    ) -> int:
        """GLOB 패턴과 일치하는 미해결 작업의 복구 횟수를 운영자가 초기화한다."""
        now = now or datetime.now(timezone.utc)
        cursor = self.connection.execute(
            """
            UPDATE jobs
            SET status='missing', recovery_attempts=0, next_recovery_at=NULL,
                last_error='운영자 복구 시도 초기화', updated_at=?
            WHERE job_id GLOB ?
              AND status IN ('missing', 'recovering', 'operator_required')
            """,
            (_timestamp(now), pattern),
        )
        self.connection.commit()
        return cursor.rowcount

    def cancel(
        self,
        job_id: str,
        *,
        detail: str,
        now: datetime | None = None,
        policy: bool = False,
    ) -> dict:
        now = now or datetime.now(timezone.utc)
        if not self.get(job_id):
            raise KeyError(job_id)
        self.connection.execute(
            """
            UPDATE jobs
            SET status='cancelled', last_error=?, next_recovery_at=NULL,
                updated_at=?, resolved_at=COALESCE(resolved_at, ?), policy_cancelled=?
            WHERE job_id=?
            """,
            (
                detail[:1000],
                _timestamp(now),
                _timestamp(now),
                int(policy),
                job_id,
            ),
        )
        self.connection.commit()
        return self.get(job_id) or {}

    def alert_time(self, job_id: str, stage: str) -> datetime | None:
        row = self.connection.execute(
            "SELECT sent_at FROM alert_events WHERE job_id=? AND stage=?",
            (job_id, stage),
        ).fetchone()
        return datetime.fromisoformat(row["sent_at"]) if row else None

    def has_final_alert(self, job_id: str) -> bool:
        row = self.connection.execute(
            """
            SELECT 1 FROM alert_events
            WHERE job_id=? AND stage LIKE 'final_%'
            LIMIT 1
            """,
            (job_id,),
        ).fetchone()
        return row is not None

    def record_alert(
        self,
        job_id: str,
        stage: str,
        *,
        now: datetime | None = None,
    ) -> bool:
        """성공적으로 보낸 job 알림 단계를 중복 없이 기록한다."""
        now = now or datetime.now(timezone.utc)
        stamp = _timestamp(now)
        cursor = self.connection.execute(
            """
            INSERT OR IGNORE INTO alert_events (job_id, stage, sent_at)
            VALUES (?, ?, ?)
            """,
            (job_id, stage, stamp),
        )
        if cursor.rowcount:
            self.connection.execute(
                "UPDATE jobs SET alert_stage=?, alerted_at=? WHERE job_id=?",
                (stage, stamp, job_id),
            )
        self.connection.commit()
        return bool(cursor.rowcount)

    def weekly_alert_summary(self, since: datetime, until: datetime) -> dict[str, int]:
        """주간 알림 수와 실제 미게시·정책 취소 job 수를 집계한다."""
        start, end = _timestamp(since), _timestamp(until)
        alerts = self.connection.execute(
            "SELECT COUNT(*) FROM alert_events WHERE sent_at>=? AND sent_at<?",
            (start, end),
        ).fetchone()[0]
        actual_missing = self.connection.execute(
            """
            SELECT COUNT(DISTINCT jobs.job_id)
            FROM jobs
            JOIN alert_events
              ON alert_events.job_id=jobs.job_id
             AND alert_events.stage='initial'
            WHERE alert_events.sent_at>=? AND alert_events.sent_at<?
              AND (jobs.status IN ('missing', 'recovering', 'operator_required')
                   OR (jobs.status='cancelled' AND jobs.policy_cancelled=0))
            """,
            (start, end),
        ).fetchone()[0]
        policy_cancelled = self.connection.execute(
            """
            SELECT COUNT(*) FROM jobs
            WHERE resolved_at>=? AND resolved_at<?
              AND status='cancelled' AND policy_cancelled=1
            """,
            (start, end),
        ).fetchone()[0]
        return {
            "alerts": int(alerts),
            "actual_missing": int(actual_missing),
            "policy_cancelled": int(policy_cancelled),
        }

    def get(self, job_id: str) -> dict | None:
        row = self.connection.execute(
            "SELECT * FROM jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        return dict(row) if row else None

    def unresolved(self) -> list[dict]:
        rows = self.connection.execute(
            "SELECT * FROM jobs WHERE status NOT IN ('published', 'cancelled') ORDER BY due_at"
        ).fetchall()
        return [dict(row) for row in rows]
