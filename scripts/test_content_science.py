import copy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import content_pipeline as p


class SciencePipelineTests(unittest.TestCase):
    def setUp(self):
        self.evidence = {'supported_passages': [
            {'id': 0, 'text': 'Water vapor condenses on the cold cup.',
             'sources': [{'url': 'https://science.example/cup', 'title': 'Condensation'}]},
        ]}
        self.plan = {'caption': '왜냐맨', 'claims': [
            {'id': 'c1', 'statement': '컵 밖의 물은 공기 중 수증기에서 왔어요.', 'evidence_ids': [0]},
        ], 'panels': [
            {'text': '차가운 컵 바깥에 물방울이 맺혀요.\n이 물은 어디서 생긴 걸까요?\n공기의 변화를 알아봐요.',
             'framing': 'wide', 'visual': 'A cold cup with small water drops on its outer surface',
             'claim_ids': ['c1']}
            for i in range(5)
        ]}

    def test_why_accepts_unwrapped_narration_without_changing_text(self):
        plan = copy.deepcopy(self.plan)
        for i, panel in enumerate(plan['panels']):
            panel['text'] = panel['text'].replace('\n', ' ')
            panel['framing'] = ['wide', 'medium', 'close-up'][i % 3]
        original = copy.deepcopy(plan)
        p.validate_plan(plan, 'waenyamyeon')
        p.validate_science_plan(plan, self.evidence)
        self.assertEqual(plan, original)
        # The card renderer still requires explicit line limits.
        with self.assertRaisesRegex(ValueError, '3 lines of 22'):
            p.validate_plan(plan, 'instatoon')
        for text in (' ' * 40, '가' * 91):
            bad = copy.deepcopy(plan)
            bad['panels'][0]['text'] = text
            with self.assertRaises(ValueError): p.validate_plan(bad, 'waenyamyeon')

    def test_only_supported_search_spans_become_evidence(self):
        evidence = {'grounding': {
            'groundingChunks': [{'web': {'uri': 'https://science.example/cup', 'title': 'Source'}}],
            'groundingSupports': [
                {'segment': {'text': 'Supported sentence'}, 'groundingChunkIndices': [0]},
                {'segment': {'text': 'Invented source index'}, 'groundingChunkIndices': [99]},
            ],
        }}
        passages = p.grounded_passages(evidence)
        self.assertEqual(len(passages), 1)
        self.assertEqual(passages[0]['text'], 'Supported sentence')
        self.assertEqual(passages[0]['sources'][0]['url'], 'https://science.example/cup')
        with self.assertRaises(ValueError): p.grounded_passages({'grounding': {}})

    def test_utf8_support_offsets_select_correct_paragraph_without_inventing_context(self):
        phrase = "That's condensation."
        first = '다른 문맥: ' + phrase
        second = '직접 근거: "Have you seen water outside a cold glass? ' + phrase + '"'
        response = first + '\n\n' + second + '\n\nDiscord completion simulation must not enter evidence.'
        char_start = response.rfind(phrase)
        byte_start = len(response[:char_start].encode('utf-8'))
        segment = {'text': phrase, 'startIndex': byte_start, 'endIndex': byte_start + len(phrase.encode('utf-8'))}
        self.assertEqual(p.support_paragraph(response, segment), second)
        # Repeated text with absent/unusable offsets is ambiguous and must fail closed.
        self.assertIsNone(p.support_paragraph(response, {'text': phrase}))
        unique = '한글 앞문단\n\n' + second + '\n\nAnother section'
        self.assertEqual(p.support_paragraph(unique, {'text': phrase, 'startIndex': 1, 'endIndex': 2}), second)
        self.assertIsNone(p.support_paragraph(unique, {'text': 'not present'}))

    def test_science_view_preserves_supported_span_but_excludes_simulated_work(self):
        paragraph = '근거: "Have you seen water outside a cold glass? That is condensation."'
        raw = {'text': paragraph + '\n\nDiscord completion simulation must not enter evidence.',
               'grounding': {
                   'groundingChunks': [{'web': {'uri': 'https://science.example/cup'}}],
                   'groundingSupports': [{'segment': {'text': 'That is condensation.'}, 'groundingChunkIndices': [0]}],
               }}
        raw['supported_passages'] = p.grounded_passages(raw)
        view = p.science_evidence_view(raw)
        self.assertEqual(view['supported_passages'][0]['text'], 'That is condensation.')
        self.assertEqual(view['supported_passages'][0]['support_segment'], {'text': 'That is condensation.'})
        self.assertEqual(view['supported_passages'][0]['context'], paragraph)
        self.assertNotIn('Discord completion simulation', json.dumps(view))
        self.assertIn('Discord completion simulation', raw['text'])
        self.assertIn('원문', view['context_note'])

    def test_retry_receives_original_candidate_and_concrete_errors_without_research_simulation(self):
        raw = {'text': 'Water vapor condenses.\n\nDiscord completion simulation must not enter evidence.',
               'grounding': {
                   'groundingChunks': [{'web': {'uri': 'https://science.example/cup'}}],
                   'groundingSupports': [{'segment': {'text': 'Water vapor condenses.'}, 'groundingChunkIndices': [0]}],
               }}
        bad = copy.deepcopy(self.plan)
        for panel in bad['panels']: panel['text'] = '가'
        bad['panels'][0]['visual'] = 'short'
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            root = folder / 'repo'
            (root / 'prompts').mkdir(parents=True)
            (root / 'prompts/style_prefix.txt').write_text('fixed style')
            with patch.dict(os.environ, {'WAENYAMYEON_ROOT': str(root)}), \
                 patch.object(p, 'preflight'), patch.object(p, 'gemini', side_effect=[raw, bad, bad, bad]) as model:
                with self.assertRaisesRegex(ValueError, 'Editorial review failed'):
                    p._generate(folder, {'kind': 'waenyamyeon', 'topic': 'Cold cup', 'body': 'Scientific scope only'}, legacy=True)
            first_prompt = model.call_args_list[1].args[0]
            retry_prompt = model.call_args_list[2].args[0]
            self.assertNotIn('Discord completion simulation', first_prompt)
            self.assertNotIn('인스타툰', first_prompt)
            self.assertIn('화자명이나 인용 대사 형식을 사용하지 않는다', first_prompt)
            self.assertIn('이전 대본:', retry_prompt)
            self.assertIn('Missing visual direction', retry_prompt)
            self.assertIn('Found 5 narration characters', retry_prompt)
            self.assertEqual(json.loads((folder / 'plan-0.json').read_text()), bad)
            self.assertIn('Missing visual direction', json.loads((folder / 'plan-error-0.json').read_text())['error'])
            self.assertIn('Discord completion simulation', json.loads((folder / 'evidence.json').read_text())['text'])

    def test_every_explanation_has_valid_claim_and_evidence(self):
        p.validate_science_plan(self.plan, self.evidence)
        for refs in ([99], [], [0, 0], [{}], [True]):
            bad = copy.deepcopy(self.plan)
            bad['claims'][0]['evidence_ids'] = refs
            with self.assertRaises(ValueError): p.validate_science_plan(bad, self.evidence)
        bad = copy.deepcopy(self.plan); bad['panels'][-1]['claim_ids'] = []
        with self.assertRaises(ValueError): p.validate_science_plan(bad, self.evidence)
        bad = copy.deepcopy(self.plan); bad['panels'][1]['claim_ids'] = ['invented']
        with self.assertRaises(ValueError): p.validate_science_plan(bad, self.evidence)

    def test_consistent_scene_count_and_narration_bounds(self):
        bad = copy.deepcopy(self.plan); bad['panels'] += bad['panels'][:2]
        with self.assertRaises(ValueError): p.validate_science_plan(bad, self.evidence)
        for text in ('짧아요', '가' * 80):
            bad = copy.deepcopy(self.plan)
            for panel in bad['panels']: panel['text'] = text
            with self.assertRaises(ValueError): p.validate_science_plan(bad, self.evidence)

    def test_speaker_labels_never_reach_science_narration(self):
        for label in ('왜냐맨:', '내레이터：', 'Narrator:'):
            bad = copy.deepcopy(self.plan)
            bad['panels'][1]['text'] = label + ' ' + bad['panels'][1]['text']
            with self.assertRaisesRegex(ValueError, 'spoken speaker label'):
                p.validate_science_plan(bad, self.evidence)
        good = copy.deepcopy(self.plan)
        good['panels'][1]['text'] = '왜냐맨과 알아봐요. ' + good['panels'][1]['text']
        p.validate_science_plan(good, self.evidence)

    def test_audit_cannot_skip_duplicate_or_overrule_unsupported_claims(self):
        verdict = {'id': 'c1', 'supported': True, 'reason': 'The cited passage explicitly identifies water vapor as the source.'}
        audit = {'pass': True, 'claims': [verdict], 'unsupported_statements': [], 'fixes': ''}
        self.assertTrue(p.science_audit_ok(audit, self.plan))
        for bad in ({**audit, 'claims': []}, {**audit, 'claims': [verdict, verdict]},
                    {**audit, 'claims': [{**verdict, 'supported': False}]},
                    {**audit, 'claims': [{**verdict, 'id': {}}]},
                    {**audit, 'unsupported_statements': ['Always true in every condition']},
                    {**audit, 'pass': 'true'}):
            self.assertFalse(p.science_audit_ok(bad, self.plan))

    def good_audit(self, plan):
        return {'pass': True, 'claims': [{'id': claim['id'], 'supported': True, 'reason': 'Explicit support in the supplied evidence.'}
                                         for claim in plan['claims']], 'unsupported_statements': [], 'fixes': ''}

    def good_editorial(self):
        return {'pass': True, 'scores': dict.fromkeys(('clarity', 'accuracy', 'visual', 'pacing'), 4),
                'blockers': [], 'summary': 'Verified complete draft', 'fixes': ''}

    def test_art_guard_rejects_drawn_effects_but_accepts_negative_instructions(self):
        for wording in ('No text, labels, arrows, glow or particles.',
                        'Water vapor is not shown as particles. No glow.',
                        'Avoid glowing marks; without arrows or sparks.'):
            plan = copy.deepcopy(self.plan)
            plan['panels'][0]['visual'] += '. ' + wording
            p.validate_science_art(plan)
        for wording in ('An orange glow surrounds the glass. No arrows.',
                        'Tiny particles float visibly around the glass.',
                        'Arrows show energy trails around the surface.'):
            plan = copy.deepcopy(self.plan)
            plan['panels'][0]['visual'] = wording
            with self.assertRaisesRegex(ValueError, 'Panel 1 visual requests forbidden'):
                p.validate_science_art(plan)

    def test_approved_editorial_checkpoint_requires_identical_inputs_and_intact_hash(self):
        job = {'id': 'job', 'kind': 'waenyamyeon', 'topic': 'Cold glass', 'body': 'Scope', 'generationAttempts': 1}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', side_effect=[self.plan, self.good_editorial()]) as model, \
                 patch.object(p, 'audit_science_plan', return_value=self.good_audit(self.plan)):
                self.assertEqual(p.science_editorial(folder, job, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief'), self.plan)
                self.assertEqual(model.call_count, 2)
            with patch.object(p, 'gemini') as model, patch.object(p, 'audit_science_plan') as audit:
                self.assertEqual(p.science_editorial(folder, {**job, 'generationAttempts': 2}, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief'), self.plan)
                model.assert_not_called(); audit.assert_not_called()
            checkpoint = json.loads((folder / 'editorial-checkpoint.json').read_text())
            self.assertIsNone(p.read_editorial_checkpoint(folder, 'changed spec'))
            checkpoint['plan']['caption'] = 'tampered'
            p.dump(folder / 'editorial-checkpoint.json', checkpoint)
            self.assertIsNone(p.read_editorial_checkpoint(folder, checkpoint['spec']))

    def test_editorial_budget_is_three_and_next_worker_attempt_repairs_last_candidate(self):
        job = {'id': 'job', 'kind': 'waenyamyeon', 'topic': 'Cold glass', 'body': 'Scope', 'generationAttempts': 1}
        bad = copy.deepcopy(self.plan)
        for panel in bad['panels']: panel['text'] = '가'
        candidates = [{**copy.deepcopy(bad), 'caption': f'candidate-{i}'} for i in range(3)]
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', side_effect=candidates) as model:
                with self.assertRaisesRegex(ValueError, 'three new candidates'):
                    p.science_editorial(folder, job, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
                self.assertEqual(model.call_count, 3)
            with patch.object(p, 'gemini') as model:
                with self.assertRaisesRegex(ValueError, 'three new candidates'):
                    p.science_editorial(folder, job, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
                model.assert_not_called()
            with patch.object(p, 'gemini', side_effect=[self.plan, self.good_editorial()]) as model, \
                 patch.object(p, 'audit_science_plan', return_value=self.good_audit(self.plan)):
                p.science_editorial(folder, {**job, 'generationAttempts': 2}, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
                self.assertIn('candidate-2', model.call_args_list[0].args[0])
                self.assertIn('Found 5 narration characters', model.call_args_list[0].args[0])
            self.assertEqual(json.loads((folder / 'plan-2.json').read_text())['caption'], 'candidate-2')
            self.assertEqual(json.loads((folder / 'plan-3.json').read_text()), self.plan)

    def test_transient_audit_resumes_saved_candidate_without_paid_plan_regeneration(self):
        job = {'id': 'job', 'kind': 'waenyamyeon', 'topic': 'Cold glass', 'body': 'Scope', 'generationAttempts': 1}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', return_value=self.plan) as model, \
                 patch.object(p, 'audit_science_plan', side_effect=p.TransientGenerationError):
                with self.assertRaises(p.TransientGenerationError):
                    p.science_editorial(folder, job, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
                self.assertEqual(model.call_count, 1)
            with patch.object(p, 'gemini', return_value=self.good_editorial()) as model, \
                 patch.object(p, 'audit_science_plan', return_value=self.good_audit(self.plan)):
                p.science_editorial(folder, {**job, 'generationAttempts': 2}, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
                self.assertEqual(model.call_count, 1)
                self.assertTrue(model.call_args.args[0].startswith(p.RUBRIC))

    def test_every_scene_including_opening_question_requires_claim_links(self):
        item_schema = p.SCIENCE_PLAN_SCHEMA['properties']['panels']['items']
        self.assertEqual(item_schema['properties']['claim_ids']['minItems'], 1)
        for index in range(len(self.plan['panels'])):
            invalid = copy.deepcopy(self.plan)
            invalid['panels'][index]['claim_ids'] = []
            with self.assertRaisesRegex(ValueError, f'Panel {index + 1}'):
                p.validate_science_plan(invalid, self.evidence)

    def test_missing_claim_link_can_be_corrected_without_rewriting_supported_content(self):
        incomplete = copy.deepcopy(self.plan)
        incomplete['panels'][0]['claim_ids'] = []
        job = {'id': 'job', 'kind': 'waenyamyeon', 'topic': 'Cold glass', 'body': 'Scope', 'generationAttempts': 1}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.object(p, 'gemini', side_effect=[incomplete, self.plan, self.good_editorial()]) as model, \
                 patch.object(p, 'audit_science_plan', return_value=self.good_audit(self.plan)) as audit:
                result = p.science_editorial(folder, job, self.evidence, 'rules', p.SCIENCE_STYLE, 'brief')
            audit.assert_called_once()
            self.assertIn('correct claim_ids without rewriting supported facts', model.call_args_list[1].args[0])
            self.assertIn('panel.claim_ids만 고친다', model.call_args_list[1].args[0])
            for before, after in zip(incomplete['panels'], result['panels']):
                self.assertEqual({k: v for k, v in before.items() if k != 'claim_ids'},
                                 {k: v for k, v in after.items() if k != 'claim_ids'})
            self.assertEqual(result['claims'], incomplete['claims'])
            self.assertEqual(json.loads((folder / 'plan-0.json').read_text()), incomplete)

    def test_primary_body_can_supply_evidence_when_search_has_no_grounding(self):
        raw = {'text': 'Unverified model claim must not become a source.', 'grounding': {}}
        primary = {'id': 0, 'source_type': 'retrieved_primary_page', 'text': 'Retrieved primary evidence.',
                   'sources': [{'url': 'https://science.example.gov/article'}]}
        seen = []
        def augment(evidence, body, folder):
            seen.append(copy.deepcopy(evidence))
            return {**evidence, 'supported_passages': [primary]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'gemini', return_value=raw), \
             patch.object(p, 'module', return_value=SimpleNamespace(augment_primary_sources=augment)):
            evidence = p.collect_science_evidence(Path(tmp), {'topic': 'Science question', 'body': 'Primary URL'})
        self.assertEqual(seen[0]['supported_passages'], [])
        self.assertEqual(evidence['supported_passages'], [primary])
        self.assertNotIn('Unverified model claim', json.dumps(p.science_evidence_view(evidence)))

    def test_missing_grounding_and_failed_primary_fetch_cannot_enter_production(self):
        raw = {'text': 'Unverified model claim must not become a source.', 'grounding': {}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'gemini', return_value=raw), \
             patch.object(p, 'module', return_value=SimpleNamespace(augment_primary_sources=lambda e, b, f: e)):
            with self.assertRaisesRegex(ValueError, 'Verified search passages or directly retrieved'):
                p.collect_science_evidence(Path(tmp), {'topic': 'Science question', 'body': 'Primary URL'})
            self.assertEqual(json.loads((Path(tmp) / 'evidence.json').read_text())['supported_passages'], [])

    def run_art_fixture(self, pipeline, folder, allow_failure=False, feedback_text='Correct object size only', reject_repairs=True, final_requests=None):
        root = folder / 'repo'
        (root / 'public/anchor').mkdir(parents=True, exist_ok=True)
        (root / 'public/anchor/anchor.png').write_bytes(b'style-reference')
        (folder / 'final.mp4').write_bytes(b'final-video')
        (folder / 'preview.mp4').write_bytes(b'preview-video')
        raw = {'text': 'Supported science.', 'grounding': {
            'groundingChunks': [{'web': {'uri': 'https://science.example.gov/article'}}],
            'groundingSupports': [{'segment': {'text': 'Supported science.'}, 'groundingChunkIndices': [0]}],
        }}
        images, reviews, search_prompts = [], [], []
        counts = {}
        def model(prompt, files=(), search=False, image=False, **kwargs):
            if search:
                search_prompts.append(prompt)
                return raw
            if image:
                index = int(p.re.search(r'"current_panel": (\d+)', prompt).group(1))
                attempt = counts.get(index, 0)
                counts[index] = attempt + 1
                images.append({'index': index, 'attempt': attempt, 'prompt': prompt,
                               'files': [file.name for file in files], 'bytes': [file.read_bytes() for file in files]})
                return f'art-{index}-candidate-{attempt}'.encode()
            if final_requests is not None and '최종 완성본 파일 역할:' in prompt:
                final_requests.append({'prompt': prompt, 'files': [file.name for file in files]})
            if files and files[-1].name.startswith('art-') and '원화 검수 계약 데이터:' in prompt:
                index = int(files[-1].stem.split('-')[1])
                reviews.append({'index': index, 'files': [file.name for file in files], 'prompt': prompt})
                if reject_repairs and index == 2 and counts.get(index, 0) <= 2:
                    return {**self.good_editorial(), 'pass': False, 'blockers': ['Object size defect'],
                            'scores': {**self.good_editorial()['scores'], 'visual': 3}, 'fixes': feedback_text}
            return self.good_editorial()
        with patch.dict(os.environ, {'WAENYAMYEON_ROOT': str(root)}), patch.object(pipeline, 'preflight'), \
             patch.object(pipeline, 'science_editorial', return_value=self.plan), \
             patch.object(pipeline, 'module', return_value=SimpleNamespace(augment_primary_sources=lambda e, b, f: e)), \
             patch.object(pipeline, 'render', return_value=(['final.mp4'], ['preview.mp4'])), \
             patch.object(pipeline, 'gemini', side_effect=model):
            try:
                pipeline._generate(folder, {'id': 'job', 'kind': 'waenyamyeon', 'topic': 'Question', 'body': 'Scope'}, legacy=True)
            except ValueError:
                if not allow_failure:
                    raise
        return images, reviews, search_prompts

    def test_image_repairs_target_only_failed_candidate_but_reviews_keep_sequence_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            images, reviews, _ = self.run_art_fixture(p, folder)
            scene = [item for item in images if item['index'] == 2]
            self.assertEqual(len(scene), 3)
            self.assertEqual(scene[0]['files'], ['anchor.png', 'art-0.png', 'art-1.png'])
            self.assertIn('The first reference is STYLE ONLY', scene[0]['prompt'])
            for attempt in (1, 2):
                self.assertEqual(scene[attempt]['files'], ['art-2.png'])
                self.assertEqual(scene[attempt]['bytes'], [f'art-2-candidate-{attempt - 1}'.encode()])
                self.assertIn('Edit the SINGLE attached image', scene[attempt]['prompt'])
                self.assertNotIn('The first reference is STYLE ONLY', scene[attempt]['prompt'])
            for check in [item for item in reviews if item['index'] == 2]:
                self.assertEqual(check['files'], ['anchor.png', 'art-0.png', 'art-1.png', 'art-2.png'])
            self.assertEqual((folder / 'art-2-attempt-0.png').read_bytes(), b'art-2-candidate-0')
            self.assertTrue(json.loads((folder / 'art-review-2-2.json').read_text())['pass'])

    def test_art_review_receives_current_plan_and_previous_requested_repair(self):
        self.plan['panels'][2]['visual'] = 'A wide view of the same cup on a small cork coaster, supported by a simple tabletop.'
        self.plan['panels'][2]['framing'] = 'wide'
        with tempfile.TemporaryDirectory() as tmp:
            images, reviews, _ = self.run_art_fixture(p, Path(tmp))
        checks = [check for check in reviews if check['index'] == 2]
        self.assertEqual(len(checks), 3)
        for index, check in enumerate(checks):
            payload = check['prompt'].split('원화 검수 계약 데이터:', 1)[1]
            data, _ = json.JSONDecoder().raw_decode(payload)
            self.assertEqual(data['approved_current_panel'], self.plan['panels'][2])
            if index == 0:
                self.assertIsNone(data['previous_review'])
            else:
                self.assertEqual(data['previous_review']['fixes'], 'Correct object size only')
                self.assertEqual(data['previous_review']['blockers'], ['Object size defect'])
                self.assertFalse(data['previous_review']['pass'])
        repairs = [item for item in images if item['index'] == 2 and item['attempt'] > 0]
        for repair in repairs:
            self.assertIn('approved current_panel visual and framing', repair['prompt'])
            self.assertIn('do not alternate between adding and removing an approved prop', repair['prompt'])
            self.assertEqual(repair['files'], ['art-2.png'])
        # The helper is an exact no-op for the independent instatoon review contract.
        self.assertEqual(p.science_art_review_context('instatoon', self.plan['panels'][2], 'unused'), '')

    def test_repair_can_change_defective_viewpoint_and_placement_while_preserving_identity(self):
        cases = [
            ('A low-angle view of the same cup with its rim seen from below and clear space around it.',
             'Change the viewpoint to the approved low angle; the current eye-level view is wrong.'),
            ('A metal spoon and a wooden spoon lie separately side by side with a clear gap between them.',
             'Move the utensils apart and correct their relative sizes; the current shapes overlap.'),
        ]
        for visual, feedback in cases:
            with self.subTest(feedback=feedback), tempfile.TemporaryDirectory() as tmp:
                self.plan['panels'][2]['visual'] = visual
                images, _, _ = self.run_art_fixture(p, Path(tmp), feedback_text=feedback)
            for repair in [item for item in images if item['index'] == 2 and item['attempt'] > 0]:
                self.assertEqual(repair['files'], ['art-2.png'])
                self.assertIn(feedback, repair['prompt'])
                self.assertIn(visual, repair['prompt'])
                self.assertIn('you MUST visibly change that specific aspect', repair['prompt'])
                self.assertIn('Preserve correct details and the identity, shape, colors and material', repair['prompt'])
                self.assertNotIn('Preserve its exact composition', repair['prompt'])
                self.assertNotIn("Preserve this candidate's composition", repair['prompt'])

    def test_existing_art_is_rechecked_and_reused_without_image_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self.run_art_fixture(p, folder)
            before = [(folder / f'art-{i}.png').read_bytes() for i in range(len(self.plan['panels']))]
            images, checks, _ = self.run_art_fixture(p, folder, reject_repairs=False)
            self.assertEqual(images, [])
            self.assertEqual(len(checks), len(self.plan['panels']))
            self.assertEqual(before, [(folder / f'art-{i}.png').read_bytes() for i in range(len(self.plan['panels']))])
            for index in range(len(self.plan['panels'])):
                self.assertTrue(json.loads((folder / f'art-reuse-review-{index}.json').read_text())['pass'])
                self.assertEqual((folder / f'art-{index}-reuse-input.png').read_bytes(), before[index])

    def test_existing_art_does_not_bypass_current_strict_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            original_images, _, _ = self.run_art_fixture(p, folder)
            self.assertTrue(json.loads((folder / 'art-review-2-2.json').read_text())['pass'])
            images, _, _ = self.run_art_fixture(p, folder, reject_repairs=True)
            self.assertFalse(json.loads((folder / 'art-reuse-review-2.json').read_text())['pass'])
            self.assertEqual([item['index'] for item in images], [2, 2, 2])
            first_original = next(item for item in original_images if item['index'] == 2 and item['attempt'] == 0)
            self.assertEqual(images[0], first_original)

    def test_final_review_separates_composited_frames_from_raw_art(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            direction = {'scenes': [{'overlays': [{'type': 'callout', 'text': '코드 라벨'}]}]}
            p.dump(folder / 'direction.json', direction)
            final_requests = []
            self.run_art_fixture(p, folder, final_requests=final_requests)
            self.assertEqual(len(final_requests), 1)
            self.assertEqual(final_requests[0]['files'], ['preview.mp4'] + [f'art-{i}.png' for i in range(len(self.plan['panels']))])
            metadata = json.loads((folder / 'final-review-inputs.json').read_text())
            self.assertEqual(metadata['direction'], direction)
            self.assertEqual(metadata['files'][0]['role'], 'rendered_video')
            self.assertEqual([item['scene_index'] for item in metadata['files'][1:]], list(range(len(self.plan['panels']))))
            self.assertTrue(all(item['role'] == 'raw_art' for item in metadata['files'][1:]))
            self.assertIn('원화의 글씨·화살표 금지는 raw_art에 적용한다', final_requests[0]['prompt'])
            self.assertIn('코드로 합성했다는 이유로 통과시키지 않는다', final_requests[0]['prompt'])
            # The instatoon final review receives its original file set and no why-specific notes.
            files, notes = p.final_review_inputs(folder, 'instatoon', self.plan, ['preview.mp4'])
            self.assertEqual(files, [folder / 'preview.mp4'])
            self.assertEqual(notes, '')

    def test_json_contract_is_sent_and_part_of_paid_response_cache_key(self):
        result = {'candidates': [{'content': {'parts': [{'text': '{"answer":42}'}]}}]}
        schemas = [{'type': 'object', 'properties': {'answer': {'type': kind}}} for kind in ('integer', 'number')]
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CONTENT_TEXT_MODEL': 'test', 'GEMINI_API_KEY': 'private'}):
            token = p.MODEL_CACHE.set(Path(tmp))
            try:
                with patch.object(p, 'request', return_value=result) as request:
                    for schema in (schemas[0], schemas[0], schemas[1]):
                        self.assertEqual(p.gemini('plan', json_schema=schema), {'answer': 42})
                    self.assertEqual(request.call_count, 2)
                    self.assertEqual(request.call_args.args[1]['generationConfig']['responseJsonSchema'], schemas[1])
            finally:
                p.MODEL_CACHE.reset(token)

    def test_direction_failure_saves_candidate_and_precise_feedback(self):
        director = SimpleNamespace(AUTO_DIRECTION_RULES='automatic direction only', DIRECTION_SCHEMA={'type': 'object'},
                                   validate_auto_direction=Mock(side_effect=ValueError('unsafe label position')))
        candidate = {'scenes': [{'overlays': [{'type': 'callout', 'labelY': 0.99}]}]}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with patch.dict('sys.modules', {'PIL': SimpleNamespace(Image=Mock())}), \
                 patch.object(p, 'module', return_value=director), patch.object(p, 'gemini', return_value=candidate) as model:
                with self.assertRaisesRegex(ValueError, 'Animation direction failed'):
                    p.render(folder, folder, {'kind': 'waenyamyeon'}, self.plan)
                self.assertEqual(model.call_count, 2)
                self.assertIn('previous_candidate', model.call_args.args[0])
                self.assertEqual(model.call_args.kwargs['json_schema'], director.DIRECTION_SCHEMA)
            self.assertEqual(json.loads((folder / 'direction-attempt-0.json').read_text()), candidate)
            self.assertEqual(json.loads((folder / 'direction-error-1.json').read_text()), {'error': 'unsafe label position'})


if __name__ == '__main__': unittest.main()
