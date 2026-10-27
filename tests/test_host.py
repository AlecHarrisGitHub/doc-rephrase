import inspect
import io
import json
import os
import struct
import subprocess
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'helper'))
import doc_rephrase_host as host  # noqa: E402

CONFIG = {'op_ref': 'op://Private/Anthropic API Key/credential', 'model': 'claude-opus-5-5'}
REQUEST = {'type': 'rewrite', 'context': 'TAB: Draft\nBefore awkward words after.', 'selected_tab': 'Draft',
           'tone': 'concise', 'guidance': 'Keep my voice.',
           'passages': [{'selected_text': 'awkward words', 'before': 'Before ', 'after': ' after.'}]}


def response(text, stop_reason='end_turn'):
    return types.SimpleNamespace(stop_reason=stop_reason, model='claude-opus-5-5',
                                 content=[types.SimpleNamespace(type='thinking'), types.SimpleNamespace(type='text', text=text)])


class HostTests(unittest.TestCase):
    def test_ping_reports_configuration_without_touching_1password(self):
        reply = host.handle({'type': 'ping'}, CONFIG, read_key=lambda ref: self.fail('read key on ping'))
        self.assertTrue(reply['ok'])
        self.assertTrue(reply['configured'])
        self.assertFalse(reply['key_ready'])
        self.assertTrue(host.handle({'type': 'ping'}, CONFIG, key_ready=lambda ref: True)['key_ready'])
        self.assertEqual(reply['model'], 'claude-opus-5-5')

    def test_rewrite_reads_key_per_request_and_returns_paragraphs(self):
        seen = {}
        def call(key, params):
            seen['key'], seen['params'] = key, params
            return response(json.dumps({'paragraphs': ['clear words'], 'note': 'Clearer.'}))
        reply = host.handle(REQUEST, CONFIG, read_key=lambda ref: 'sk-ant-test-' + ref[-10:], call=call)
        self.assertEqual(reply['paragraphs'], ['clear words'])
        self.assertEqual(seen['key'], 'sk-ant-test-credential')
        self.assertNotIn('sk-ant-test', json.dumps(reply))

    def test_request_shape_caches_document_and_uses_structured_output(self):
        params = host.build_params('claude-opus-5-5', host.validate_request(REQUEST))
        self.assertEqual(params['model'], 'claude-opus-5-5')
        self.assertEqual(params['fallbacks'], 'default')
        self.assertEqual(params['betas'], ['server-side-fallback-2026-07-01'])
        self.assertEqual(params['output_config']['format']['type'], 'json_schema')
        first, second = params['messages'][0]['content']
        self.assertEqual(first['cache_control'], {'type': 'ephemeral'})
        self.assertIn('Before awkward words after.', first['text'])
        self.assertEqual(json.loads(second['text'])['selected_passages'][0]['selected_text'], 'awkward words')
        self.assertIn(host.TONES['concise'], params['system'])

    def test_request_parameters_match_the_installed_sdk(self):
        import anthropic
        accepted = inspect.signature(anthropic.Anthropic(api_key='x').beta.messages.stream).parameters
        params = host.build_params('claude-opus-5-5', host.validate_request(REQUEST))
        self.assertEqual([k for k in params if k not in accepted], [])

    def test_effort_sets_output_config_and_room_to_think(self):
        low = host.build_params('claude-opus-5-5', host.validate_request(REQUEST))
        high = host.build_params('claude-opus-5-5', host.validate_request(dict(REQUEST, effort='max')))
        bogus = host.build_params('claude-opus-5-5', host.validate_request(dict(REQUEST, effort='ultra')))
        self.assertEqual((low['output_config']['effort'], high['output_config']['effort'], bogus['output_config']['effort']), ('low', 'max', 'low'))
        self.assertGreater(high['max_tokens'], low['max_tokens'])

    def test_rejects_unknown_and_oversized_requests(self):
        for message in [{'type': 'shell'}, dict(REQUEST, context='x' * 200001),
                        dict(REQUEST, passages=[{'selected_text': 'x' * 10001, 'before': '', 'after': ''}]),
                        dict(REQUEST, passages=[]), dict(REQUEST, guidance='g' * 2001)]:
            with self.assertRaises(host.UserError):
                host.handle(message, CONFIG, read_key=lambda ref: self.fail('read key'), call=lambda k, p: self.fail('called'))

    def test_parse_handles_refusal_truncation_and_wrong_counts(self):
        for r in [response('', 'refusal'), response('{"paragraphs": ["a"', 'max_tokens'), response('not json'),
                  response(json.dumps({'paragraphs': ['a', 'b'], 'note': ''})),
                  response(json.dumps({'paragraphs': ['two\nlines'], 'note': ''}))]:
            with self.assertRaises(host.UserError):
                host.parse_response(r, 1)

    def test_reads_key_with_op_and_never_echoes_it_in_errors(self):
        calls = []
        def ok(args, **kw):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout='sk-ant-secret\n', stderr='')
        host.find_op = lambda: '/opt/homebrew/bin/op'
        self.assertEqual(host.read_api_key(CONFIG['op_ref'], run=ok), 'sk-ant-secret')
        self.assertEqual(calls[0], ['/opt/homebrew/bin/op', 'read', '--no-newline', CONFIG['op_ref']])
        def locked(args, **kw):
            return subprocess.CompletedProcess(args, 1, stdout='', stderr='[ERROR] account is not signed in')
        with self.assertRaisesRegex(host.UserError, 'not signed in'):
            host.read_api_key(CONFIG['op_ref'], run=locked)
        with self.assertRaisesRegex(host.UserError, 'op-ref'):
            host.read_api_key('', run=ok)

    def test_key_is_cached_in_memory_until_ttl_or_rejection(self):
        reads, now = [], [0.0]
        cache = host.KeyCache(lambda ref: reads.append(ref) or 'sk-ant-%d' % len(reads), clock=lambda: now[0])
        self.assertEqual(cache.get('op://a'), 'sk-ant-1')
        self.assertEqual(cache.get('op://a'), 'sk-ant-1')
        now[0] = host.KEY_TTL_SECONDS + 1
        self.assertEqual(cache.get('op://a'), 'sk-ant-2')
        self.assertTrue(cache.ready('op://a'))
        self.assertFalse(cache.ready('op://other'))
        cache.clear()
        self.assertFalse(cache.ready('op://a'))
        self.assertEqual(cache.get('op://a'), 'sk-ant-3')
        self.assertEqual(len(reads), 3)

    def test_serve_answers_many_messages_echoes_ids_and_drops_rejected_keys(self):
        def framed(*values):
            out = b''
            for v in values:
                d = json.dumps(v).encode(); out += struct.pack('<I', len(d)) + d
            return out
        reads = []
        cache = host.KeyCache(lambda ref: reads.append(ref) or 'k')
        calls = []
        def handler(message, read_key, key_ready):
            calls.append(read_key('op://x'))
            if message.get('reject'):
                raise host.KeyRejected('rejected')
            return {'ok': True}
        stdout = io.BytesIO()
        host.serve(io.BytesIO(framed({'type': 'rewrite', 'id': 'r1'}, {'type': 'rewrite', 'id': 'r2'},
                                     {'type': 'rewrite', 'id': 'r3', 'reject': True}, {'type': 'rewrite', 'id': 'r4'})),
                   stdout, cache=cache, handler=handler)
        stream, replies = io.BytesIO(stdout.getvalue()), []
        while True:
            m = host.read_message(stream)
            if m is None: break
            replies.append(m)
        self.assertEqual([r['id'] for r in replies], ['r1', 'r2', 'r3', 'r4'])
        self.assertEqual(replies[2], {'ok': False, 'error': 'rejected', 'id': 'r3'})
        self.assertEqual(len(reads), 2)  # read once, then again only after the rejection

    def test_native_messaging_framing_and_safe_failures(self):
        def framed(value):
            data = json.dumps(value).encode()
            return struct.pack('<I', len(data)) + data
        out = io.BytesIO()
        host.write_message(out, {'a': 1})
        self.assertEqual(host.read_message(io.BytesIO(out.getvalue())), {'a': 1})
        self.assertIsNone(host.read_message(io.BytesIO(b'')))
        stdin, stdout = io.BytesIO(framed({'type': 'nope'})), io.BytesIO()
        original = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = types.SimpleNamespace(buffer=stdin), types.SimpleNamespace(buffer=stdout)
        try:
            host.main()
        finally:
            sys.stdin, sys.stdout = original
        reply = host.read_message(io.BytesIO(stdout.getvalue()))
        self.assertEqual(reply, {'ok': False, 'error': 'Unknown request.'})


if __name__ == '__main__':
    unittest.main()
