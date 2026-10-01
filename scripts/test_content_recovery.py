import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
import content_pipeline as p


class RecoveryTests(unittest.TestCase):
    def test_silent_draft_after_restart_still_needs_audio(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'episode.json'
            checker = Mock()
            checker.check_episode.return_value = []
            path.write_text(json.dumps({'audio': None}))
            self.assertFalse(p.audio_ready(path, Path(tmp), checker))
            checker.check_episode.assert_not_called()
            path.write_text(json.dumps({'audio': 'voice.wav'}))
            self.assertTrue(p.audio_ready(path, Path(tmp), checker))
            checker.check_episode.return_value = ['stale audio proof']
            self.assertFalse(p.audio_ready(path, Path(tmp), checker))

    def test_transient_generation_retries_but_publication_does_not(self):
        error = urllib.error.HTTPError('https://example.test', 429, 'quota', {}, io.BytesIO(b''))
        self.addCleanup(error.close)
        with patch.object(p.urllib.request, 'urlopen', side_effect=error) as network, patch.object(p.time, 'sleep'):
            with self.assertRaises(p.TransientGenerationError):
                p.request('https://example.test', {}, retry_generation=True)
            self.assertEqual(network.call_count, 3)
            network.reset_mock()
            with self.assertRaises(urllib.error.HTTPError): p.request('https://example.test', {})
            self.assertEqual(network.call_count, 1)

    def test_transport_backoff_keeps_safe_status_and_honors_retry_after(self):
        error = urllib.error.HTTPError('https://example.test/private', 503, 'private detail', {'Retry-After':'45'}, io.BytesIO(b''))
        self.addCleanup(error.close)
        with patch.object(p.urllib.request, 'urlopen', side_effect=error) as network, patch.object(p.time, 'sleep') as sleep:
            with self.assertRaises(p.TransientGenerationError) as caught:
                p.request('https://example.test', {}, retry_generation=True)
            self.assertEqual(caught.exception.code, 'http-503')
            self.assertEqual(str(caught.exception), 'http-503')
            self.assertEqual(network.call_count, 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [45,45])

    def test_permanent_generation_errors_are_not_retried(self):
        error = urllib.error.HTTPError('https://example.test', 403, 'denied', {}, io.BytesIO(b''))
        self.addCleanup(error.close)
        with patch.object(p.urllib.request, 'urlopen', side_effect=error) as network:
            with self.assertRaises(urllib.error.HTTPError): p.request('https://example.test', {}, retry_generation=True)
            self.assertEqual(network.call_count, 1)

    def test_checkpoint_reuses_exact_inputs_only(self):
        result = {'candidates': [{'content': {'parts': [{'text': '{"answer":42}'}]}}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5}}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CONTENT_TEXT_MODEL': 'test', 'GEMINI_API_KEY': 'secret-not-stored'}):
            root = Path(tmp); image = root / 'ref.png'; image.write_bytes(b'first')
            token = p.MODEL_CACHE.set(root / 'cache')
            try:
                with patch.object(p, 'request', return_value=result) as request:
                    self.assertEqual(p.gemini('explain', [image]), {'answer': 42})
                    self.assertEqual(p.gemini('explain', [image]), {'answer': 42})
                    self.assertEqual(request.call_count, 1)
                    image.write_bytes(b'second')
                    p.gemini('explain', [image])
                    self.assertEqual(request.call_count, 2)
                    p.gemini('different prompt', [image])
                    self.assertEqual(request.call_count, 3)
                usage = list((root / 'api-usage').glob('*.json'))
                self.assertEqual(len(usage), 3)  # Cache hit did not create a paid call.
                for file in usage:
                    saved = json.loads(file.read_text())
                    self.assertEqual(saved['usage']['promptTokenCount'], 10)
                    self.assertNotIn('secret-not-stored', file.read_text())
                for file in (root / 'cache').glob('*.json'):
                    self.assertNotIn('secret-not-stored', file.read_text())
            finally:
                p.MODEL_CACHE.reset(token)

    def test_child_transient_exit_survives_without_leaking_error_output(self):
        import subprocess
        with patch.object(p.subprocess, 'run', side_effect=subprocess.CalledProcessError(75, ['python', 'build_audio.py'])):
            with self.assertRaises(p.TransientGenerationError): p.run(['python', 'build_audio.py'])
        with patch.object(p.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['python', 'check_episode.py'])):
            with self.assertRaises(p.ProcessFailure) as error: p.run(['python', 'check_episode.py'])
            self.assertEqual(error.exception.step, 'check_episode.py')
            self.assertEqual(error.exception.returncode, 1)

    def test_regeneration_does_not_mutate_approved_package(self):
        with patch.object(p, '_generate') as generate:
            for state in ('review', 'approved', 'publishing', 'published', 'rejected', 'uncertain'):
                with self.assertRaises(ValueError): p.generate(Path('/unused'), {'state': state})
            generate.assert_not_called()


if __name__ == '__main__': unittest.main()
