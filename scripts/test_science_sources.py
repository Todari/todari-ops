import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from science_sources import PageText, allowed_source, augment_primary_sources


class PrimarySourcesTest(unittest.TestCase):
    def test_public_institution_url_boundary(self):
        self.assertTrue(allowed_source('https://www.usgs.gov/science'))
        self.assertTrue(allowed_source('https://openstax.org/books/biology'))
        for url in ('http://www.usgs.gov/a', 'https://127.0.0.1/a', 'https://usgs.gov.evil.test/a',
                    'https://user:pass@www.usgs.gov/a', 'https://www.usgs.gov:8080/a'):
            self.assertFalse(allowed_source(url))

    def test_article_text_excludes_page_scripts_and_navigation(self):
        p = PageText()
        p.feed('<nav>menu</nav><main><h1>Water</h1><p>Air has <b>water vapor</b>.</p>'
               '<script>hidden text</script><p>That becomes liquid.</p></main><footer>menu</footer>')
        self.assertEqual(p.text(), 'Water\nAir has water vapor.\nThat becomes liquid.')

    def test_direct_source_cache_and_grounded_span_preserved(self):
        url = 'https://www.usgs.gov/science'
        evidence = {'supported_passages': [{'id': 0, 'text': 'Original grounded span'}]}
        page = {'requested_url': url, 'url': url, 'text': 'Retrieved article paragraph.', 'page_sha256': 'abc'}
        with tempfile.TemporaryDirectory() as folder, patch('science_sources.fetch_page', return_value=page) as fetch:
            first = augment_primary_sources(evidence, 'Read ' + url, Path(folder))
            second = augment_primary_sources(evidence, 'Read ' + url, Path(folder))
            fetch.assert_called_once_with(url)
        self.assertEqual(first, second)
        self.assertEqual(first['supported_passages'][0], evidence['supported_passages'][0])
        self.assertEqual(first['supported_passages'][1]['source_type'], 'retrieved_primary_page')
        self.assertEqual(len(evidence['supported_passages']), 1)

    def test_failed_fetch_never_becomes_support(self):
        with tempfile.TemporaryDirectory() as folder, patch('science_sources.fetch_page', side_effect=TimeoutError):
            result = augment_primary_sources({'supported_passages': []}, 'https://www.aps.org/a', Path(folder))
            self.assertEqual(result['supported_passages'], [])
            self.assertIn('TimeoutError', (Path(folder) / 'primary-sources/fetch-errors.json').read_text())


if __name__ == '__main__':
    unittest.main()
