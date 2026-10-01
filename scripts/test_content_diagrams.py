import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import content_pipeline as p

GOOD = {'pass': True, 'scores': dict.fromkeys(('clarity', 'accuracy', 'visual', 'pacing'), 4),
        'blockers': [], 'summary': 'The provided content meets the review criteria.', 'fixes': ''}
VIEWS = ('overview', 'mechanism', 'comparison', 'detail', 'outcome')


class DiagramContract:
    RULES = 'Use exactly five verified code diagram views and supported narration.'
    STYLE = 'Fixed cream, teal and orange code diagram.'
    PLAN_SCHEMA = {'type': 'object', 'required': ['caption', 'diagram_template', 'claims', 'panels']}

    def __init__(self):
        self.CATALOG = {'condensation': {'version': 1, 'labels': ['water vapor', 'liquid water'],
                                         'conditions': 'Schematic particle model; not drawn to scale.'}}

    def hydrate_plan(self, raw):
        if raw.get('diagram_template') not in self.CATALOG:
            raise ValueError('Unsupported template')
        plan = copy.deepcopy(raw)
        plan.update(visual_format='science-diagram-v2', diagram_catalog_sha256=p.editorial_fingerprint(self.CATALOG))
        for panel, view in zip(plan['panels'], VIEWS):
            panel.update(diagram_view=view, framing='wide',
                         visual='Code particles and arrows explain supported phase changes in the ' + view + ' view.')
        return plan

    def validate_plan(self, plan):
        if (plan.get('diagram_template') not in self.CATALOG or plan.get('visual_format') != 'science-diagram-v2'
                or plan.get('diagram_catalog_sha256') != p.editorial_fingerprint(self.CATALOG)
                or [panel.get('diagram_view') for panel in plan.get('panels', [])] != list(VIEWS)):
            raise ValueError('Diagram template/view/catalog mismatch')

    def review_context(self, plan):
        self.validate_plan(plan)
        return {'template': plan['diagram_template'], 'catalog': self.CATALOG, 'view_order': VIEWS}

    def direction_for(self, plan):
        self.validate_plan(plan)
        return {'scenes': [{'overlays': [{'type': 'science-diagram', 'template': plan['diagram_template'], 'view': view}]} for view in VIEWS]}

    def assemble_episode(self, eid, title, plan):
        direction = self.direction_for(plan)
        return {'id': eid, 'title': title, 'fps': 30, 'width': 1080, 'height': 1920, 'audio': None, 'sfx': [],
                'scenes': [{'id': f's{i}', 'start': i * 6, 'end': (i + 1) * 6, 'image': None,
                            **direction['scenes'][i]} for i in range(5)],
                'captions': [{'start': i * 6, 'end': (i + 1) * 6, 'text': panel['text']} for i, panel in enumerate(plan['panels'])]}


