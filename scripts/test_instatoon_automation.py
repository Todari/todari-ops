import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import content_pipeline as p
from test_instatoon_quality import CASES, GOOD, BAD


class AutomationStabilityTests(unittest.TestCase):
    def test_missing_candidates_and_parts_are_classified(self):
        for value in ({}, {'candidates': []}, {'candidates': [{'finishReason':'STOP'}]}):
            with self.subTest(value=value), self.assertRaises(p.TransientGenerationError):
                p.gemini_response_parts(value)
        for value in ({'promptFeedback': {'blockReason': 'SAFETY'}},
                      {'candidates': [{'finishReason': 'IMAGE_SAFETY'}]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                p.gemini_response_parts(value)

    def test_provider_block_is_recorded_without_raw_message_or_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = p.MODEL_CACHE.set(root / 'model-cache')
            try:
                response = {'promptFeedback': {'blockReason': 'OTHER', 'blockReasonMessage': 'private-response-text'},
                            'usageMetadata': {'promptTokenCount': 10}}
                with patch.dict(os.environ, CONTENT_TEXT_MODEL='test-model', GEMINI_API_KEY='secret-test-key'), \
                     patch.object(p, 'request', return_value=response) as request:
                    with self.assertRaisesRegex(ValueError, 'provider: OTHER'):
                        p.gemini('harmless story')
                self.assertEqual(request.call_count, 1)
                self.assertFalse(list((root / 'model-cache').glob('*.json')))
                record = next((root / 'api-usage').glob('*.json')).read_text()
                self.assertIn('OTHER', record)
                self.assertNotIn('private-response-text', record)
                self.assertNotIn('secret-test-key', record)
            finally:
                p.MODEL_CACHE.reset(token)

    def test_image_context_keeps_geometry_and_state_but_not_literal_dialogue(self):
        context = {'story': {'facts': ['대사 누출'], 'characters': [{'id':'a','design':'blue shirt'}]},
                   'sequence': [{'text':'대사 누출','props':{'cup':'handle remains absent'}}],
                   'display': {'caption':'설명 누출','speech':[{'speaker':'a','side':'left','delivery':'thought',
                               'text':'대사 누출','source_excerpt':'대사 누출'}]}}
        clean = p.instatoon_image_context(context)
        encoded = json.dumps(clean, ensure_ascii=False)
        self.assertNotIn('대사 누출', encoded)
        self.assertNotIn('설명 누출', encoded)
        self.assertIn('handle remains absent', encoded)
        self.assertEqual(clean['display']['speech'][0]['delivery'], 'thought')
        self.assertIn('text_box_hint', clean['display']['speech'][0])
        self.assertIn('text', context['sequence'][0])

    def test_targeted_repair_does_not_reimport_prior_scene_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            refs = [folder/'cast.png', folder/'style.png']
            for f in refs + [folder/'art-0.png']:
                f.write_bytes(b'image')
            plan = copy.deepcopy(CASES[-1]['plan'])
            with patch.object(p, 'gemini', return_value=b'image') as model, \
                 patch.object(p, 'compose_instatoon_preview', return_value=folder/'composed.png'), \
                 patch.object(p, 'review_media', side_effect=[BAD, GOOD]), \
                 patch.object(p, 'review_instatoon_style', return_value=GOOD):
                p.generate_instatoon_card(folder, folder, plan, 1, 'fine pen', '{}', refs)
            self.assertEqual(model.call_count, 2)
            first, repair = model.call_args_list
            self.assertIn(folder/'art-0.png', first.args[1])
            self.assertNotIn(folder/'art-0.png', repair.args[1])
            self.assertIn('TARGETED EDIT', repair.args[0])
            self.assertIn(BAD['fixes'], repair.args[0])
            self.assertTrue(repair.args[1][-1].name.endswith('repair-input-1.png'))

    def test_three_characters_reuse_originals_and_review_only_new_design(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            chars=[{'id':'a','design':'blue','reference_id':'ref-a'}, {'id':'b','design':'green'},
                   {'id':'c','design':'rust','reference_id':'ref-c'}]
            refs=[folder/'style.png',folder/'a.png',folder/'c.png']
            refs[1].write_bytes(b'original-a');refs[2].write_bytes(b'original-c')
            with patch.object(p,'generate_instatoon_cast_sheet',side_effect=lambda folder,*args: folder/'cast.png') as generate, \
                 patch.object(p,'compose_instatoon_cast',return_value=folder/'cast.png') as compose:
                p.generate_instatoon_cast(folder,'pen',refs,{'characters':chars})
            self.assertEqual(generate.call_count,1)
            self.assertEqual(generate.call_args.args[2],[refs[0]])
            self.assertEqual(generate.call_args.args[3]['characters'],[chars[1]])
            self.assertEqual((folder/'cast-character-0/original.png').read_bytes(),b'original-a')
            self.assertEqual((folder/'cast-character-2/original.png').read_bytes(),b'original-c')
            self.assertEqual(len(compose.call_args.args[1]),3)
            with patch.object(p,'generate_instatoon_cast_sheet',side_effect=ValueError('identity failed')), \
                 patch.object(p,'compose_instatoon_cast') as compose:
                with self.assertRaisesRegex(ValueError,'identity failed'):
                    p.generate_instatoon_cast(folder,'pen',refs,{'characters':chars})
                compose.assert_not_called()

    def test_repair_retains_caption_and_balloon_geometry(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);plan=copy.deepcopy(CASES[0]['plan'])
            display={'kind':'dialogue','integrated_art':True,'caption':'설명','speech':[{'text':'끝냈다!','speaker':'me'}]}
            plan['presentation']={'panels':[display]}
            director=Mock();director.refine_caption_box.return_value={'x':50,'y':25,'width':500,'height':100};director.refine_bubble_boxes.return_value=[{'x':100,'y':300,'width':400,'height':150}]
            with patch.object(p,'module',return_value=director),patch.object(p,'validate_instatoon_text'), \
                 patch.object(p,'compose_instatoon_preview',return_value=folder/'preview.png'), \
                 patch.object(p,'review_media',side_effect=[BAD,GOOD]), \
                 patch.object(p,'gemini',side_effect=[b'art',{'boxes':[]},b'repaired',{'boxes':[]}]) as model:
                p.generate_instatoon_card(folder,folder,plan,0,'pen','{}',[])
            repair=[x for x in model.call_args_list if x.kwargs.get('image')][1].args[0]
            for required in ('TARGETED EDIT','INTEGRATED MANGA PANEL CONTRACT','Reserve pure white negative space','REQUIRED EMPTY INTERIOR'):
                self.assertIn(required,repair)

    def test_narration_style_does_not_reject_its_own_required_box(self):
        style=p.instatoon_style_for_display('No text, captions, labels or watermark within art.',
                                            {'kind':'narration','integrated_art':True})
        self.assertIn('REQUIRES ONE EMPTY rectangular',style)
        self.assertIn('Do not delete it',style)
        self.assertNotIn('No text, captions',style)
        self.assertEqual(p.instatoon_style_for_display('original',{'kind':'narration'}),'original')

    def test_one_malformed_response_recovers_locally_and_records_both_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);token=p.MODEL_CACHE.set(folder/'model-cache')
            bad={'candidates':[{'content':{'parts':[{'text':'{broken'}]}}]}
            good={'candidates':[{'content':{'parts':[{'text':'{"pass":true}'}]}}]}
            try:
                with patch.dict(os.environ, GEMINI_API_KEY='test',CONTENT_TEXT_MODEL='test-model'), \
                     patch.object(p,'request',side_effect=[bad,good]) as request:
                    self.assertEqual(p.gemini('review'),{'pass':True})
                    self.assertEqual(p.gemini('review'),{'pass':True})
                    self.assertEqual(request.call_count,2)
                records=[json.loads(f.read_text()) for f in (folder/'api-usage').glob('*.json')]
                self.assertEqual(len(records),2)
                self.assertEqual([r['decode_error'] for r in records if 'decode_error' in r],['invalid-json-output'])
            finally:p.MODEL_CACHE.reset(token)

    def test_image_decoder_ignores_intermediate_thought_image(self):
        import base64
        parts=[{'thought':True,'inlineData':{'data':base64.b64encode(b'draft').decode()}},
               {'inlineData':{'data':base64.b64encode(b'final').decode()}}]
        self.assertEqual(p.decode_gemini_response({'candidates':[{'content':{'parts':parts}}]},image=True),b'final')
        with self.assertRaisesRegex(p.TransientGenerationError,'missing-final-image'):
            p.decode_gemini_response({'candidates':[{'content':{'parts':parts[:1]}}]},image=True)

    def test_reference_mime_uses_bytes_even_when_filename_is_png(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'reference.png';path.write_bytes(b'\xff\xd8\xffJPEG')
            result={'candidates':[{'content':{'parts':[{'text':'{"pass":true}'}]}}]}
            with patch.dict(os.environ,GEMINI_API_KEY='test',CONTENT_TEXT_MODEL='test-model'),patch.object(p,'request',return_value=result) as request:
                p.gemini('review',[path])
            part=request.call_args.args[1]['contents'][0]['parts'][1]['inline_data']
            self.assertEqual(part['mime_type'],'image/jpeg')

    def test_wording_correction_preserves_source_and_rejects_structural_changes(self):
        original=copy.deepcopy(CASES[0]['plan']);before=copy.deepcopy(original)
        with patch.object(p,'gemini',return_value={'updates':[{'path':'caption','value':'원문 그대로'}, {'path':'panels.0.beat','value':'관찰된 행동'}]}):
            fixed=p.correct_instatoon_source_claims(original,'source',{'unsupported_claims':['adjective']})
        self.assertEqual(original,before);self.assertEqual(fixed['story'],original['story'])
        self.assertEqual(fixed['panels'][1:],original['panels'][1:])
        self.assertEqual(fixed['panels'][0]['beat'],'관찰된 행동')
        for path in ['story.facts','panels.0.characters','panels.999.text','panels.-1.text']:
            with patch.object(p,'gemini',return_value={'updates':[{'path':path,'value':'change'}]}),self.assertRaises(ValueError):
                p.correct_instatoon_source_claims(original,'source',{})

    def test_real_style_prefix_removes_narration_prohibition(self):
        prefix='No text, captions, speech balloons, labels or watermark within art.'
        style=p.instatoon_style_for_display(prefix,{'kind':'narration','integrated_art':True})
        self.assertNotIn('No text, captions',style)
        self.assertIn('REQUIRES ONE EMPTY rectangular',style)

    def test_image_request_contains_only_the_current_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);plan=copy.deepcopy(CASES[0]['plan'])
            plan['panels'][1]['visual']='FUTURE_ONLY_ACTION'
            with patch.object(p,'gemini',return_value=b'image') as model, \
                 patch.object(p,'compose_instatoon_preview',return_value=folder/'preview.png'), \
                 patch.object(p,'review_media',return_value=GOOD):
                p.generate_instatoon_card(folder,folder,plan,0,'fine pen','{}',[])
            prompt=model.call_args.args[0]
            self.assertNotIn('FUTURE_ONLY_ACTION',prompt)
            self.assertNotIn('"sequence"',prompt)
            self.assertIn('"current_panel": {',prompt)

    def test_dialogue_caption_is_located_inside_its_own_pen_rectangle(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);plan=copy.deepcopy(CASES[0]['plan'])
            display={'kind':'dialogue','integrated_art':True,'integrated_caption':True,
                     'caption':'컵을 건넸다.','speech':[{'speaker':'a','side':'left','text':'고마워.'}]}
            plan['presentation']={'panels':[display]+[{} for _ in plan['panels'][1:]]}
            director=Mock();director.refine_bubble_boxes.side_effect=lambda path,boxes,**kwargs:boxes
            response={'boxes':[{'x':100,'y':400,'width':350,'height':180}],
                      'caption_box':{'x':100,'y':50,'width':650,'height':160}}
            with patch.object(p,'module',return_value=director),patch.object(p,'validate_instatoon_text'), \
                 patch.object(p,'compose_instatoon_preview',return_value=folder/'preview.png'), \
                 patch.object(p,'review_media',return_value=GOOD), \
                 patch.object(p,'gemini',side_effect=[b'image',response]) as model:
                p.generate_instatoon_card(folder,folder,plan,0,'fine pen','{}',[])
            self.assertEqual(display['caption_box'],{'x':108,'y':68,'width':702,'height':216})
            director.refine_caption_box.assert_not_called()
            self.assertEqual(director.refine_bubble_boxes.call_args.kwargs,{'rectangular':True})
            prompt=model.call_args_list[0].args[0]
            self.assertIn('additional EMPTY thin black PEN rectangular',prompt)
            self.assertNotIn('Reserve pure white negative space',prompt)
