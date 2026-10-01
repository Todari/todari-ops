"""Fetch explicitly supplied public institutional pages for science claim review."""
import copy
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BYTES = 2_000_000
MAX_TEXT = 12_000


def allowed_source(url):
    try:
        parts = urlsplit(url)
        host = (parts.hostname or '').lower()
        return (parts.scheme == 'https' and not parts.username and not parts.password
                and parts.port in (None, 443)
                and (host.endswith(('.gov', '.edu'))
                     or any(host == name or host.endswith('.' + name)
                            for name in ('aps.org', 'acs.org', 'openstax.org'))))
    except ValueError:
        return False


class PublicRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_source(newurl):
            raise ValueError('Source redirected outside allowed public institutions')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PageText(HTMLParser):
    SKIP = {'script', 'style', 'nav', 'header', 'footer', 'svg', 'noscript', 'form'}
    BREAK = {'p', 'li', 'h1', 'h2', 'h3', 'h4', 'div', 'section', 'article', 'br', 'tr'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip.append(tag)
        if not self.skip and tag in self.BREAK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip[-1]:
                self.skip.pop()
            return
        if tag in self.BREAK:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self):
        lines = [re.sub(r'\s+', ' ', line).strip() for line in ''.join(self.parts).splitlines()]
        return '\n'.join(line for line in lines if line)


def fetch_page(url):
    if not allowed_source(url):
        raise ValueError('Expected an approved public institutional HTTPS URL')
    request = Request(url, headers={'User-Agent': 'WhynyamanScienceSourceReview/1.0', 'Accept': 'text/html'})
    with build_opener(PublicRedirects()).open(request, timeout=15) as response:
        if not allowed_source(response.url):
            raise ValueError('Unexpected source URL')
        if response.headers.get_content_type() not in ('text/html', 'application/xhtml+xml'):
            raise ValueError('Source must be an HTML article')
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError('Source page exceeds review size limit')
        charset = response.headers.get_content_charset() or 'utf-8'
        parser = PageText()
        parser.feed(body.decode(charset, errors='replace'))
        full_text = parser.text()
        if len(full_text) < 200:
            raise ValueError('Source article text is unavailable')
        return {'url': response.url, 'requested_url': url, 'text': full_text[:MAX_TEXT],
                'truncated': len(full_text) > MAX_TEXT, 'page_sha256': hashlib.sha256(body).hexdigest()}


def augment_primary_sources(evidence, body, folder):
    """Keep grounded spans and add separately identified, directly fetched text."""
    result = copy.deepcopy(evidence)
    passages = result.setdefault('supported_passages', [])
    cache = Path(folder) / 'primary-sources'
    cache.mkdir(parents=True, exist_ok=True)
    urls = list(dict.fromkeys(re.findall(r'https://[^\s<>"\)\]]+', body)))
    errors = []
    for url in [u.rstrip('.,;') for u in urls if allowed_source(u.rstrip('.,;'))][:3]:
        path = cache / (hashlib.sha256(url.encode()).hexdigest() + '.json')
        try:
            saved = json.loads(path.read_text()) if path.exists() else fetch_page(url)
            if saved.get('requested_url') != url or not allowed_source(saved.get('url', '')) or not saved.get('text'):
                raise ValueError('Invalid cached source')
            if not path.exists():
                path.write_text(json.dumps(saved, ensure_ascii=False, indent=2))
            # Preserve contiguous paragraphs; the writer must select actual supporting text.
            blocks, current = [], ''
            for line in saved['text'].splitlines():
                if current and len(current) + len(line) > 3000:
                    blocks.append(current)
                    current = ''
                current += ('\n' if current else '') + line
            if current:
                blocks.append(current)
            for block in blocks:
                passages.append({'id': len(passages), 'text': block,
                                 'source_type': 'retrieved_primary_page',
                                 'page_sha256': saved['page_sha256'],
                                 'sources': [{'title': urlsplit(saved['url']).hostname, 'url': saved['url']}]})
        except Exception as exc:
            # A failed fetch is never represented as evidence. Grounded evidence remains.
            errors.append({'url': url, 'error_type': type(exc).__name__})
    (cache / 'fetch-errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2))
    return result
