import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import content_pipeline as p


class CastLibraryTests(unittest.TestCase):
    def test_approved_originals_are_copied_without_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);a=root/'a.png';b=root/'b.png'
            a.write_bytes(b'original a');b.write_bytes(b'original b')
            story={'characters':[{'id':'a','reference_id':'a'},{'id':'b','reference_id':'b'}]}
            with patch.object(p,'generate_instatoon_cast_sheet') as generator,patch.object(p,'compose_instatoon_cast') as compose:
                p.generate_instatoon_cast(root,'style',[root/'style.png',a,b],story)
            generator.assert_not_called()
            self.assertEqual([x.read_bytes() for x in compose.call_args.args[1]],[b'original a',b'original b'])
            self.assertEqual((root/'cast-character-0/original.png').read_bytes(),a.read_bytes())

    def test_only_unregistered_character_is_generated_in_mixed_cast(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);a=root/'a.png';a.write_bytes(b'original a')
            story={'characters':[{'id':'new','design':'new person'},{'id':'a','reference_id':'a'}]}
            with patch.object(p,'generate_instatoon_cast_sheet',return_value=root/'new.png') as generator,patch.object(p,'compose_instatoon_cast') as compose:
                p.generate_instatoon_cast(root,'style',[root/'style.png',a],story)
            self.assertEqual(generator.call_count,1)
            self.assertEqual(generator.call_args.args[3],{'characters':[story['characters'][0]]})
            self.assertEqual(compose.call_args.args[1][1].read_bytes(),b'original a')

    def fixture(self, root):
        (root / 'person.png').write_bytes(b'checked portrait')
        entry = {'id': 'person', 'design': 'Fixed face, haircut and blue shirt', 'image': 'person.png',
                 'ready': True, 'sha256': hashlib.sha256(b'checked portrait').hexdigest()}
        p.dump(root / 'cast.json', {'characters': [entry, {'id': 'draft', 'ready': False}]})
        return entry

    def test_only_checked_unchanged_images_are_offered_to_planning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            self.assertEqual(list(p.load_cast_library(root, {'cast_library': 'cast.json'})), ['person'])
            (root / 'person.png').write_bytes(b'regenerated but unchecked')
            with self.assertRaisesRegex(ValueError, 'changed cast'):
                p.load_cast_library(root, {'cast_library': 'cast.json'})

    def test_reference_binding_preserves_identity_and_does_not_force_new_cast(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.fixture(root)
            catalog = {'person': entry}
            person = {'id': 'narrator', 'reference_id': 'person', 'design': entry['design']}
            plan = {'story': {'characters': [person, {'id': 'child', 'design': 'New child design'}]}}
            self.assertEqual(p.bind_cast_references(root, catalog, plan), [root / 'person.png'])
            for change in ('unknown', 'design', 'duplicate'):
                candidate = copy.deepcopy(plan)
                if change == 'unknown':
                    candidate['story']['characters'][0]['reference_id'] = 'missing'
                elif change == 'design':
                    candidate['story']['characters'][0]['design'] = 'Different face and clothes'
                else:
                    candidate['story']['characters'].append({**person, 'id': 'other'})
                with self.subTest(change=change), self.assertRaises(ValueError):
                    p.bind_cast_references(root, catalog, candidate)

    def test_old_library_without_roster_remains_supported(self):
        self.assertEqual(p.load_cast_library(Path('/not-used'), {}), {})


if __name__ == '__main__':
    unittest.main()
