import importlib.util
import io
import json
import pathlib
import unittest
import zipfile

path = pathlib.Path(__file__).parents[2] / 'scripts/e2e-staging/scrub-evidence.py'
spec = importlib.util.spec_from_file_location('scrub', path)
scrub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scrub)

class ScrubTest(unittest.TestCase):
    def test_share_credentials_are_removed_from_urls_and_embedded_bodies(self):
        data = {'content': {'text': json.dumps({'token': 'grant-secret'})}, 'href': 'https://example.test/share#token=grant-secret', 'share_token': 'grant-secret', 'cookies': [{'name': '__Host-tour_share_session', 'value': 'grant-secret'}]}
        self.assertNotIn(b'grant-secret', scrub.scrub_bytes('data.trace', json.dumps(data).encode()))

    def test_headers_and_nested_response_credentials_are_removed(self):
        record = {'headers': [{'name': 'Cookie', 'value': 'session-secret'}, {'name': 'Set-Cookie', 'value': 'session-secret'}], 'response': {'csrf_token': 'csrf-secret'}, 'text': 'Bearer bearer-secret', 'cookies': [{'name': '__Host-dealroom_session', 'value': 'cookie-secret'}], 'content': {'text': json.dumps({'csrf_token': 'embedded-secret'})}, 'csrfheader': {'name': 'x-carr-csrf', 'value': 'csrfheader-secret'}}
        cleaned = scrub.scrub_bytes('data.trace', json.dumps(record).encode())
        for value in [b'session-secret', b'csrf-secret', b'bearer-secret', b'cookie-secret', b'embedded-secret', b'csrfheader-secret']:
            self.assertNotIn(value, cleaned)

    def test_trace_archive_remains_readable_and_pixels_remain_intact(self):
        source = io.BytesIO()
        with zipfile.ZipFile(source, 'w') as archive:
            archive.writestr('trace.network', json.dumps({'authorization': 'Bearer hidden'}))
            archive.writestr('screen.png', b'png-pixels')
        cleaned = scrub.scrub_bytes('trace.zip', source.getvalue())
        with zipfile.ZipFile(io.BytesIO(cleaned)) as archive:
            self.assertNotIn(b'hidden', archive.read('trace.network'))
            self.assertEqual(archive.read('screen.png'), b'png-pixels')

if __name__ == '__main__':
    unittest.main()
