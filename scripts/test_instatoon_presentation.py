import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

import content_pipeline as p
from test_instatoon_quality import FIDELITY, INVENTED, GOOD


class PresentationStageTests(unittest.TestCase):
    def test_planned_mode_measures_before_review_and_writes_guide_after_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);(folder/'bible').mkdir()
            p.dump(folder/'bible/prompt-library.json',{'lettering':'planned-pen-v1'})
            plan={'panels':[{'text':'이야기'}]}
            proposal={'version':1,'panels':[{'kind':'narration','text':'이야기'}]}
            director=Mock(RULES='rules',EDITORIAL_RULES='editorial');director.visible_plan.return_value=plan
            with patch.object(p,'module',return_value=director), \
                    patch.object(p,'gemini',return_value=proposal), \
                    patch.object(p,'validate_instatoon_text',return_value=[]), \
                    patch.object(p,'review_story_fidelity',return_value=FIDELITY), \
                    patch.object(p,'review_media',return_value=GOOD):
                p.prepare_instatoon_presentation(folder,folder,plan,'이야기')
            director.prepare_lettering.assert_called_once_with(proposal['panels'][0],0)
            director.render_lettering_guide.assert_called_once_with(proposal['panels'][0],0,folder/'layout-guide-0.png')
            director.refine_bubble_boxes.assert_not_called()

    def test_dedicated_cover_is_reviewed_and_bounded(self):
        for good in (True,False):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as directory:
                folder=Path(directory);cast=folder/'cast.png';cast.write_bytes(b'cast')
                plan={'story':{},'panels':[{'characters':['me']}], 'presentation':{'cover':{'source_panel':0,'dedicated_art':True}}}
                director=Mock();director.layout.return_value={'cover':{'base':'cover-art.png'}}
                renderer=Mock();renderer.render_card.return_value=folder/'cover-review.png'
                review=GOOD if good else {**GOOD,'pass':False,'blockers':['empty balloon']}
                with patch.object(p,'module',side_effect=[director,renderer]), patch.object(p,'gemini',return_value=b'cover') as model, patch.object(p,'review_media',return_value=review):
                    if good:p.generate_instatoon_cover(folder,folder,plan,'style',[cast])
                    else:
                        with self.assertRaisesRegex(ValueError,'Dedicated cover'):p.generate_instatoon_cover(folder,folder,plan,'style',[cast])
                self.assertEqual(model.call_count,1 if good else 2)
                self.assertEqual((folder/'accepted-cover.json').exists(),good)
                self.assertIn('NO speech balloons',model.call_args_list[0].args[0])

    def test_romantic_pen_marks_are_allowed_only_in_grounded_stronger_beat(self):
        style='flat colors, no blush, no gradients'
        self.assertEqual(p.instatoon_style_for_display(style,{'acting':{'emotion':'love','intensity':1}}),style)
        self.assertEqual(p.instatoon_style_for_display(style,{'acting':{'emotion':'neutral','intensity':3}}),style)
        changed=p.instatoon_style_for_display(style,{'acting':{'emotion':'love','intensity':2}})
        self.assertNotIn('no blush,',changed)
        self.assertIn('no gradients',changed)
        self.assertIn('short pink pen',changed)

    def test_source_audit_must_pass_before_presentation_is_committed(self):
        for good in (False, True):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                plan = {'panels': [{'text': '기존 설명'}]}
                proposal = {'version': 1, 'cover': {'title_lines': ['제목', '두 줄']}, 'panels': []}
                director = SimpleNamespace(RULES='presentation rules', EDITORIAL_RULES='editorial rules', validate=lambda *args: None,
                                           visible_plan=lambda candidate: copy.deepcopy(candidate))
                with patch.object(p, 'module', return_value=director), \
                        patch.object(p, 'gemini', return_value=proposal) as model, \
                        patch.object(p, 'validate_instatoon_text', return_value=[]), \
                        patch.object(p, 'review_media', return_value=GOOD), \
                        patch.object(p, 'review_story_fidelity', return_value=FIDELITY if good else INVENTED):
                    if good:
                        p.prepare_instatoon_presentation(folder, folder, plan, '원문')
                        self.assertEqual(plan['presentation'], proposal)
                        self.assertEqual(model.call_count, 1)
                        self.assertEqual(json.loads((folder / 'presentation.json').read_text()), proposal)
                    else:
                        with self.assertRaisesRegex(ValueError, 'source or typography'):
                            p.prepare_instatoon_presentation(folder, folder, plan, '원문')
                        self.assertNotIn('presentation', plan)
                        self.assertFalse((folder / 'presentation.json').exists())
                        self.assertEqual(model.call_count, 3)

    def test_spoiler_title_is_not_committed_when_editorial_rejects_it(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            plan = {'panels': [{'text': '기존 설명'}]}
            director = SimpleNamespace(RULES='rules', EDITORIAL_RULES='editorial',
                                       validate=lambda *args: None, visible_plan=lambda x: x)
            rejected = {**GOOD, 'pass': False, 'blockers': ['제목이 결말을 공개함']}
            with patch.object(p, 'module', return_value=director), \
                    patch.object(p, 'gemini', return_value={'version': 1, 'panels': []}) as model, \
                    patch.object(p, 'validate_instatoon_text', return_value=[]), \
                    patch.object(p, 'review_story_fidelity', return_value=FIDELITY), \
                    patch.object(p, 'review_media', return_value=rejected):
                with self.assertRaises(ValueError):
                    p.prepare_instatoon_presentation(folder, folder, plan, '원문')
            self.assertEqual(model.call_count, 3)
            self.assertNotIn('presentation', plan)
            self.assertFalse((folder / 'presentation.json').exists())
            self.assertEqual(len(list(folder.glob('presentation-editorial-*.json'))), 3)


if __name__ == '__main__':
    unittest.main()