class DiagramPipelineTests(unittest.TestCase):
    def setUp(self):
        self.diagrams = DiagramContract()
        self.raw = {'caption': '왜냐맨 과학 설명', 'diagram_template': 'condensation',
                    'claims': [{'id': 'c1', 'statement': '공기의 수증기가 물방울로 변해요.', 'evidence_ids': [0]}],
                    'panels': [{'text': '차가운 컵 바깥에 물방울이 맺혀요. 이 물은 어디서 생긴 걸까요? 공기의 변화를 알아봐요.',
                                'claim_ids': ['c1']} for _ in VIEWS]}
        self.plan = self.diagrams.hydrate_plan(self.raw)
        self.evidence = {'supported_passages': [{'id': 0, 'text': 'Water vapor condenses into liquid water.',
                                               'sources': [{'url': 'https://science.example.gov/article'}]}]}
        self.job = {'id': 'diagram-job', 'kind': 'waenyamyeon', 'topic': 'Cup condensation', 'body': 'Verified source scope',
                    'generationAttempts': 1}
        self.audit = {'pass': True, 'claims': [{'id': 'c1', 'supported': True, 'reason': 'The supplied source supports the phase change.'}],
                      'unsupported_statements': [], 'fixes': ''}

    def test_diagram_editorial_uses_hydrated_semantics_and_new_contract_without_art_guard(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'gemini', side_effect=[self.raw, GOOD]) as model, \
             patch.object(p, 'audit_science_plan', return_value=self.audit) as audit, \
             patch.object(p, 'validate_science_art', side_effect=AssertionError('Legacy art guard used')):
            plan = p.science_editorial(Path(tmp), self.job, self.evidence, 'legacy no arrows', 'legacy style', 'brief', diagrams=self.diagrams)
            self.assertEqual(plan, self.plan)
            self.assertEqual(model.call_args_list[0].kwargs['json_schema'], self.diagrams.PLAN_SCHEMA)
            self.assertNotIn('legacy no arrows', model.call_args_list[0].args[0])
            self.assertIn('Schematic particle model', model.call_args_list[0].args[0])
            self.assertEqual(audit.call_args.args[0], self.plan)
            self.assertEqual(audit.call_args.kwargs['diagram_context'], self.diagrams.review_context(self.plan))
            checkpoint = json.loads((Path(tmp) / 'editorial-checkpoint.json').read_text())
            self.assertEqual(checkpoint['raw_plan'], self.raw)

    def test_changed_catalog_invalidates_editorial_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', side_effect=[self.raw, GOOD]), patch.object(p, 'audit_science_plan', return_value=self.audit):
                p.science_editorial(folder, self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
            with patch.object(p, 'gemini') as model:
                p.science_editorial(folder, self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
                model.assert_not_called()
            self.diagrams.CATALOG['condensation']['version'] = 2
            with patch.object(p, 'gemini', side_effect=[self.raw, GOOD]) as model, patch.object(p, 'audit_science_plan', return_value=self.audit):
                p.science_editorial(folder, self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
                self.assertEqual(model.call_count, 2)

    def test_unsupported_and_template_mismatch_fail_without_fallback_or_approval(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'gemini', return_value={**self.raw, 'diagram_template': 'unsupported'}) as model, \
             patch.object(p, 'audit_science_plan') as audit:
            with self.assertRaisesRegex(ValueError, 'Unsupported science diagram'):
                p.science_editorial(Path(tmp), self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
            self.assertEqual(model.call_count, 1); audit.assert_not_called()
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'gemini', return_value=self.raw) as model, \
             patch.object(self.diagrams, 'validate_plan', side_effect=ValueError('Template mismatch')), patch.object(p, 'audit_science_plan') as audit:
            with self.assertRaisesRegex(ValueError, 'three new candidates'):
                p.science_editorial(Path(tmp), self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
            self.assertEqual(model.call_count, 3); audit.assert_not_called()

    def test_forged_positive_editorial_flag_cannot_override_failed_science_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', side_effect=[self.raw, GOOD]), patch.object(p, 'audit_science_plan', return_value=self.audit):
                p.science_editorial(folder, self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
            checkpoint = json.loads((folder / 'editorial-checkpoint.json').read_text())
            checkpoint['audit']['claims'][0]['supported'] = False
            p.save_editorial_checkpoint(folder, checkpoint)
            with patch.object(p, 'gemini') as model:
                with self.assertRaisesRegex(ValueError, 'Stored editorial approval is incomplete'):
                    p.science_editorial(folder, self.job, self.evidence, '', '', 'brief', diagrams=self.diagrams)
                model.assert_not_called()

    def run_diagram_job(self, base, fail_visual=False, fail_final=False, same_states=False, bad_proof=None):
        root, folder = base / 'repo', base / 'job'
        (root / 'episodes').mkdir(parents=True)
        folder.mkdir()
        source = root / 'diagram.tsx'; source.write_text('verified code renderer')
        calls, reviews = [], []
        def run(args, cwd=None):
            args = [str(arg) for arg in args]; calls.append(args)
            if args[0] == 'node':
                path = Path(args[-2]); frames = []
                for i in range(5):
                    for phase, name in (('start', f'diagram-{i}-start.png'), ('late', f'art-{i}.png')):
                        data = (f'static-{i}' if same_states else name).encode()
                        (folder / name).write_bytes(data)
                        frames.append({'file': name, 'scene': i, 'phase': phase, 'frame': i * 180 + (27 if phase == 'start' else 135),
                                       'sha256': hashlib.sha256(data).hexdigest()})
                if bad_proof == 'frame':
                    frames[0]['sha256'] = 'changed frame'
                sources = {'diagram.tsx': 'changed source' if bad_proof == 'source' else hashlib.sha256(source.read_bytes()).hexdigest()}
                renderer_sha = hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                motion = folder / 'diagram-motion-preview.mp4'; motion.write_bytes(b'verified motion video')
                motion_proof = {'file': motion.name, 'frame_range': [180, 539], 'sha256': hashlib.sha256(motion.read_bytes()).hexdigest()}
                if bad_proof == 'motion': motion_proof['sha256'] = 'changed motion'
                if bad_proof == 'motion-range': motion_proof['frame_range'] = [0, 30]
                p.dump(folder / 'diagram-preview-proof.json', {'version': 2,
                       'input_sha256': 'changed input' if bad_proof == 'input' else hashlib.sha256(path.read_bytes()).hexdigest(),
                       'renderer_sha256': renderer_sha, 'sources': sources, 'frames': frames, 'motion_preview': motion_proof})
            elif len(args) > 1 and args[1].endswith('build_audio.py'):
                path = root / 'episodes/auto-diagram-job.json'; ep = json.loads(path.read_text())
                ep['audio'] = 'auto-diagram-job/voice.wav'; p.dump(path, ep)
            elif len(args) > 1 and args[1].endswith('check_episode.py'):
                (folder / 'final.mp4').write_bytes(b'final diagram video')
            elif args[0] == 'ffmpeg':
                Path(args[-1]).write_bytes(('rendered ' + args[-1]).encode())
            else:
                raise AssertionError('Unexpected subprocess: ' + ' '.join(args))
        def model(prompt, files=(), **kwargs):
            self.assertFalse(kwargs.get('image', False), 'Paid model image generation is forbidden')
            reviews.append((prompt, [file.name for file in files]))
            fail = fail_final if '과학 도식 최종 검수' in prompt else fail_visual
            return {**GOOD, 'pass': False, 'scores': {**GOOD['scores'], 'visual': 3}, 'blockers': ['Actual defect']} if fail else GOOD
        checker = SimpleNamespace(verify_render=lambda *args: ['Render required'], check_episode=lambda *args: [])
        def module(path):
            if Path(path).name != 'check_episode.py':
                raise AssertionError('Unexpected module, including legacy director: ' + str(path))
            return checker
        probe = {'format': {'duration': '30'}, 'streams': [{'codec_type': 'audio'}, {'codec_type': 'video', 'width': 1080, 'height': 1920}]}
        with patch.dict(os.environ, {'WAENYAMYEON_ROOT': str(root), 'CONTENT_VIDEO_MODEL': 'must-not-call'}), \
             patch.dict('sys.modules', {'PIL': SimpleNamespace(Image=Mock())}), patch.object(p, 'preflight'), \
             patch.object(p, 'load_science_diagrams', return_value=self.diagrams), patch.object(p, 'collect_science_evidence', return_value=self.evidence), \
             patch.object(p, 'science_editorial', return_value=self.plan), patch.object(p, 'module', side_effect=module), \
             patch.object(p, 'run', side_effect=run), patch.object(p, 'gemini', side_effect=model), \
             patch.object(p.subprocess, 'check_output', return_value=json.dumps(probe).encode()):
            try:
                p._generate(folder, self.job)
            except ValueError:
                if not (fail_visual or fail_final or same_states or bad_proof):
                    raise
        return folder, calls, reviews

    def test_new_job_defaults_to_code_diagrams_and_reaches_tts_render_without_image_or_director_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, calls, reviews = self.run_diagram_job(Path(tmp))
            self.assertEqual(sum(args[0] == 'node' for args in calls), 1)
            self.assertTrue(any(len(args) > 1 and args[1].endswith('build_audio.py') for args in calls))
            self.assertTrue(any(len(args) > 1 and args[1].endswith('check_episode.py') for args in calls))
            self.assertEqual(len(reviews), 2)
            self.assertEqual(len(reviews[0][1]), 11)
            self.assertEqual(reviews[0][1][0], 'diagram-motion-preview.mp4')
            self.assertIn(json.dumps(self.plan, ensure_ascii=False), reviews[0][0])
            self.assertIn(json.dumps(self.plan, ensure_ascii=False), reviews[1][0])
            self.assertEqual(json.loads((folder / 'final-review-inputs.json').read_text())['approved_plan'], self.plan)
            self.assertEqual(len(reviews[1][1]), 31)
            contract = json.loads((folder / 'final-review-inputs.json').read_text())
            self.assertEqual(len(contract['detail_crops']), 4)
            self.assertEqual(len(contract['text_crops']), 16)
            self.assertEqual(contract['expected_brand_handle'], '@whynyaman')
            for text_crop in contract['text_crops']:
                self.assertIn(text_crop['file'], reviews[1][1])
                self.assertEqual(text_crop['source_sha256'], hashlib.sha256((folder / text_crop['source']).read_bytes()).hexdigest())
            for index in range(5):
                self.assertIn(f'review-frame-{index}-start.jpg', reviews[1][1])
            for crop in contract['detail_crops']:
                self.assertIn(crop['file'], reviews[1][1])
                self.assertEqual(crop['crop_xywh'], [74, 400, 930, 960])
                self.assertEqual(crop['source_sha256'], hashlib.sha256((folder / crop['source']).read_bytes()).hexdigest())
                self.assertTrue(any(args[0] == 'ffmpeg' and str(folder / crop['source']) in args
                                    and 'crop=930:960:74:400' in args and args[-1] == str(folder / crop['file']) for args in calls))
            self.assertIn('review-frame-1-start.jpg', reviews[1][1])
            self.assertIn('review-frame-2-start.jpg', reviews[1][1])
            self.assertFalse(any(name.startswith('art-') for name in reviews[1][1]))
            self.assertTrue((folder / 'manifest.json').is_file())
            self.assertLessEqual(len(json.loads((folder / 'manifest.json').read_text())['previews']) + 1, 10)
            for index in range(5):
                self.assertIn(f'review-caption-{index}-tail.jpg', reviews[1][1])
            ep = json.loads((Path(tmp) / 'repo/episodes/auto-diagram-job.json').read_text())
            self.assertTrue(all(scene['image'] is None for scene in ep['scenes']))

    def test_static_or_failed_visuals_and_failed_final_review_cannot_create_manifest(self):
        for options in ({'same_states': True}, {'fail_visual': True}, {'fail_final': True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as tmp:
                folder, calls, reviews = self.run_diagram_job(Path(tmp), **options)
                self.assertFalse((folder / 'manifest.json').exists())
                if not options.get('fail_final'):
                    self.assertFalse(any(len(args) > 1 and args[1].endswith('build_audio.py') for args in calls))

    def test_stale_input_source_and_frame_proofs_fail_before_paid_review(self):
        for failure in ('input', 'source', 'frame', 'motion', 'motion-range'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                folder, calls, reviews = self.run_diagram_job(Path(tmp), bad_proof=failure)
                self.assertEqual(reviews, [])
                self.assertFalse((folder / 'manifest.json').exists())

    def test_missing_code_renderer_fails_before_research_instead_of_falling_back(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'WAENYAMYEON_ROOT': tmp}), \
             patch.object(p, 'preflight'), patch.object(p, 'gemini') as model:
            with self.assertRaisesRegex(ValueError, 'fallback is disabled'):
                p._generate(Path(tmp), self.job)
            model.assert_not_called()

    def test_raster_marker_counter_counts_pixels_independently_of_scene_code(self):
        width, height = 200, 150
        data = bytearray([240, 245, 240] * (width * height))
        for cx in (35, 100, 165):
            for y in range(height):
                for x in range(width):
                    if (x - cx) ** 2 + (y - 70) ** 2 <= 12 ** 2:
                        offset = (y * width + x) * 3
                        data[offset:offset + 3] = bytes([80, 170, 150])
        with patch.object(p.subprocess, 'check_output', return_value=bytes(data)):
            counted = p.science_marker_count(Path('actual-frame.jpg'), [0, 0, width, height])
        self.assertEqual(counted['count'], 3)
        self.assertEqual([m['bounds_xywh'][0] for m in counted['markers']], [23, 88, 153])
        # A joined region is not silently counted as one valid mass marker.
        for y in range(65, 75):
            for x in range(35, 101):
                offset = (y * width + x) * 3
                data[offset:offset + 3] = bytes([80, 170, 150])
        with patch.object(p.subprocess, 'check_output', return_value=bytes(data)):
            with self.assertRaisesRegex(ValueError, 'overlapping'):
                p.science_marker_count(Path('actual-frame.jpg'), [0, 0, width, height])

    def test_truncated_raster_is_rejected(self):
        with patch.object(p.subprocess, 'check_output', return_value=b'bad raster'):
            with self.assertRaisesRegex(ValueError, 'dimensions'):
                p.science_marker_count(Path('actual-frame.jpg'), [0, 0, 100, 100])

    def test_ice_review_uses_measured_counts_and_rejects_changed_mass(self):
        for counts in ([12, 11, 12, 11], [12, 12, 12, 11], [12, 11, 12, 10]):
            with self.subTest(counts=counts), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                names = [f'review-frame-{i}{suffix}.jpg' for i in (1, 2) for suffix in ('-start', '')]
                for name in names: (folder / name).write_bytes(name.encode())
                plan = {**self.plan, 'diagram_template': 'ice-density'}
                def crop(args): Path(args[-1]).write_bytes(b'actual crop')
                with patch.object(p, 'run', side_effect=crop), patch.object(p, 'science_marker_count', side_effect=[{'count': c, 'markers': []} for c in counts]):
                    if counts == [12, 11, 12, 11]:
                        _, prompt = p.diagram_final_review_inputs(folder, plan, names)
                        contract = json.loads((folder / 'final-review-inputs.json').read_text())
                        audit = contract['marker_audit']
                        self.assertIn(json.dumps(audit, ensure_ascii=False), prompt)
                        self.assertEqual([f['ice']['count'] for f in audit['frames']], [11, 11])
                        for frame in audit['frames']:
                            self.assertEqual(frame['sha256'], hashlib.sha256((folder / frame['file']).read_bytes()).hexdigest())
                    else:
                        with self.assertRaisesRegex(ValueError, 'marker counts changed'):
                            p.diagram_final_review_inputs(folder, plan, names)
                        self.assertFalse((folder / 'final-review-inputs.json').exists())



if __name__ == '__main__': unittest.main()
