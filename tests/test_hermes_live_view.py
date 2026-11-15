"""Hermes bus Live View contract, isolated from real gateways and the bus."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import os
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1] / 'packages/hermes-plugin/message-bus'
spec = importlib.util.spec_from_file_location('hermes_bus_under_test', PLUGIN / '__init__.py', submodule_search_locations=[str(PLUGIN)])
assert spec is not None and spec.loader is not None
bus = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bus
spec.loader.exec_module(bus)


class Context:
    _manager = type('Manager', (), {'has_gateway_message_injector': True})()
    def __init__(self):
        self.injected = []
        self.hooks = {}
    def get_config(self, key, default=None):
        return {'url': 'http://unused.invalid', 'name': 'fixture', 'session_key': 'session-key'}.get(key, default)
    def register_tool(self, **kwargs):
        pass
    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)
    def inject_message(self, text, **kwargs):
        self.injected.append(text)
        return True


class Socket:
    def __init__(self):
        self.frames = []
    async def send(self, text):
        self.frames.append(json.loads(text))


class LiveViewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.state_dir = tempfile.TemporaryDirectory(prefix='hermes-live-test-', dir=os.environ.get('TMPDIR'))
        root = Path(self.state_dir.name)
        (root / 'METADATA').write_text('Creator: Zeki\nReason: Isolated Live View unit-test state; no production credentials or gateway.\n')
        self.state_patch = patch.object(bus, 'STATE_DIR', root)
        self.state_patch.start()
        self.home_patch = patch.dict(os.environ, {'HERMES_HOME': str(root)})
        self.home_patch.start()
        self.ctx = Context()
        self.bridge = bus.GatewayBridge(self.ctx, bus.BusClient('http://unused.invalid', 'test'), 'session-key')
        self.ws = Socket()
        self.bridge.loop = asyncio.get_running_loop()
        self.bridge.ws = self.ws
        view = getattr(self.bridge, 'live_view', None)
        if view:
            view.attach(self.bridge.loop, self.ws)

    async def asyncTearDown(self):
        view = getattr(self.bridge, 'live_view', None)
        if view:
            view.detach()
        await asyncio.sleep(0)
        self.state_patch.stop()
        self.home_patch.stop()
        self.state_dir.cleanup()

    async def test_busy_and_idle_follow_turns_even_when_unwatched(self):
        self.assertTrue(hasattr(self.bridge, 'live_view'), 'gateway must expose its telemetry observer')
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='t', user_message='hello')
        await asyncio.sleep(.32)
        self.assertEqual(self.ws.frames[-1]['status']['state'], 'busy')
        self.assertFalse(any(f['type'] == 'activity' for f in self.ws.frames))
        view.on_session_end(session_id='s', turn_id='t', interrupted=True)
        await asyncio.sleep(.32)
        self.assertEqual(self.ws.frames[-1]['status']['state'], 'idle')
        self.assertNotIn('tool', self.ws.frames[-1]['status'])

    async def test_watch_replays_then_streams_upserts_and_stops_immediately(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='t', user_message='hello')
        await asyncio.sleep(.32)
        self.assertFalse(any(f['type'] == 'activity' for f in self.ws.frames))
        view.set_watching(True)
        await asyncio.sleep(.02)
        activity = [f for f in self.ws.frames if f['type'] == 'activity']
        self.assertTrue(activity[-1]['replay'])
        self.assertEqual(activity[-1]['events'][0]['text'], 'hello')
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='hi', kind='text')
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta=' there', kind='text')
        await asyncio.sleep(.34)
        activity = [f for f in self.ws.frames if f['type'] == 'activity']
        self.assertEqual(len(activity), 2)
        self.assertEqual(activity[-1]['events'][0]['text'], 'hi there')
        self.assertFalse(activity[-1]['events'][0]['done'])
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='pending', kind='text')
        view.set_watching(False)
        await asyncio.sleep(.34)
        self.assertEqual(len([f for f in self.ws.frames if f['type'] == 'activity']), 2)

    async def test_replay_is_bounded_and_large_text_is_capped(self):
        view = self.bridge.live_view
        for n in range(70):
            view.pre_llm_call(session_id='s', turn_id=str(n), user_message='x' * 25000)
            view.on_session_end(session_id='s', turn_id=str(n))
        view.set_watching(True)
        await asyncio.sleep(.02)
        events = [f for f in self.ws.frames if f['type'] == 'activity'][-1]['events']
        self.assertEqual(len(events), 60)
        self.assertTrue(all(len(e['text']) <= 20000 for e in events))
        self.assertEqual(len({e['id'] for e in events}), 60)

    async def test_stream_end_wins_over_late_delta(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='t', user_message='hello')
        view.on_stream_end(session_id='s', turn_id='t', iteration=1, final_text='final', finished=True)
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='stale', kind='text')
        view.set_watching(True)
        await asyncio.sleep(.02)
        events = [f for f in self.ws.frames if f['type'] == 'activity'][-1]['events']
        response = [e for e in events if e['kind'] == 'assistant']
        self.assertEqual(len(response), 1)
        self.assertEqual(response[0]['text'], 'final')
        self.assertTrue(response[0]['done'])

    async def test_tools_show_oldest_running_and_bounded_output(self):
        view = self.bridge.live_view
        scope = {'session_id': 's', 'turn_id': 't'}
        view.pre_llm_call(**scope, user_message='hi')
        view.pre_tool_call(**scope, tool_call_id='one', tool_name='terminal', args={'command': 'x' * 900})
        view.pre_tool_call(**scope, tool_call_id='two', tool_name='read_file', args={'path': 'fixture'})
        view.set_watching(True)
        await asyncio.sleep(.32)
        self.assertEqual([f for f in self.ws.frames if f['type'] == 'status'][-1]['status']['tool'], 'terminal')
        tools = [e for f in self.ws.frames if f['type'] == 'activity' for e in f['events'] if e['kind'] == 'tool']
        self.assertLessEqual(len(tools[0]['input']), 600)
        view.post_tool_call(**scope, tool_call_id='one', tool_name='terminal', result='y' * 6000, status='error')
        await asyncio.sleep(.34)
        self.assertEqual([f for f in self.ws.frames if f['type'] == 'status'][-1]['status']['tool'], 'read_file')
        tool = [e for f in self.ws.frames if f['type'] == 'activity' for e in f['events'] if e['kind'] == 'tool'][-1]
        self.assertEqual(tool['state'], 'error')
        self.assertLessEqual(len(tool['output']), 4000)
        self.assertTrue(tool['output'].endswith('yyy'))

    async def test_final_response_fallback_and_overlapping_turn_status(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='a', user_message='one')
        view.pre_llm_call(session_id='s', turn_id='b', user_message='two')
        view.post_llm_call(session_id='s', turn_id='a', assistant_response='non-streaming answer')
        view.on_session_end(session_id='s', turn_id='a')
        view.set_watching(True)
        await asyncio.sleep(.32)
        self.assertEqual([f for f in self.ws.frames if f['type'] == 'status'][-1]['status']['state'], 'busy')
        self.assertTrue(any(e.get('text') == 'non-streaming answer' and e.get('done') for f in self.ws.frames if f['type'] == 'activity' for e in f['events']))
        view.on_session_end(session_id='s', turn_id='b', failed=True)
        await asyncio.sleep(.32)
        self.assertEqual(self.ws.frames[-1]['status']['state'], 'idle')

    async def test_real_plugin_registers_observers_and_handles_watch(self):
        ctx = Context()
        captured = []
        with patch.object(bus.GatewayBridge, 'start', lambda bridge: captured.append(bridge)):
            bus.register(ctx)
        for name in ['pre_llm_call', 'post_llm_call', 'on_session_end', 'pre_tool_call', 'post_tool_call', 'on_stream_delta', 'on_stream_end']:
            self.assertIn(name, ctx.hooks)
        bridge = captured[0]
        bridge.loop, bridge.ws = asyncio.get_running_loop(), Socket()
        await bridge._handle(bridge.ws, {'type': 'joined', 'id': 'fixture'})
        for callback in ctx.hooks['pre_llm_call']:
            callback(session_id='s', turn_id='t', user_message='fixture')
        await bridge._handle(bridge.ws, {'type': 'watch', 'on': True})
        await asyncio.sleep(.32)
        self.assertTrue(any(f['type'] == 'activity' for f in bridge.ws.frames))
        bridge.live_view.detach()

    async def test_reconnect_republishes_status_but_not_unwatched_activity(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='t', user_message='one')
        view.set_watching(True)
        await asyncio.sleep(.02)
        old = self.ws
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='text')
        view.detach(old)
        fresh = Socket()
        view.attach(asyncio.get_running_loop(), fresh)
        await asyncio.sleep(.34)
        self.assertFalse(any(f['type'] == 'activity' for f in fresh.frames))
        self.assertEqual(fresh.frames[-1]['status']['state'], 'busy')
        view.detach(old)  # a stale disconnect cannot detach the new socket
        view.set_watching(True)
        await asyncio.sleep(.02)
        self.assertEqual([f for f in fresh.frames if f['type'] == 'activity'][-1]['events'][-1]['text'], 'text')

    async def test_telemetry_failure_does_not_break_deliver_ack_or_injection(self):
        class BrokenDisplay(Socket):
            async def send(self, text):
                if json.loads(text)['type'] in ('status', 'activity'):
                    raise RuntimeError('display transport failed')
                await super().send(text)
        ws = BrokenDisplay()
        self.bridge.ws = ws
        self.bridge.live_view.attach(asyncio.get_running_loop(), ws)
        with patch.object(self.bridge.client, 'my_id', return_value='fixture'), patch.object(bus, 'format_delivery', return_value='fixture delivery'):
            await self.bridge._handle(ws, {'type': 'watch', 'on': True})
            self.bridge.live_view.pre_llm_call(session_id='s', turn_id='t', user_message='one')
            await self.bridge._handle(ws, {'type': 'deliver', 'wake': True, 'message': {'seq': 7, 'files': []}})
            await self.bridge._handle(ws, {'type': 'deliver', 'wake': False, 'message': {'seq': 8, 'files': []}})
        await asyncio.sleep(.34)
        self.assertEqual(self.ctx.injected, ['fixture delivery'])
        self.assertEqual([f['seq'] for f in ws.frames if f['type'] == 'ack'], [7, 8])
        self.assertEqual(self.bridge.outstanding, {7})
        self.assertIn('fixture delivery', self.bridge.quiet)

    async def test_wire_observer_failure_is_contained(self):
        with patch.object(self.bridge.live_view, 'set_watching', side_effect=RuntimeError('broken display')):
            await self.bridge._handle(self.ws, {'type': 'watch', 'on': True})

    async def test_child_and_late_events_cannot_change_parent_state(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='child', turn_id='child', parent_session_id='s', user_message='hidden child')
        view.pre_llm_call(session_id='s', turn_id='t', user_message='one')
        view.pre_tool_call(session_id='s', turn_id='t', tool_call_id='c', tool_name='terminal', args={})
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='visible')
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='private reasoning', kind='reasoning')
        view.on_session_end(session_id='s', turn_id='t', interrupted=True)
        view.on_stream_delta(session_id='s', turn_id='t', iteration=1, delta='stale')
        view.set_watching(True)
        await asyncio.sleep(.32)
        self.assertEqual([f for f in self.ws.frames if f['type'] == 'status'][-1]['status']['state'], 'idle')
        events = [f for f in self.ws.frames if f['type'] == 'activity'][-1]['events']
        raw = json.dumps(events)
        self.assertNotIn('hidden child', raw)
        self.assertNotIn('private reasoning', raw)
        self.assertNotIn('stale', raw)
        self.assertEqual([e for e in events if e['kind'] == 'tool'][0]['state'], 'error')
        self.assertTrue([e for e in events if e['kind'] == 'assistant'][0]['done'])

    async def test_nonstream_final_does_not_overwrite_completed_interim(self):
        view = self.bridge.live_view
        view.pre_llm_call(session_id='s', turn_id='t', user_message='one')
        view.on_stream_end(session_id='s', turn_id='t', iteration=1, final_text='working', finished=True)
        view.post_llm_call(session_id='s', turn_id='t', assistant_response='the answer')
        view.set_watching(True)
        await asyncio.sleep(.02)
        events = [f for f in self.ws.frames if f['type'] == 'activity'][-1]['events']
        self.assertEqual([e['text'] for e in events if e['kind'] == 'assistant'], ['working', 'the answer'])


if __name__ == '__main__':
    unittest.main()
