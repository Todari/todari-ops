#!/usr/bin/env python3
"""Durable expected-vs-actual job ledger for Instagram automations."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


STATUSES = {"expected", "missing", "recovering", "published", "cancelled", "operator_required"}


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
                resolved_at TEXT
            )
            """
        )
        self.connection.commit()

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
        elif current and current["status"] in {"recovering", "operator_required"}:
            status = current["status"]
        elif now >= due_at:
            status = "missing"
        else:
            status = "expected"
        stamp = now.isoformat()
        if current:
            self.connection.execute(
                """
                UPDATE jobs
                SET account=?, content_type=?, source_key=?, expected_at=?, due_at=?,
                    status=?, permalink=COALESCE(?, permalink), updated_at=?,
                    resolved_at=CASE WHEN ?='published' THEN ? ELSE resolved_at END
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
            WHERE job_id=?
            """,
            (
                status,
                attempts,
                next_at.isoformat() if next_at else None,
                detail[:1000],
                now.isoformat(),
                job_id,
            ),
        )
        self.connection.commit()
        return self.get(job_id) or {}

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
