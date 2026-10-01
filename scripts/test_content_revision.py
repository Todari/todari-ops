import json
import tempfile
import unittest
import uuid
import os
from pathlib import Path
import content_revision as r
import content_pipeline as p
from unittest.mock import patch


class RevisionTransactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.job = {'revisionId': str(uuid.uuid4())}
        self.plan = {'panels': [{'text': 'a'}, {'text': 'b'}],
                     'presentation': {'panels': [{'text': 'a'}, {'text': 'b'}]}}
        self.write('production-plan.json', self.plan)
        self.write('job.json', self.job)
        self.write('manifest.json', {'hash': 'original'})
        self.write('revision.json', {'panels': [1], 'instruction': '<script>bad</script>', 'operation': 'revise'})
        for name in ['art-0.png', 'art-1.png', 'card-0.jpg', 'card-1.jpg', 'cover.jpg']:
            (self.folder / name).write_bytes(b'old')

    def write(self, name, value):
        (self.folder / name).write_text(json.dumps(value))

    def test_failure_rolls_back_art_manifest_and_removes_partial_outputs(self):
        def execute(folder, job):
            (folder / 'art-1.png').write_bytes(b'new')
            self.write('manifest.json', {'hash': 'bad'})
            self.write('new-output.json', {})
            raise RuntimeError('interrupted')
        with self.assertRaises(RuntimeError):
            r.transact(self.folder, self.job, execute)
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')
        self.assertEqual(json.loads((self.folder / 'manifest.json').read_text())['hash'], 'original')
        self.assertFalse((self.folder / 'new-output.json').exists())

    def test_restart_recovery_is_idempotent_and_preserves_job_receipts(self):
        r.snapshot(self.folder, self.job['revisionId'])
        (self.folder / 'art-1.png').write_bytes(b'new')
        self.write('receipt.json', {'id': 'do-not-touch'})
        self.write('job.json', {'state': 'revising'})
        r.recover(self.folder, self.job)
        r.recover(self.folder, self.job)
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')
        self.assertEqual(json.loads((self.folder / 'job.json').read_text())['state'], 'revising')
        self.assertTrue((self.folder / 'receipt.json').exists())

    def test_uncommitted_snapshot_is_safe_noop(self):
        r.recover(self.folder, self.job)
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')

    def test_legacy_recovery_without_revision_id_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'manual recovery'):
            r.recover(self.folder, {'state': 'revising'})

    def test_restore_rejects_symlink_destinations_before_copying(self):
        r.snapshot(self.folder, self.job['revisionId'])
        outside = self.folder / 'outside.png'
        outside.write_bytes(b'untouched')
        for name in ['art-1.png', 'accepted-art-1.json']:
            with self.subTest(name=name):
                destination = self.folder / name
                destination.unlink(missing_ok=True)
                destination.symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'destination symlink'):
                    r.restore_panels(self.folder, self.job['revisionId'], self.plan, [1])
                self.assertEqual(outside.read_bytes(), b'untouched')
                destination.unlink()
                destination.write_bytes(b'old')

    def test_snapshot_rejects_symlink_sources_and_metadata(self):
        target = r.snapshot(self.folder, self.job['revisionId'])
        for name in ['art-1.png', '_snapshot.json']:
            with self.subTest(name=name):
                source = target / name
                content = source.read_bytes()
                source.unlink()
                source.symlink_to(self.folder / name)
                with self.assertRaises(ValueError):
                    r.checked_snapshot(self.folder, self.job['revisionId'])
                source.unlink()
                source.write_bytes(content)

    def test_identifiers_and_snapshot_traversal_are_rejected_before_restore(self):
        for value in ['../escape', None, '/tmp/outside']:
            with self.assertRaises(ValueError):
                r.snapshot(self.folder, value)
        target = r.snapshot(self.folder, self.job['revisionId'])
        (target / '_snapshot.json').write_text(json.dumps({'files': {'../escape': 'bad'}}))
        with self.assertRaises(ValueError):
            r.recover(self.folder, self.job)

    def test_corrupt_snapshot_does_not_mutate_live_art(self):
        target = r.snapshot(self.folder, self.job['revisionId'])
        (target / 'art-1.png').write_bytes(b'corrupt')
        (self.folder / 'art-1.png').write_bytes(b'current')
        with self.assertRaises(ValueError):
            r.recover(self.folder, self.job)
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'current')

    def test_restore_only_selected_source_art_and_plan(self):
        r.snapshot(self.folder, self.job['revisionId'])
        self.plan['panels'][0]['text'] = 'keep'
        self.plan['panels'][1]['text'] = 'change'
        (self.folder / 'art-0.png').write_bytes(b'keep')
        (self.folder / 'art-1.png').write_bytes(b'change')
        r.restore_panels(self.folder, self.job['revisionId'], self.plan, [1])
        self.assertEqual(self.plan['panels'], [{'text': 'keep'}, {'text': 'b'}])
        self.assertEqual((self.folder / 'art-0.png').read_bytes(), b'keep')
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')

    def test_restore_rejects_failed_target_and_global_draft_before_mutation(self):
        for failures in [[{'index': 1}], [], [{'index': None}], [{'index': -1}]]:
            with self.subTest(failures=failures):
                self.write('draft.json', {'failed_panels': failures})
                identifier = str(uuid.uuid4())
                r.snapshot(self.folder, identifier)
                (self.folder / 'art-1.png').write_bytes(b'current')
                with self.assertRaisesRegex(ValueError, 'unapproved panel'):
                    r.restore_panels(self.folder, identifier, self.plan, [1])
                self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'current')

    def test_restore_allows_a_panel_when_only_other_backup_panel_failed(self):
        self.write('draft.json', {'failed_panels': [{'index': 0}]})
        r.snapshot(self.folder, self.job['revisionId'])
        (self.folder / 'art-1.png').write_bytes(b'current')
        r.restore_panels(self.folder, self.job['revisionId'], self.plan, [1])
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')

    def test_pipeline_restore_does_not_generate_and_disables_final_repairs(self):
        backup = str(uuid.uuid4())
        r.snapshot(self.folder, backup)
        (self.folder / 'art-1.png').write_bytes(b'changed')
        root = self.folder / 'repo'
        (root / 'bible').mkdir(parents=True)
        (root / 'bible/prompt-library.json').write_text('{}')
        self.write('style-config.json', {'style': 'style', 'references': []})
        self.write('brief.json', {'brief': 'story'})
        self.write('revision.json', {'operation': 'restore', 'backupId': backup,
                                     'panels': [1], 'instruction': '원복'})
        self.write('draft.json', {'failed_panels': [{'index': 0}, {'index': 1}]})
        with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), patch.object(p, 'preflight'), \
                patch.object(p, 'generate_instatoon_card') as generate, \
                patch.object(p, 'finish_instatoon') as finish:
            p._revise(self.folder, {'kind': 'instatoon', 'state': 'revising'})
        generate.assert_not_called()
        self.assertEqual(finish.call_args.kwargs['repair_scope'], set())
        self.assertEqual(finish.call_args.args[-1], [{'index': 0}])
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')

    def test_unselected_changes_abort_and_rollback(self):
        def execute(folder, job):
            (folder / 'art-0.png').write_bytes(b'accidental')
        with self.assertRaisesRegex(ValueError, 'unselected'):
            r.transact(self.folder, self.job, execute)
        self.assertEqual((self.folder / 'art-0.png').read_bytes(), b'old')

    def test_success_writes_escaped_embedded_comparison_and_result(self):
        def execute(folder, job):
            (folder / 'art-1.png').write_bytes(b'new')
            (folder / 'card-1.jpg').write_bytes(b'new')
        r.transact(self.folder, self.job, execute)
        comparison = (self.folder / 'comparison.html').read_text()
        self.assertIn('2컷', comparison)
        self.assertIn('&lt;script&gt;', comparison)
        self.assertNotIn('<script>', comparison)
        self.assertEqual(comparison.count('data:image/jpeg;base64,'), 2)
        self.assertEqual(json.loads((self.folder / 'revision-result.json').read_text())['backupId'], self.job['revisionId'])
        with self.assertRaises(ValueError):
            r.snapshot(self.folder, self.job['revisionId'])

    def test_pipeline_wrapper_rolls_back_worker_exception(self):
        job = {**self.job, 'state': 'revising'}
        def execute(folder, job):
            (folder / 'art-1.png').write_bytes(b'new')
            raise ValueError('worker failed')
        with patch.object(p, '_revise', side_effect=execute), self.assertRaisesRegex(ValueError, 'worker failed'):
            p.revise(self.folder, job)
        self.assertEqual((self.folder / 'art-1.png').read_bytes(), b'old')
        self.assertIsNone(p.MODEL_CACHE.get())

    def test_final_review_never_repairs_unselected_panels_or_global_typography(self):
        for kind, target, scope in [('art', 1, {1}), ('typography', 2, {1}), ('art', 2, set())]:
            with self.subTest(kind=kind, target=target, scope=scope):
                review = {'pass': False, 'repair_kind': kind, 'repair_panels': [target], 'scores': {}, 'blockers': ['bad']}
                with patch.object(p, 'render', return_value=(['card-0.jpg'], ['card-0.jpg'])), \
                        patch.object(p, 'final_review_inputs', return_value=([], '')), \
                        patch.object(p, 'review_media', return_value=review), \
                        patch.object(p, 'generate_instatoon_card') as generate, \
                        patch.object(p, 'write_draft') as draft:
                    p.finish_instatoon(self.folder, self.folder, {'kind': 'instatoon'},
                                       {'panels': [{}, {}]}, '', '', [], {}, [], repair_scope=scope)
                generate.assert_not_called()
                draft.assert_called_once()


if __name__ == '__main__':
    unittest.main()
