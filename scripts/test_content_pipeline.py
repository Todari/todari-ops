import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import content_pipeline as p

GOOD = {'pass': True, 'scores': dict.fromkeys(('clarity', 'accuracy', 'visual', 'pacing'), 4), 'blockers': [], 'summary': '검사 통과'}


def story_plan(plan, body):
    plan = copy.deepcopy(plan)
    plan['story'] = {
        'characters': [{'id': 'narrator', 'design': 'Adult with short black hair and an ivory shirt'}],
        'locations': [{'id': 'home', 'design': 'Small living room with a blue sofa and round table'}],
        'facts': [body],
    }
    for i, panel in enumerate(plan['panels']):
        panel.update(characters=['narrator'], location='home', source_facts=[0],
                     beat=f'이야기 진행 {i}', continuity='Same afternoon and outfit; narrator holds the phone')
    return plan

class ContentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        (self.folder / 'final.mp4').write_bytes(b'video')
        self.manifest = {'kind': 'waenyamyeon', 'account': '123', 'caption': '본문', 'review': GOOD,
                         'media': [{'file': 'final.mp4', 'sha256': hashlib.sha256(b'video').hexdigest()}]}
        self.manifest['hash'] = p.digest(self.manifest)
        self.job = {'kind': 'waenyamyeon', 'state': 'publishing', 'approvedHash': self.manifest['hash']}
        self.env = patch.dict(os.environ, {'WAENYAMYEON_IG_USER_ID': '123', 'CONTENT_PUBLISH_ENABLED': 'true'})
        self.env.start(); self.addCleanup(self.env.stop)

    def test_approval_and_files_are_bound(self):
        p.verify(self.folder, self.job, self.manifest)
        for field, value in [('caption', '다른 본문'), ('account', '456'), ('kind', 'instatoon')]:
            changed = {**self.manifest, field: value}
            with self.assertRaises(ValueError): p.verify(self.folder, self.job, changed)
        (self.folder / 'final.mp4').write_bytes(b'changed')
        with self.assertRaises(ValueError): p.verify(self.folder, self.job, self.manifest)

    def test_unapproved_and_rejected_cannot_publish(self):
        for state in ('queued', 'review', 'rejected', 'published'):
            with self.assertRaises(ValueError): p.verify(self.folder, {**self.job, 'state': state}, self.manifest)
        with self.assertRaises(ValueError): p.verify(self.folder, {**self.job, 'approvedHash': None}, self.manifest)

    def test_disconnected_account_never_publishes(self):
        with patch.dict(os.environ, {'CONTENT_PUBLISH_ENABLED': 'false'}), patch.object(p, 'request') as network:
            with self.assertRaises(ValueError): p.publish(self.folder, self.job)
            network.assert_not_called()
        unbound = {**self.manifest, 'account': None}
        unbound['hash'] = p.digest(unbound)
        with self.assertRaises(ValueError):
            p.verify(self.folder, {**self.job, 'approvedHash': unbound['hash']}, unbound)

    def test_account_change_requires_new_approval(self):
        with patch.dict(os.environ, {'WAENYAMYEON_IG_USER_ID': '456'}):
            with self.assertRaises(ValueError): p.verify(self.folder, self.job, self.manifest)

    def test_uncertain_publish_is_never_repeated(self):
        p.dump(self.folder / 'manifest.json', self.manifest)
        p.dump(self.folder / 'publish-attempt.json', {'container': 'old'})
        with patch.object(p, 'request') as network:
            with self.assertRaises(ValueError): p.publish(self.folder, self.job)
            network.assert_not_called()

    def test_quality_fails_closed(self):
        self.assertTrue(p.review_ok(GOOD))
        for bad in ({}, {**GOOD, 'pass': 'true'}, {**GOOD, 'blockers': ['오탈자']},
                    {**GOOD, 'scores': {'clarity': 5}}, {**GOOD, 'scores': {**GOOD['scores'], 'visual': 3}}):
            self.assertFalse(p.review_ok(bad))

    def test_plan_rejects_unreadable_text_and_repeated_framing(self):
        plan = {'caption': '본문', 'panels': [{'text': '읽기 쉬운 대사', 'visual': 'Clear visual direction for this scene',
                'framing': ['wide', 'medium', 'close-up'][i % 3]} for i in range(5)]}
        p.validate_plan(plan, 'instatoon')
        bad = copy.deepcopy(plan); bad['panels'][0]['text'] = '가' * 23
        with self.assertRaises(ValueError): p.validate_plan(bad, 'instatoon')
        for panel in plan['panels']: panel['framing'] = 'wide'
        with self.assertRaises(ValueError): p.validate_plan(plan, 'instatoon')

    def test_publish_happy_path_and_timeout_have_durable_receipts(self):
        import types
        p.dump(self.folder / 'manifest.json', self.manifest)
        self.job['id'] = 'example'
        s3 = MagicMock(); s3.generate_presigned_url.return_value = 'https://example.com/video'
        config = {'WAENYAMYEON_IG_ACCESS_TOKEN': 'test', 'CONTENT_GRAPH_VERSION': 'v25.0', 'CONTENT_S3_BUCKET': 'bucket'}
        def response(url, body=None, headers=None):
            if url.endswith('/media_publish'):
                self.assertTrue((self.folder / 'publish-attempt.json').exists())
                return {'id': 'published'}
            return {'status_code': 'FINISHED'} if '?' in url else {'id': 'container'}
        with patch.dict(os.environ, config), patch.object(p, 'media_storage', return_value=s3), patch.object(p, 'request', side_effect=response) as network:
            p.publish(self.folder, self.job)
            self.assertEqual(json.loads((self.folder / 'receipt.json').read_text())['id'], 'published')
            before = network.call_count
            p.publish(self.folder, self.job)
            self.assertEqual(network.call_count, before)
        (self.folder / 'receipt.json').unlink(); (self.folder / 'publish-attempt.json').unlink()
        def timeout(url, body=None, headers=None):
            if url.endswith('/media_publish'): raise TimeoutError()
            return response(url, body, headers)
        with patch.dict(os.environ, config), patch.object(p, 'media_storage', return_value=s3), patch.object(p, 'request', side_effect=timeout):
            with self.assertRaises(TimeoutError): p.publish(self.folder, self.job)
            self.assertTrue((self.folder / 'publish-attempt.json').exists())
            with self.assertRaises(ValueError): p.publish(self.folder, self.job)

    def test_instagram_login_carousel_uses_matching_host_and_bearer_token(self):
        import types
        (self.folder / 'card.jpg').write_bytes(b'image')
        (self.folder / 'cover.jpg').write_bytes(b'cover')
        manifest = {**self.manifest, 'kind': 'instatoon',
                    'media': [{'file': 'cover.jpg', 'sha256': hashlib.sha256(b'cover').hexdigest()},
                              {'file': 'card.jpg', 'sha256': hashlib.sha256(b'image').hexdigest()}]}
        manifest['hash'] = p.digest(manifest)
        p.dump(self.folder / 'manifest.json', manifest)
        job = {**self.job, 'kind': 'instatoon', 'id': 'comic', 'approvedHash': manifest['hash']}
        config = {'INSTATOON_IG_API': 'instagram', 'INSTATOON_IG_USER_ID': '123',
                  'INSTATOON_IG_ACCESS_TOKEN': 'secret-test-token', 'CONTENT_GRAPH_VERSION': 'v25.0',
                  'CONTENT_S3_BUCKET': 'bucket'}
        s3 = MagicMock(); s3.generate_presigned_url.return_value = 'https://example.com/card.jpg'
        created = []
        def response(url, body=None, headers=None):
            self.assertTrue(url.startswith('https://graph.instagram.com/v25.0/'))
            self.assertNotIn('secret-test-token', url)
            self.assertEqual(headers, {'Authorization': 'Bearer secret-test-token'})
            if url.endswith('/media_publish'):
                self.assertTrue((self.folder / 'publish-attempt.json').exists())
                return {'id': 'published-comic'}
            if '?' in url:return {'status_code': 'FINISHED'}
            created.append(body)
            return {'id': f'container-{len(created)}'}
        with patch.dict(os.environ, config), patch.object(p, 'media_storage', return_value=s3), patch.object(p, 'request', side_effect=response) as network:
            p.publish(self.folder, job)
            self.assertEqual(json.loads((self.folder / 'receipt.json').read_text())['id'], 'published-comic')
            bodies = [call.args[1] for call in network.call_args_list if call.args[1]]
            self.assertTrue(any(b.get('is_carousel_item') for b in bodies))
            self.assertTrue(any(b.get('media_type') == 'CAROUSEL' and b['caption'] == '본문'
                                and b['children'] == ['container-1', 'container-2'] for b in bodies))
            self.assertEqual(p.instagram_graph_base('waenyamyeon'), 'https://graph.facebook.com/v25.0/')

    def test_invalid_instagram_api_mode_stops_before_upload_or_network(self):
        import types
        p.dump(self.folder / 'manifest.json', self.manifest)
        s3 = MagicMock()
        with patch.dict(os.environ, {'WAENYAMYEON_IG_API': 'https://untrusted.example', 'CONTENT_GRAPH_VERSION': 'v25.0'}), \
                patch.object(p, 'media_storage', s3), patch.object(p, 'request') as network:
            with self.assertRaisesRegex(ValueError, 'API mode'):p.publish(self.folder, self.job)
            s3.assert_not_called(); network.assert_not_called()

    def test_generation_retries_editorial_and_never_publishes(self):
        root = self.folder / 'repo'
        (root / 'bible/sheets').mkdir(parents=True)
        (root / 'bible/prompt-library.json').write_text(json.dumps({'style_prefix': 'style', 'negative': 'no text'}))
        (root / 'bible/sheets/core-cast-turnaround-v1.png').write_bytes(b'reference')
        plan = {'caption': '본문', 'panels': [{'text': '대사', 'visual': 'A specific visual direction for the scene', 'framing': ['wide', 'medium', 'close-up'][i % 3]} for i in range(5)]}
        plan = story_plan(plan, '실제 제보')
        counts = {'plan': 0}
        def model(prompt, files=(), search=False, image=False, aspect='4:5'):
            if image: return b'candidate'
            if 'JSON {"caption"' in prompt:
                counts['plan'] += 1
                return {**plan, 'caption': ''} if counts['plan'] == 1 else plan
            return GOOD
        def render(folder, root, job, plan):
            files = ['card-0.jpg', 'card-1.jpg']
            for name in files: (folder / name).write_bytes(b'jpeg')
            return files, files
        config = {'INSTATOON_ROOT': str(root), 'INSTATOON_IG_USER_ID': 'insta'}
        job = {'kind': 'instatoon', 'topic': '주제', 'body': '실제 제보'}
        with patch.dict(os.environ, config), patch.object(p, 'preflight'), patch.object(p, 'compose_instatoon_preview', side_effect=lambda folder, root, plan, i, attempt: folder / f'composed-{i}-attempt-{attempt}.png'), patch.object(p, 'review_story_fidelity', return_value={'pass': True, 'unsupported_claims': [], 'missing_facts': [], 'summary': 'ok'}), patch.object(p, 'validate_instatoon_text', return_value=[]), patch.object(p, 'gemini', side_effect=model), patch.object(p, 'render', side_effect=render), patch.object(p, 'publish') as publisher:
            p.generate(self.folder, job)
            manifest = json.loads((self.folder / 'manifest.json').read_text())
            self.assertEqual(counts['plan'], 2)
            self.assertEqual(manifest['hash'], p.digest(manifest))
            self.assertTrue((self.folder / 'review.html').exists())
            publisher.assert_not_called()

    def test_final_review_failure_cannot_create_publish_manifest(self):
        root = self.folder / 'repo'; (root / 'bible/sheets').mkdir(parents=True)
        (root / 'bible/prompt-library.json').write_text(json.dumps({'style_prefix': 'style', 'negative': 'no text'}))
        (root / 'bible/sheets/core-cast-turnaround-v1.png').write_bytes(b'reference')
        plan = {'caption': '본문', 'panels': [{'text': '대사', 'visual': 'A specific visual direction for the scene', 'framing': ['wide', 'medium', 'close-up'][i % 3]} for i in range(5)]}
        plan = story_plan(plan, '제보')
        def model(prompt, files=(), search=False, image=False, aspect='4:5'):
            if image: return b'image'
            if 'JSON {"caption"' in prompt: return plan
            return {**GOOD, 'pass': False} if '최종 완성본 검수.' in prompt else GOOD
        with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), patch.object(p, 'preflight'), patch.object(p, 'compose_instatoon_preview', side_effect=lambda folder, root, plan, i, attempt: folder / f'composed-{i}-attempt-{attempt}.png'), patch.object(p, 'review_story_fidelity', return_value={'pass': True, 'unsupported_claims': [], 'missing_facts': [], 'summary': 'ok'}), patch.object(p, 'validate_instatoon_text', return_value=[]), patch.object(p, 'gemini', side_effect=model), patch.object(p, 'render', return_value=([], [])):
            p.generate(self.folder, {'kind': 'instatoon', 'topic': '주제', 'body': '제보'})
            self.assertFalse((self.folder / 'manifest.json').exists())
            draft = json.loads((self.folder / 'draft.json').read_text())
            self.assertFalse(draft['final_review']['pass'])

if __name__ == '__main__': unittest.main()
