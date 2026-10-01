import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

import content_pipeline as p
from test_instatoon_quality import CASES, GOOD, BAD, FIDELITY, INVENTED


class RepairTests(unittest.TestCase):
    def test_planned_lettering_skips_bubble_detection_and_keeps_repair_target_last(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            plan=copy.deepcopy(CASES[0]['plan'])
            display={'kind':'dialogue','integrated_art':True,'layout_mode':'planned-pen-v1','speech':[]}
            plan['presentation']={'panels':[display]}
            director=Mock()
            director.render_lettering_guide.return_value=folder/'layout-guide-0.png'
            director.lettering_art_prompt.return_value='LAYOUT-FIRST CONTRACT: Draw NO balloons.'
            director.clean_planned_art.return_value={'page_frame':False,'erased_regions':[]}
            with patch.object(p,'gemini',side_effect=[b'art',BAD,b'repair',GOOD]) as model, \
                    patch.object(p,'module',return_value=director), \
                    patch.object(p,'locate_instatoon_lettering'), \
                    patch.object(p,'compose_instatoon_preview',return_value=folder/'preview.png'):
                p.generate_instatoon_card(folder,folder,plan,0,'style','{}',[])
            self.assertEqual(model.call_count,4)
            self.assertIn('LAYOUT-FIRST CONTRACT',model.call_args_list[0].args[0])
            self.assertNotIn('Draw exactly one EMPTY',model.call_args_list[0].args[0])
            self.assertTrue(all('layout-guide' not in f.name for call in model.call_args_list if call.kwargs.get('image') for f in call.args[1]))
            self.assertEqual(model.call_args_list[2].args[1][-1].name,'art-0-repair-input-1.png')
            self.assertNotIn('Preserve correct empty balloon outlines',model.call_args_list[2].args[0])
            director.refine_bubble_boxes.assert_not_called()
            director.clean_planned_art.assert_not_called()
            self.assertTrue((folder/'accepted-art-0.json').exists())

    def test_layout_space_failure_restages_instead_of_editing_the_rejected_camera(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            plan=copy.deepcopy(CASES[0]['plan'])
            display={'kind':'dialogue','integrated_art':True,'layout_mode':'planned-pen-v1','speech':[],
                     'lettering':{'layers':[{'outline':{'x':42,'y':55,'width':600,'height':160}}]}}
            plan['presentation']={'panels':[display]}
            director=Mock()
            director.render_lettering_guide.return_value=folder/'layout-guide-0.png'
            director.lettering_art_prompt.return_value='LAYOUT-FIRST CONTRACT: Draw NO balloons.'
            director.clean_planned_art.return_value={'page_frame':False,'erased_regions':[]}
            with patch.object(p,'gemini',side_effect=[b'art',b'restaged',GOOD]) as model, \
                    patch.object(p,'module',return_value=director), \
                    patch.object(p,'locate_instatoon_lettering',side_effect=[ValueError('No lettering space without covering a head'),None]), \
                    patch.object(p,'compose_instatoon_preview',return_value=folder/'preview.png'):
                p.generate_instatoon_card(folder,folder,plan,0,'style','{}',[])
            second=model.call_args_list[1]
            self.assertIn('Fresh staging',second.args[0]);self.assertNotIn('TARGETED EDIT',second.args[0])
            self.assertNotIn('"lettering":',second.args[0])
            self.assertFalse(any(f.name.startswith('art-0-repair-input') for f in second.args[1]))
            saved=json.loads((folder/'art-layout-error-0-0.json').read_text())
            self.assertIn('Reserved lettering zones',saved['fixes'])
            self.assertIn('"x": 42',saved['fixes'])
            self.assertTrue((folder/'accepted-art-0.json').exists())

    def test_planned_style_and_context_do_not_request_generated_balloon_boxes(self):
        display={'kind':'narration','integrated_art':True,'layout_mode':'planned-pen-v1','text':'설명'}
        style=p.instatoon_style_for_display('No text, captions, speech balloons, labels or watermark within art.',display)
        self.assertIn('NO lettering outlines',style)
        self.assertNotIn('REQUIRES ONE EMPTY',style)
        display['speech']=[{'speaker':'a','text':'대사'}]
        display['lettering']={'layers':[{'shape':'oval','tail_tip':[200,400],'fill':'#FFFFFF'}]}
        context=p.instatoon_image_context(display)
        self.assertNotIn('text',context['speech'][0])
        self.assertNotIn('text_box_hint',context['speech'][0])
        self.assertNotIn('lettering',context)
        self.assertIn('lettering',display)

    def test_bad_balloon_location_retries_same_art_before_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            display = {'kind':'dialogue', 'integrated_art':True, 'speech':[], 'acting':{'emotion':'surprise','intensity':2,'actor':'me'}}
            plan['presentation'] = {'panels':[display]}
            director = Mock()
            director.acting_prompt.return_value = 'JAGGED ACTING TEST'
            boxes = [{'x':100,'y':200,'width':300,'height':150}]
            director.refine_bubble_boxes.side_effect = [ValueError('rectangular object'), boxes]
            with patch.object(p, 'gemini', side_effect=[b'art', {'boxes':copy.deepcopy(boxes)}, {'boxes':copy.deepcopy(boxes)}, GOOD]) as model, \
                    patch.object(p, 'module', return_value=director), \
                    patch.object(p, 'validate_instatoon_text'), \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder/'preview.png'):
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', '{}', [])
            self.assertEqual(sum(bool(call.kwargs.get('image')) for call in model.call_args_list), 1)
            self.assertIn('JAGGED ACTING TEST', model.call_args_list[0].args[0])
            self.assertIn('rectangular object', model.call_args_list[2].args[0])
            self.assertEqual(model.call_args_list[1].args[1], model.call_args_list[2].args[1])
            self.assertEqual(director.refine_bubble_boxes.call_args_list[0].args[1],
                             [{'x':108,'y':270,'width':324,'height':202}])
            self.assertEqual(display['bubble_boxes'], boxes)
            self.assertTrue((folder/'accepted-art-0.json').exists())

    def test_accepted_card_resumes_without_calls_but_changed_art_is_rechecked(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            with patch.object(p, 'gemini', side_effect=[b'image', GOOD, b'repaired', GOOD]) as model, \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'):
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', '{}', [])
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', '{}', [])
                self.assertEqual(model.call_count, 2)
                (folder / 'art-0.png').write_bytes(b'changed')
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', '{}', [])
                self.assertEqual(model.call_count, 4)

    def test_review_schema_is_sent_to_api_without_leaking_into_plan_requests(self):
        result = {'candidates': [{'content': {'parts': [{'text': json.dumps(GOOD)}]}}]}
        with patch.dict(os.environ, {'CONTENT_TEXT_MODEL': 'test', 'GEMINI_API_KEY': 'test'}), \
                patch.object(p, 'request', return_value=result) as network:
            p.review_media('review')
            config = network.call_args.args[1]['generationConfig']
            self.assertEqual(config['responseJsonSchema'], p.REVIEW_SCHEMA)
            self.assertIsNone(p.JSON_SCHEMA_OVERRIDE.get())
            p.gemini('plan')
            self.assertNotIn('responseJsonSchema', network.call_args.args[1]['generationConfig'])

    def test_incomplete_review_retries_review_without_regenerating_image(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with patch.object(p, 'gemini', side_effect=[b'image', {'pass': True, 'scores': GOOD['scores']}, GOOD]) as model, \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'):
                p.generate_instatoon_card(folder, folder, copy.deepcopy(CASES[0]['plan']), 0, 'style', '{}', [])
            self.assertEqual(sum(c.kwargs.get('image', False) for c in model.call_args_list), 1)
            self.assertEqual(model.call_count, 3)
            self.assertEqual(model.call_args_list[1].args[1], model.call_args_list[2].args[1])

    def test_repeated_incomplete_review_stops_for_retry_without_assuming_pass(self):
        with patch.object(p, 'gemini', return_value={'pass': True}) as model:
            with self.assertRaises(p.TransientGenerationError):
                p.review_media('review')
            self.assertEqual(model.call_count, 2)

    def test_repair_edits_failed_target_then_reframes_with_repair_model(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            original = copy.deepcopy(plan)
            calls = []
            images = 0

            def model(prompt, files=(), image=False, **kwargs):
                nonlocal images
                if image:
                    images += 1
                    calls.append((prompt, [f.read_bytes() for f in files], p.IMAGE_MODEL_OVERRIDE.get()))
                    return f'image-{images}'.encode()
                return GOOD if images == 3 else BAD

            reframed = {**plan['panels'][0], 'visual': 'Over-shoulder view with one clear contact point.', 'framing': 'medium'}
            with patch.dict(os.environ, {'CONTENT_IMAGE_MODEL': 'fast', 'CONTENT_IMAGE_REPAIR_MODEL': 'pro'}), \
                    patch.object(p, 'gemini', side_effect=model), \
                    patch.object(p, 'reframe_instatoon_panel', return_value=reframed), \
                    patch.object(p, 'review_story_fidelity', return_value=FIDELITY), \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'):
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', json.dumps({'body': CASES[0]['body']}), [])
            self.assertEqual([c[2] for c in calls], ['fast', 'fast', 'pro'])
            self.assertEqual(calls[1][1][-1], b'image-1')
            self.assertNotIn(b'image-2', calls[2][1])
            self.assertEqual(plan['panels'][0]['visual'], reframed['visual'])
            self.assertEqual(plan['panels'][0]['text'], original['panels'][0]['text'])
            self.assertEqual(plan['panels'][1:], original['panels'][1:])
            self.assertIsNone(p.IMAGE_MODEL_OVERRIDE.get())

    def test_reframing_cannot_change_story_to_avoid_a_difficult_image(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            original = copy.deepcopy(plan)
            with patch.object(p, 'gemini', side_effect=[b'one', BAD, b'two', BAD]) as model, \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'), \
                    patch.object(p, 'reframe_instatoon_panel', return_value=plan['panels'][0]), \
                    patch.object(p, 'review_story_fidelity', return_value=INVENTED):
                with self.assertRaisesRegex(ValueError, 'changed the source story'):
                    p.generate_instatoon_card(folder, folder, plan, 0, 'style', json.dumps({'body': CASES[0]['body']}), [])
                self.assertEqual(model.call_count, 4)
            self.assertEqual(plan, original)

    def test_style_specific_repair_model_overrides_global_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            models = []
            references = []
            cast = folder / 'cast.png'
            cast.write_bytes(b'original cast')
            (folder / 'art-0.png').write_bytes(b'old camera')

            def model(prompt, files=(), image=False, **kwargs):
                if image:
                    models.append(p.IMAGE_MODEL_OVERRIDE.get())
                    references.append(list(files))
                    return b'image'
                return GOOD if len(models) == 3 else BAD

            with patch.dict(os.environ, {'CONTENT_IMAGE_MODEL': 'same-style', 'CONTENT_IMAGE_REPAIR_MODEL': 'different-style'}), \
                    patch.object(p, 'gemini', side_effect=model), \
                    patch.object(p, 'reframe_instatoon_panel', return_value=plan['panels'][1]), \
                    patch.object(p, 'review_story_fidelity', return_value=FIDELITY), \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'):
                p.generate_instatoon_card(folder, folder, plan, 1, 'style', json.dumps({'body': CASES[0]['body']}), [cast],
                                          repair_model='same-style')
            self.assertEqual(models, ['same-style'] * 3)
            self.assertEqual(references[0], [cast, folder / 'art-0.png'])
            self.assertEqual(references[2], [cast])
            self.assertIsNone(p.IMAGE_MODEL_OVERRIDE.get())

    def test_model_override_is_reset_on_network_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with patch.object(p, 'gemini', side_effect=p.TransientGenerationError), \
                    patch.dict(os.environ, {'CONTENT_IMAGE_MODEL': 'fast'}):
                with self.assertRaises(p.TransientGenerationError):
                    p.generate_instatoon_card(folder, folder, CASES[0]['plan'], 0, 'style', '{}', [])
            self.assertIsNone(p.IMAGE_MODEL_OVERRIDE.get())

    def test_targeted_reframe_requires_feedback_and_only_generates_once(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = copy.deepcopy(CASES[0]['plan'])
            with self.assertRaisesRegex(ValueError, 'reviewed failure'):
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', '{}', [], reframe_only=True)
            with patch.object(p, 'gemini', side_effect=[b'fresh staging', GOOD]) as model, \
                    patch.object(p, 'reframe_instatoon_panel', return_value=plan['panels'][0]) as reframe, \
                    patch.object(p, 'review_story_fidelity', return_value=FIDELITY), \
                    patch.object(p, 'compose_instatoon_preview', return_value=folder / 'preview.png'):
                p.generate_instatoon_card(folder, folder, plan, 0, 'style', json.dumps({'body': CASES[0]['body']}), [],
                                          initial_feedback=BAD, reframe_only=True)
            reframe.assert_called_once()
            self.assertEqual(sum(call.kwargs.get('image', False) for call in model.call_args_list), 1)

    def test_final_repair_is_bounded_and_requires_valid_card_numbers(self):
        self.assertEqual(p.final_repair_targets({'repair_kind': 'art', 'repair_panels': [4, 2]}, 5), [1, 3])
        for kind in ('story', 'none', None):
            self.assertEqual(p.final_repair_targets({'repair_kind': kind, 'repair_panels': [2]}, 5), [])
        for targets in (None, [], [0], [6], [True], [1, 1], [1, 2, 3], 'all'):
            with self.subTest(targets=targets):
                self.assertEqual(p.final_repair_targets({'repair_kind': 'art', 'repair_panels': targets}, 5), [])

    def test_cover_offsets_never_repair_the_wrong_story_card(self):
        plan = {'panels': [{}] * 5, 'presentation': {'version': 1}}
        self.assertEqual(p.instatoon_repair_targets({'repair_kind': 'art', 'repair_panels': [2, 6]}, plan), [0, 4])
        for targets in ([1], [1, 3], [7]):
            self.assertEqual(p.instatoon_repair_targets({'repair_kind': 'art', 'repair_panels': targets}, plan), [])

    def test_unknown_prop_or_state_is_rejected(self):
        plan = copy.deepcopy(CASES[0]['plan'])
        plan['story']['props'] = [{'id': 'box', 'design': 'Brown cardboard box, open only on the front-facing side'}]
        plan['panels'][0]['props'] = {'box': 'under desk, side opening faces camera'}
        p.validate_story(plan, CASES[0]['body'])
        plan['panels'][0]['props'] = {'other-box': 'open'}
        with self.assertRaises(ValueError):
            p.validate_story(plan, CASES[0]['body'])

    def test_final_review_repairs_only_target_then_rechecks_entire_episode(self):
        for still_bad, kind in ((False, 'art'), (True, 'art'), (False, 'typography')):
            with self.subTest(still_bad=still_bad, kind=kind), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                root = folder / 'repo'
                (root / 'bible/sheets').mkdir(parents=True)
                p.dump(root / 'bible/prompt-library.json', {'style_prefix': 'style', 'negative': 'no text'})
                (root / 'bible/sheets/core-cast-turnaround-v1.png').write_bytes(b'cast')
                plan = copy.deepcopy(CASES[0]['plan'])
                generated = []
                final_calls = []

                def model(prompt, files=(), image=False, **kwargs):
                    if image:
                        return b'cast'
                    if 'JSON {"caption"' in prompt:
                        return plan
                    if '최종 완성본 검수.' in prompt:
                        final_calls.append(list(files))
                        return {**BAD, 'repair_panels': [5], 'repair_kind': kind} if len(final_calls) == 1 or still_bad else GOOD
                    return GOOD

                def generate(folder, root, plan, index, *args, **kwargs):
                    generated.append(index)
                    (folder / f'art-{index}.png').write_bytes(f'candidate-{len(generated)}'.encode())

                def render(folder, root, job, plan, draft=False):
                    names = [f'card-{i}.jpg' for i in range(5)]
                    for i, name in enumerate(names):
                        (folder / name).write_bytes((folder / f'art-{i}.png').read_bytes())
                    return names, names

                with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), \
                        patch.object(p, 'preflight'), patch.object(p, 'validate_instatoon_text', return_value=[]), \
                        patch.object(p, 'review_story_fidelity', return_value=FIDELITY), \
                        patch.object(p, 'gemini', side_effect=model), patch.object(p, 'generate_instatoon_card', side_effect=generate), \
                        patch.object(p, 'compose_instatoon_cast', side_effect=lambda folder, pieces, characters: (folder / 'cast.png').write_bytes(b'cast-layout')), patch.object(p, 'render', side_effect=render):
                    job = {'kind': 'instatoon', 'topic': CASES[0]['topic'], 'body': CASES[0]['body']}
                    p.generate(folder, job)
                    if still_bad:
                        draft = json.loads((folder / 'draft.json').read_text())
                        self.assertEqual([f['index'] for f in draft['failed_panels']], [4])
                    else:
                        self.assertFalse((folder / 'draft.json').exists())
                self.assertEqual(generated, [0, 1, 2, 3, 4] + ([4] if kind == 'art' else []))
                self.assertEqual(len(final_calls), 2)
                self.assertEqual(len(final_calls[-1]), 6)
                self.assertEqual((folder / 'card-0.jpg').read_bytes(), b'candidate-1')
                self.assertEqual((folder / 'card-4.jpg').read_bytes(), b'candidate-6' if kind == 'art' else b'candidate-5')
                if kind == 'typography':
                    self.assertEqual(p.instatoon_layout(plan)['fonts']['title'], 'Pretendard-SemiBold')
                self.assertEqual((folder / 'manifest.json').exists(), not still_bad)


    def test_operator_revision_regenerates_only_named_panels_and_keeps_other_failures(self):
        for outcome in ('pass', 'still_failing'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory); root = folder / 'repo'
                (root / 'bible').mkdir(parents=True)
                p.dump(root / 'bible/prompt-library.json', {'style_prefix': 'style', 'negative': 'no text', 'repair_model': 'flash'})
                (root / 'ref.png').write_bytes(b'ref')
                plan = copy.deepcopy(CASES[0]['plan'])
                p.dump(folder / 'production-plan.json', plan)
                p.dump(folder / 'style-config.json', {'style': 'style', 'references': [{'file': str(root / 'ref.png'), 'sha256': p.hashlib.sha256(b'ref').hexdigest()}]})
                p.dump(folder / 'brief.json', {'brief': '{"body":"제보"}'})
                p.dump(folder / 'draft.json', {'failed_panels': [{'index': 1, 'blockers': ['b'], 'fixes': 'f'}, {'index': 3, 'blockers': ['c'], 'fixes': 'g'}]})
                p.dump(folder / 'revision.json', {'instruction': '3컷 표정 덜 놀라게', 'panels': [2, 3]})
                (folder / 'cast.png').write_bytes(b'cast')
                for i in range(5): (folder / f'art-{i}.png').write_bytes(b'old')
                generated = []
                def generate(folder, root, plan, index, style, brief, refs, initial_feedback=None, round_name='art', repair_model=None, reframe_only=False):
                    generated.append((index, round_name, initial_feedback['fixes'], repair_model, [r.name for r in refs]))
                    (folder / f'art-{index}.png').write_bytes(b'new')
                    if outcome == 'still_failing' and index == 3:
                        p.dump(folder / f'{round_name}-review-{index}-2.json', {**BAD, 'blockers': ['여전히 실패']})
                        raise ValueError('Visual review failed for scene 3 after repair and reframing')
                def render(folder, root, job, plan, draft=False):
                    names = [f'card-{i}.jpg' for i in range(5)]
                    for name in names: (folder / name).write_bytes(b'jpeg')
                    return names, names
                def model(prompt, files=(), image=False, **kwargs):
                    return GOOD
                with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), patch.object(p, 'preflight'), \
                        patch.object(p, 'gemini', side_effect=model), patch.object(p, 'generate_instatoon_card', side_effect=generate), \
                        patch.object(p, 'render', side_effect=render):
                    with self.assertRaises(ValueError): p.revise(folder, {'kind': 'instatoon', 'state': 'draft', 'topic': 't', 'body': 'b'})
                    p._revise(folder, {'kind': 'instatoon', 'state': 'revising', 'topic': 't', 'body': 'b'})
                self.assertEqual([g[:2] for g in generated], [(2, 'revision-0'), (3, 'revision-0')])
                self.assertEqual(generated[0][2], '3컷 표정 덜 놀라게'); self.assertEqual(generated[0][3], 'flash'); self.assertEqual(generated[0][4], ['ref.png'])
                self.assertTrue((folder / 'revision-0.json').exists())
                if outcome == 'pass':
                    # Panel 1 was never revised, so the episode stays a draft even though panels 2 and 3 passed.
                    draft = json.loads((folder / 'draft.json').read_text())
                    self.assertEqual([f['index'] for f in draft['failed_panels']], [1])
                    self.assertFalse((folder / 'manifest.json').exists())
                else:
                    draft = json.loads((folder / 'draft.json').read_text())
                    self.assertEqual([(f['index'], f['blockers']) for f in draft['failed_panels']], [(1, ['b']), (3, ['여전히 실패'])])

    def test_revision_of_a_clean_episode_reaches_a_new_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); root = folder / 'repo'
            (root / 'bible').mkdir(parents=True)
            p.dump(root / 'bible/prompt-library.json', {'style_prefix': 'style', 'negative': 'no text'})
            (root / 'ref.png').write_bytes(b'ref')
            p.dump(folder / 'production-plan.json', copy.deepcopy(CASES[0]['plan']))
            p.dump(folder / 'style-config.json', {'style': 'style', 'references': [{'file': str(root / 'ref.png'), 'sha256': p.hashlib.sha256(b'ref').hexdigest()}]})
            p.dump(folder / 'brief.json', {'brief': '{"body":"제보"}'})
            p.dump(folder / 'revision.json', {'instruction': '1컷 배경에 창문 추가', 'panels': [0]})
            (folder / 'cast.png').write_bytes(b'cast')
            def render(folder, root, job, plan, draft=False):
                names = [f'card-{i}.jpg' for i in range(5)]
                for name in names: (folder / name).write_bytes(b'jpeg')
                return names, names
            with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), patch.object(p, 'preflight'), \
                    patch.object(p, 'gemini', return_value=GOOD), patch.object(p, 'generate_instatoon_card'), patch.object(p, 'render', side_effect=render):
                p._revise(folder, {'kind': 'instatoon', 'state': 'revising', 'topic': 't', 'body': 'b'})
            manifest = json.loads((folder / 'manifest.json').read_text())
            self.assertEqual(manifest['hash'], p.digest(manifest))
            self.assertFalse((folder / 'draft.json').exists())
            p.dump(folder / 'revision.json', {'instruction': '', 'panels': [0]})
            with patch.dict(os.environ, {'INSTATOON_ROOT': str(root)}), patch.object(p, 'preflight'):
                with self.assertRaisesRegex(ValueError, 'Invalid revision'): p._revise(folder, {'kind': 'instatoon', 'state': 'revising', 'topic': 't', 'body': 'b'})


if __name__ == '__main__':
    unittest.main()
