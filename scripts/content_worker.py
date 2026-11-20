"""Run durable requests from the Discord bot's job store, one at a time."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from uuid import UUID

STATES = {"generate": "generating", "publish": "publishing", "revise": "revising",
          "recover-revision": "recovering"}


def read(path):
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError(f"Invalid {path.name}")
        return value
    except FileNotFoundError:
        return {}


def write(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def run_pipeline(action, folder, lock_fd):
    cmd = [sys.executable, Path(__file__).with_name("content_pipeline.py"), action, folder]
    # The pipeline retains the lock if the supervising Python process is killed.
    child = subprocess.Popen(cmd, start_new_session=True, pass_fds=(lock_fd,))
    try:
        return child.wait(timeout=45 * 60)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        return 1


def process(folder, lock_fd):
    job = read(folder / "job.json")
    execution = job.get("execution")
    if not execution:
        return
    action, token = execution["action"], str(UUID(execution["id"]))
    if job.get("id") != folder.name or action not in STATES or job.get("state") != STATES[action]:
        raise ValueError("Invalid content request")
    result = folder / "execution-result.json"
    if read(result).get("id") == token:
        return
    mark = folder / "execution-started.json"
    if read(mark).get("id") == token:
        # This process owns the global lock. A previous worker stopped mid-request.
        if action == "publish" and read(folder / "receipt.json").get("id"):
            code = 0
        else:
            code = 75 if action == "generate" else 1
    else:
        write(mark, {"id": token})
        code = run_pipeline(action, folder, lock_fd)
    write(result, {"id": token, "code": code})


def main():
    root = Path(os.environ.get("WORK_DIR", "/data/work")) / "content"
    root.mkdir(exist_ok=True, parents=True)
    with (root / ".worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        while True:
            for path in sorted(root.glob("????????-????-????-????-????????????/job.json"),
                               key=lambda path: path.stat().st_mtime):
                try:
                    process(path.parent, lock.fileno())
                except (OSError, ValueError, TypeError, KeyError) as exc:
                    print(f"content job {path.parent.name}: {type(exc).__name__}", file=sys.stderr)
            time.sleep(3)


if __name__ == "__main__":
    main()
