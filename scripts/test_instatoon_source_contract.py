"""Regression for the 2026-09-21 live emergency-snack generation failure."""
import copy
import unittest
from unittest.mock import patch

import content_pipeline as p
from test_instatoon_quality import CASES, GOOD


class SourceContractTests(unittest.TestCase):
    def scenario(self):
        case = copy.deepcopy(CASES[0])
        case['body'] += '\n오후 사무실. 주인공이 배를 잡는다.\n주인공: “집중력이 떨어진다…”'
        plan = case['plan']
        panel = plan['panels'][0]
        fact = len(plan['story']['facts'])
        plan['story']['facts'].append('오후 사무실. 주인공이 배를 잡는다.')
        panel['source_facts'].append(fact)
        panel['text'] = '주인공: “집중력이\n떨어진다…”'
        return case, panel, fact

    def test_source_dialogue_missing_from_linked_facts_is_rejected_early(self):
        case, _, _ = self.scenario()
        with self.assertRaisesRegex(ValueError, 'dialogue.*source_facts'):
            p.validate_story(case['plan'], case['body'])

    def test_unrelated_fact_does_not_ground_dialogue(self):
        case, _, _ = self.scenario()
        case['plan']['story']['facts'].append('집중력이 떨어진다…')
        case['plan']['panels'][1]['source_facts'].append(len(case['plan']['story']['facts']) - 1)
        with self.assertRaisesRegex(ValueError, 'dialogue.*source_facts'):
            p.validate_story(case['plan'], case['body'])

    def test_exact_fact_including_dialogue_accepts_display_line_break(self):
        case, _, fact = self.scenario()
        case['plan']['story']['facts'][fact] = '오후 사무실. 주인공이 배를 잡는다.\n주인공: “집중력이 떨어진다…”'
        p.validate_story(case['plan'], case['body'])

    def test_separate_linked_dialogue_fact_is_accepted(self):
        case, panel, _ = self.scenario()
        panel['source_facts'].append(len(case['plan']['story']['facts']))
        case['plan']['story']['facts'].append('집중력이 떨어진다…')
        p.validate_story(case['plan'], case['body'])

    def test_straight_quotes_also_require_linked_evidence(self):
        case, panel, _ = self.scenario()
        panel['text'] = '주인공: "집중력이\n떨어진다…"'
        with self.assertRaisesRegex(ValueError, 'dialogue.*source_facts'):
            p.validate_story(case['plan'], case['body'])

    def test_cover_cannot_be_inserted_as_a_body_panel(self):
        for beat in ('표지: 과자를 지키는 주인공', '커버: 과자를 지키는 주인공', 'Cover: guarding snacks'):
            case = copy.deepcopy(CASES[0])
            case['plan']['panels'][0]['beat'] = beat
            with self.subTest(beat=beat), self.assertRaisesRegex(ValueError, 'cover.*separate'):
                p.validate_story(case['plan'], case['body'])

    def test_cover_as_story_object_is_not_rejected(self):
        case = copy.deepcopy(CASES[0])
        case['plan']['panels'][0]['beat'] = '표지판을 읽는 주인공'
        p.validate_story(case['plan'], case['body'])

    def test_script_reviewer_receives_body_only_stage_contract(self):
        with patch.object(p, 'gemini', return_value=GOOD) as model:
            p.review_instatoon_script({'panels': []}, '표지 1장＋본문 6컷')
        prompt = model.call_args.args[0]
        self.assertIn(p.INSTATOON_SCRIPT_STAGE, prompt)
        self.assertIn('표지가 없다는 이유로 탈락', prompt)
        self.assertIn('대사', prompt)


if __name__ == '__main__':
    unittest.main()
