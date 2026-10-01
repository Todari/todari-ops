"""Offline story-contract and orchestration tests, not a model quality benchmark."""
import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import content_pipeline as p

CASES = json.loads((Path(__file__).parent / 'fixtures/instatoon-stories.json').read_text())
GOOD = {'pass': True, 'scores': dict.fromkeys(('clarity', 'accuracy', 'visual', 'pacing'), 4),
        'blockers': [], 'summary': '검사 통과'}
BAD = {**GOOD, 'pass': False, 'blockers': ['우산 소유자가 바뀜'], 'fixes': '동생에게 빨간 우산을 돌려줄 것'}
FIDELITY = {'pass': True, 'unsupported_claims': [], 'missing_facts': [], 'summary': '원문에 충실함'}
INVENTED = {**FIDELITY, 'pass': False, 'unsupported_claims': ['쑥스러워 카메라를 가렸다'],
            'fixes': '동기를 삭제하고 관찰된 행동만 서술'}


class StoryQualityTests(unittest.TestCase):
    def test_facial_acting_belongs_to_a_present_character_and_has_all_controls(self):
        plan = copy.deepcopy(CASES[0]['plan'])
        panel = next(panel for panel in plan['panels'] if panel['characters'])
        character = panel['characters'][0]
        expression = {'gaze': 'phone', 'brows': 'relaxed', 'eyes': 'looking down', 'mouth': 'loosely closed'}
        panel['expressions'] = {character: expression}
        p.validate_story(plan, CASES[0]['body'])
        for invalid in ({'absent': expression}, {character: {'mouth': 'smiling'}}, []):
            panel['expressions'] = invalid
            with self.assertRaises(ValueError):
                p.validate_story(plan, CASES[0]['body'])

    def test_faceless_shots_do_not_require_added_faces_for_acting(self):
        plan = copy.deepcopy(CASES[0]['plan'])
        for panel in plan['panels']:
            panel['expressions'] = {}
        p.validate_story(plan, CASES[0]['body'])

    def test_malformed_review_is_retryable_and_does_not_poison_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            token = p.MODEL_CACHE.set(cache)
            self.addCleanup(p.MODEL_CACHE.reset, token)
            bad = {'candidates': [{'content': {'parts': [{'text': '{"pass":'}]}}]}
            good = {'candidates': [{'content': {'parts': [{'text': '```json\n{"pass": true}\n```'}]}}]}
            with patch.dict(os.environ, {'CONTENT_TEXT_MODEL': 'test-model', 'GEMINI_API_KEY': 'test'}), \
                    patch.object(p, 'request', side_effect=[bad, bad, good]) as network:
                with self.assertRaises(p.TransientGenerationError):
                    p.gemini('review')
                self.assertFalse(list(cache.glob('*.json')))
                self.assertEqual(p.gemini('review'), {'pass': True})
                self.assertEqual(p.gemini('review'), {'pass': True})
                self.assertEqual(network.call_count, 3)

    def test_preview_ignores_future_pending_bubbles_but_requires_current_detection(self):
        from unittest.mock import Mock
        plan = {'panels': [{}, {}], 'presentation': {'panels': [
            {'integrated_art': True, 'bubble_boxes': [{'x':1,'y':1,'width':300,'height':150}]},
            {'integrated_art': True}]}}
        layout = {'cards': [{'base':'art-0.png'}, {'base':'art-1.png'}]}
        with patch.object(p, 'module', return_value=Mock()), \
                patch.object(p, 'instatoon_layout', return_value=layout) as build:
            p.compose_instatoon_preview(Path('/episode'),Path('/repo'),plan,0,0)
            self.assertTrue(build.call_args.kwargs['measure_only'])
            with self.assertRaisesRegex(ValueError, 'Current integrated preview'):
                p.compose_instatoon_preview(Path('/episode'),Path('/repo'),plan,1,0)

    def test_integrated_style_allows_drawn_balloons_without_changing_legacy_policy(self):
        style = 'Fine pen. No text, captions, speech balloons, labels or watermark within art.'
        self.assertEqual(p.instatoon_style_for_display(style, {}), style)
        updated = p.instatoon_style_for_display(style, {'kind':'dialogue','integrated_art':True})
        self.assertNotIn('speech balloons,', updated)
        self.assertIn('No text', updated)
        self.assertIn('말풍선이 정상', updated)

    def test_review_schema_reaches_request_without_losing_repair_targets(self):
        payload = {**GOOD, 'fixes': '', 'repair_panels': [], 'repair_kind': 'none'}
        response = {'candidates': [{'content': {'parts': [{'text': json.dumps(payload)}]}}]}
        with patch.dict(os.environ, {'CONTENT_TEXT_MODEL': 'test-model', 'GEMINI_API_KEY': 'test'}), \
                patch.object(p, 'request', return_value=response) as request:
            p.review_media(p.RUBRIC + p.FINAL_REPAIR_RULES)
        schema = request.call_args.args[1]['generationConfig']['responseJsonSchema']
        self.assertIn('repair_panels', schema['required'])
        self.assertIn('repair_kind', schema['required'])

    def test_style_review_includes_new_character_identity_and_current_cast(self):
        identity = {'characters': [{'id': 'new', 'design': 'blue bob'}],
                    'panel': {'characters': ['new']}}
        with patch.object(p, 'review_media', return_value=GOOD) as review:
            p.review_instatoon_style('fine ink', ['style', 'other-character'], 'target',
                                     episode_cast='episode-cast', identity=identity)
        prompt, images = review.call_args.args
        self.assertEqual(images, ['style', 'other-character', 'episode-cast', 'target'])
        self.assertIn(json.dumps(identity, ensure_ascii=False), prompt)
        self.assertIn('reference_id 인물에만', prompt)

    def test_fidelity_audit_fails_closed(self):
        self.assertTrue(p.fidelity_ok(FIDELITY))
        for audit in ({}, GOOD, INVENTED, {**FIDELITY, 'pass': 'true'},
                      {**FIDELITY, 'missing_facts': ['답이 없는 이유는 모름']},
                      {**FIDELITY, 'summary': ''}):
            with self.subTest(audit=audit):
                self.assertFalse(p.fidelity_ok(audit))

    def test_diverse_story_contracts(self):
        for case in CASES:
            with self.subTest(story=case['id']):
                p.validate_plan(case['plan'], 'instatoon')
                p.validate_story(case['plan'], case['body'])

    def test_invalid_story_contracts_fail_closed(self):
        case = CASES[0]
        changes = [
            lambda s: s.pop('story'),
            lambda s: s['story']['facts'].append('범인이 고의로 삭제했다.'),
            lambda s: s['story']['characters'].append(s['story']['characters'][0]),
            lambda s: s['panels'][0].update(characters=['unknown']),
            lambda s: s['panels'][0].update(characters=[{}]),
            lambda s: s['panels'][0].update(location='unknown'),
            lambda s: s['panels'][0].update(source_facts=[99]),
            lambda s: s['panels'][0].update(source_facts=[True]),
            lambda s: s['panels'][0].update(source_facts=[]),
            lambda s: s['panels'][0].update(continuity=''),
            lambda s: s['panels'][0].update(beat=s['panels'][1]['beat']),
            lambda s: s['panels'][-1].update(source_facts=[0]),
            lambda s: s['story']['facts'].append(s['story']['facts'][0]),
        ]
        for i, change in enumerate(changes):
            with self.subTest(change=i):
                plan = copy.deepcopy(case['plan'])
                change(plan)
                with self.assertRaises(ValueError):
                    p.validate_story(plan, case['body'])

    def test_object_only_story_does_not_require_invented_people(self):
        case = copy.deepcopy(CASES[0])
        case['plan']['story']['characters'] = []
        for panel in case['plan']['panels']:
            panel['characters'] = []
        p.validate_story(case['plan'], case['body'])

    def test_publish_caption_adds_series_hashtags_once(self):
        self.assertEqual(p.publish_caption('instatoon', '공감 문구 '), '공감 문구\n\n' + p.INSTATOON_HASHTAGS)
        self.assertEqual(p.publish_caption('instatoon', '작가 지정 #태그'), '작가 지정 #태그')
        self.assertEqual(p.publish_caption('waenyamyeon', '설명'), '설명')

    def test_whitespace_caption_or_empty_lines_are_rejected(self):
        for text in ('   ', '\n', '대사\n\n끝'):
            plan = copy.deepcopy(CASES[0]['plan'])
            plan['panels'][0]['text'] = text
            with self.subTest(text=text), self.assertRaises(ValueError):
                p.validate_plan(plan, 'instatoon')
        plan['caption'] = '   '
        plan['panels'][0]['text'] = '대사'
        with self.assertRaises(ValueError):
            p.validate_plan(plan, 'instatoon')

    def test_returning_character_and_location_keep_their_first_appearance(self):
        panels = [
            {'characters': ['a'], 'location': 'home'},
            {'characters': ['b'], 'location': 'office'},
            {'characters': ['a'], 'location': 'home'},
            {'characters': ['a'], 'location': 'home'},
            {'characters': ['b'], 'location': 'office'},
        ]
        folder = Path('/example')
        self.assertEqual(p.instatoon_scene_refs(folder, [folder / 'cast.png'], panels, 4),
                         [folder / n for n in ('cast.png', 'art-1.png', 'art-3.png')])
        panels[-1]['characters'] = []
        self.assertEqual(p.instatoon_scene_refs(folder, [], panels, 4),
                         [folder / n for n in ('art-1.png', 'art-3.png')])

    def test_typography_checks_the_same_layout_as_final_render(self):
        from unittest.mock import Mock
        renderer = Mock()
        renderer.fit_text.return_value = {'size': 40, 'lines': ['한글', '대사']}
        with patch.object(p, 'module', return_value=renderer):
            report = p.validate_instatoon_text(Path('/repo'), CASES[0]['plan'])
        layout = p.instatoon_layout(CASES[0]['plan'])
        self.assertEqual(len(report), len(layout['cards']))
        for call, card in zip(renderer.fit_text.call_args_list, layout['cards']):
            self.assertEqual(call.args[0], card['layers'][0])
            self.assertEqual(call.args[1], (70, 55, 940, 270))
            self.assertEqual(call.args[2], layout['fonts'])

    def test_composed_preview_uses_final_layout_without_overwriting_final_card(self):
        from unittest.mock import Mock
        renderer = Mock()
        folder = Path('/episode')
        with patch.object(p, 'module', return_value=renderer):
            p.compose_instatoon_preview(folder, Path('/repo'), CASES[0]['plan'], 2, 1)
        card, layout, directory, prefix = renderer.render_card.call_args.args
        expected = p.instatoon_layout(CASES[0]['plan'])['cards'][2]
        self.assertEqual(card['base'], expected['base'])
        self.assertEqual(card['layers'], expected['layers'])
        self.assertEqual(card['output'], 'composed-2-attempt-1.png')
        self.assertEqual(directory, folder)
        self.assertIsNone(prefix)

    def run_story(self, case, failure=None, retain_sources=False):
        case = copy.deepcopy(case)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            root = folder / 'repo'
            (root / 'bible/sheets').mkdir(parents=True)
            p.dump(root / 'bible/prompt-library.json', {'style_prefix': 'ink style', 'negative': 'no text',
                                                       'style_reference': 'bible/sheets/selected-style.png',
                                                       'cast_library': 'bible/cast.json',
                                                       'retain_source_references': retain_sources})
            (root / 'bible/sheets/selected-style.png').write_bytes(b'new style')
            entries = []
            if case['plan']['story']['characters']:
                character = case['plan']['story']['characters'][0]
                character['reference_id'] = 'chosen-person'
                (root / 'bible/sheets/chosen-person.png').write_bytes(b'known person')
                entries.append({'id': 'chosen-person', 'design': character['design'], 'ready': True,
                                'image': 'bible/sheets/chosen-person.png',
                                'sha256': hashlib.sha256(b'known person').hexdigest()})
            p.dump(root / 'bible/cast.json', {'characters': entries})
            calls = []
            reviews = 0

            def model(prompt, files=(), search=False, image=False, aspect='4:5'):
                nonlocal reviews
                calls.append((prompt, list(files), image))
                if 'TARGETED_SOURCE_CORRECTION' in prompt:
                    return {'updates': []}
                if image:
                    return b'image'
                if 'JSON {"caption"' in prompt:
                    return case['plan']
                if '캐릭터 시트 검수.' in prompt and failure == 'cast':
                    return BAD
                if '이번 검수는 화풍·인물 동일성만' in prompt and failure == 'style':
                    return BAD
                if '이번 단계는 원화만 검수' in prompt:
                    reviews += 1
                    if failure == 'art' or (failure == 'retry' and reviews == 1):
                        return BAD
                return GOOD

            def render(folder, root, job, plan, draft=False):
                files = [f'card-{i}.jpg' for i in range(len(plan['panels']))]
                for name in files:
                    (folder / name).write_bytes(b'jpeg')
                return files, files

            job = {'kind': 'instatoon', 'topic': case['topic'], 'body': case['body']}
            with patch.dict(os.environ, {'INSTATOON_ROOT': str(root), 'INSTATOON_IG_USER_ID': 'test'}), \
                    patch.object(p, 'preflight'), patch.object(p, 'compose_instatoon_preview', side_effect=lambda folder, root, plan, i, attempt: folder / f'composed-{i}-attempt-{attempt}.png'), patch.object(p, 'review_story_fidelity',
                        return_value=INVENTED if failure == 'fidelity' else FIDELITY), patch.object(p, 'validate_instatoon_text',
                        side_effect=ValueError('40px에서도 넘침') if failure == 'typography' else None,
                        return_value=[]) as typography, patch.object(p, 'gemini', side_effect=model), \
                    patch.object(p, 'compose_instatoon_cast', side_effect=lambda folder, pieces, characters: (folder / 'cast.png').write_bytes(b'cast-layout')), patch.object(p, 'render', side_effect=render) as renderer:
                if failure in ('art', 'style'):
                    # A rejected panel becomes an operator draft: rendered, flagged, never publishable.
                    p.generate(folder, job)
                    self.assertFalse((folder / 'manifest.json').exists())
                    draft = json.loads((folder / 'draft.json').read_text())
                    self.assertTrue(draft['failed_panels'])
                    self.assertTrue(all('index' in f and isinstance(f['blockers'], list) for f in draft['failed_panels']))
                    self.assertEqual(renderer.call_args.kwargs.get('draft'), True)
                    return
                if failure in ('cast', 'typography', 'fidelity'):
                    with self.assertRaises(ValueError):
                        p.generate(folder, job)
                    self.assertFalse((folder / 'manifest.json').exists())
                    self.assertFalse((folder / 'draft.json').exists())
                    renderer.assert_not_called()
                    if failure == 'fidelity':
                        self.assertFalse(any(c[2] for c in calls))
                        self.assertIn(INVENTED['fixes'], calls[-1][0])
                        self.assertFalse(json.loads((folder / 'fidelity-1.json').read_text())['pass'])
                    if failure == 'typography':
                        # Bounded at four full plan rewrites since 2026-09-16 (long dopamine stories).
                        self.assertEqual(typography.call_count, 4)
                        self.assertFalse(any(c[2] for c in calls))
                        self.assertIn('40px에서도 넘침', calls[-1][0])
                    return
                p.generate(folder, job)
            self.assertTrue((folder / 'manifest.json').exists())
            expected = [(root / 'bible/sheets/selected-style.png').resolve()]
            if entries:
                expected.append((root / 'bible/sheets/chosen-person.png').resolve())
                self.assertEqual((folder/'cast-character-0/original.png').read_bytes(),b'known person')
            cast_calls=[c for c in calls if c[2] and 'Create a character reference sheet' in c[0]]
            new_characters=[c for c in case['plan']['story']['characters'] if not c.get('reference_id')]
            self.assertEqual(len(cast_calls),len(new_characters) if entries else 1)
            self.assertTrue(all(c[1]==expected[:1] for c in cast_calls))
            self.assertEqual(json.loads((folder / 'story.json').read_text()), case['plan']['story'])
            art_calls = [c for c in calls if c[2] and 'current_panel' in c[0]]
            self.assertEqual(len(art_calls), 6 if failure == 'retry' else 5)
            anchors = [folder / 'cast.png'] + (expected if retain_sources else [])
            self.assertEqual(art_calls[-1][1], anchors + [folder / n for n in ('art-0.png', 'art-3.png')])
            snapshot = json.loads((folder / 'style-config.json').read_text())
            self.assertEqual([item['file'] for item in snapshot['references']], [str(p) for p in anchors])
            art_checks = [c for c in calls if '이번 단계는 원화만 검수' in c[0]]
            self.assertEqual(art_checks[-1][1], art_calls[-1][1] + [folder / 'art-4.png', folder / 'composed-4-attempt-art-0.png'])
            self.assertIn('source_facts', art_calls[-1][0])
            self.assertIn('Draw ONLY current_panel.characters', art_calls[-1][0])
            final_calls = [c for c in calls if '최종 완성본 검수.' in c[0]]
            self.assertEqual(final_calls[0][1], [folder / 'cast.png'] + [folder / f'card-{i}.jpg' for i in range(5)])
            if failure == 'retry':
                self.assertIn(BAD['fixes'], art_calls[1][0])

    def test_diverse_stories_use_own_cast_and_sequence_references(self):
        for case in CASES:
            with self.subTest(story=case['id']):
                self.run_story(case)

    def test_original_style_and_identity_survive_through_later_panels(self):
        self.run_story(CASES[0], retain_sources=True)

    def test_style_drift_blocks_completion_even_when_story_review_passes(self):
        self.run_story(CASES[0], failure='style', retain_sources=True)

    def test_failed_cast_or_art_never_reaches_render(self):
        for failure in ('cast', 'art', 'typography', 'fidelity'):
            with self.subTest(stage=failure):
                self.run_story(CASES[-1], failure)

    def test_visual_feedback_reaches_retry(self):
        self.run_story(CASES[-1], 'retry')


if __name__ == '__main__':
    unittest.main()
