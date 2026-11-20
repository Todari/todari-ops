import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import content_worker as worker


class WorkerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / str(uuid4())
        self.folder.mkdir()
        self.token = str(uuid4())
        lock = (self.folder / ".lock").open("w")
        self.addCleanup(lock.close)
        self.lock_fd = lock.fileno()

    def job(self, action):
        worker.write(self.folder / "job.json", {
            "id": self.folder.name, "state": worker.STATES[action],
            "execution": {"id": self.token, "action": action}})

    def test_invalid_job_is_a_recoverable_per_job_error(self):
        (self.folder / "job.json").write_text("[]")
        with self.assertRaises(ValueError):
            worker.process(self.folder, self.lock_fd)

    def test_completed_request_is_not_repeated(self):
        self.job("revise")
        with patch.object(worker, "run_pipeline", return_value=0) as run:
            worker.process(self.folder, self.lock_fd)
            worker.process(self.folder, self.lock_fd)
            run.assert_called_once_with("revise", self.folder, self.lock_fd)
        self.assertEqual(worker.read(self.folder / "execution-result.json"), {"id": self.token, "code": 0})

    def test_interrupted_request_with_and_without_publish_receipt(self):
        for action, receipt, expected in (("generate", False, 75), ("revise", False, 1),
                                         ("publish", False, 1), ("publish", True, 0)):
            with self.subTest(action=action, receipt=receipt):
                self.token = str(uuid4())
                self.job(action)
                worker.write(self.folder / "execution-started.json", {"id": self.token})
                if receipt:
                    worker.write(self.folder / "receipt.json", {"id": "published"})
                with patch.object(worker, "run_pipeline") as run:
                    worker.process(self.folder, self.lock_fd)
                    run.assert_not_called()
                self.assertEqual(worker.read(self.folder / "execution-result.json")["code"], expected)
