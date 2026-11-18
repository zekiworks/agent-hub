"""Best-effort, bounded Hermes telemetry. Never injects context or changes execution."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import json
import threading
import time
from typing import Any


class LiveView:
    STATUS_SECONDS = .25
    FLUSH_SECONDS = .3
    KEEP = 60
    MAX_TEXT = 20000

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loop = None
        self._ws = None
        self._generation = 0
        self._status_timer = None
        self._activity_timer = None
        self._watching = False
        self._watch_generation = 0
        self._entries: OrderedDict[str, dict] = OrderedDict()
        self._changed: set[str] = set()
        self._turns: set[tuple[str, str]] = set()
        self._tools: OrderedDict[str, dict] = OrderedDict()
        self._assistant_by_turn: dict[tuple[str, str], str] = {}
        self._activity: dict[tuple[str, str], str] = {}
        self._serial = 0
        self._since = self._now()

    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)

    def attach(self, loop, ws) -> None:
        with self._lock:
            self._generation += 1
            self._loop, self._ws = loop, ws
            self._status_timer = self._activity_timer = None
            self._watching = False
            self._watch_generation += 1
            self._schedule_status(0)

    def detach(self, ws=None) -> None:
        with self._lock:
            if ws is not None and self._ws is not ws:
                return
            self._generation += 1
            self._ws = None
            self._status_timer = self._activity_timer = None
            self._watching = False
            self._watch_generation += 1
            self._changed.clear()

    def _schedule_status(self, delay=STATUS_SECONDS) -> None:
        loop, generation = self._loop, self._generation
        if loop is None or self._ws is None:
            return
        try:
            loop.call_soon_threadsafe(self._arm_status, generation, delay)
        except RuntimeError:
            pass  # closing loop: telemetry must never break the owner

    def _arm_status(self, generation, delay) -> None:
        with self._lock:
            if generation != self._generation or self._ws is None or self._loop is None or self._status_timer is not None:
                return
            self._status_timer = self._loop.call_later(delay, self._flush_status, generation)

    def _flush_status(self, generation) -> None:
        with self._lock:
            if generation != self._generation or self._loop is None:
                return
            self._status_timer = None
            frame = {'type': 'status', 'status': {'state': 'busy' if self._turns else 'idle', 'since': self._since}}
            if self._turns and self._tools:
                oldest = next(iter(self._tools.values()))
                frame['status'].update(tool=oldest['name'], toolSince=oldest['at'])
            if self._turns and self._activity:
                frame['status']['activity'] = next(reversed(self._activity.values()))
            self._loop.create_task(self._send(frame, generation))

    async def _send(self, frame: dict, generation: int, watch_generation=None) -> None:
        with self._lock:
            if generation != self._generation or self._ws is None:
                return
            if frame['type'] == 'activity' and (not self._watching or watch_generation != self._watch_generation):
                return
            ws = self._ws
        try:
            async with asyncio.timeout(1):
                await ws.send(json.dumps(frame))
        except Exception:
            pass  # observational failure never drops or retries message deliveries

    def pre_llm_call(self, session_id='', turn_id='', parent_session_id='', **kwargs: Any) -> None:
        if parent_session_id:
            return
        with self._lock:
            if not self._turns:
                self._since = self._now()
            self._turns.add((session_id, turn_id))
            self._schedule_status()
            text = self._text(kwargs.get('user_message'))
            if text.strip():
                self._upsert({'id': self._id('u', session_id, turn_id), 'at': self._now(), 'kind': 'user', 'text': text})

    def on_session_end(self, session_id='', turn_id='', **kwargs: Any) -> None:
        with self._lock:
            key = (session_id, turn_id)
            if key not in self._turns:
                return
            self._turns.remove(key)
            assistant = self._entries.get(self._assistant_by_turn.pop(key, ''), {})
            if assistant and not assistant.get('done'):
                self._upsert({**assistant, 'done': True})
            self._activity.pop(key, None)
            for call, tool in list(self._tools.items()):
                if tool['scope'] == key:
                    self._tools.pop(call)
                    entry = self._entries.get(call)
                    if entry:
                        self._upsert({**entry, 'state': 'error', 'output': entry['output'] or 'Turn ended before tool completion was observed.'})
            if not self._turns:
                self._since = self._now()
            self._schedule_status()

    @classmethod
    def _text(cls, value, limit=MAX_TEXT) -> str:
        if isinstance(value, list):
            value = '\n'.join(b.get('text', '') for b in value if isinstance(b, dict) and isinstance(b.get('text'), str))
        if not isinstance(value, str):
            return ''
        return value if len(value) <= limit else value[:limit - 1] + '…'

    @staticmethod
    def _id(kind, session, turn, iteration=None) -> str:
        return kind + ':' + json.dumps([session, turn, iteration], separators=(',', ':'))

    def set_watching(self, on: bool) -> None:
        with self._lock:
            self._watching = on is True
            self._watch_generation += 1
            self._changed.clear()
            self._activity_timer = None
            if self._watching and self._loop is not None and self._ws is not None:
                generation, watch = self._generation, self._watch_generation
                self._loop.call_soon_threadsafe(self._replay, generation, watch)

    def _replay(self, generation, watch) -> None:
        with self._lock:
            if generation != self._generation or watch != self._watch_generation or not self._watching or self._loop is None:
                return
            frame = {'type': 'activity', 'events': list(self._entries.values()), 'replay': True}
            self._loop.create_task(self._send(frame, generation, watch))

    def _upsert(self, entry: dict) -> None:
        self._entries[entry['id']] = entry
        while len(self._entries) > self.KEEP:
            key, _ = self._entries.popitem(last=False)
            self._changed.discard(key)
        if not self._watching or self._loop is None or self._ws is None:
            return
        self._changed.add(entry['id'])
        try:
            self._loop.call_soon_threadsafe(self._arm_activity, self._generation, self._watch_generation)
        except RuntimeError:
            pass

    def _arm_activity(self, generation, watch) -> None:
        with self._lock:
            if generation != self._generation or watch != self._watch_generation or not self._watching or self._loop is None or self._activity_timer is not None:
                return
            self._activity_timer = self._loop.call_later(self.FLUSH_SECONDS, self._flush_activity, generation, watch)

    def _flush_activity(self, generation, watch) -> None:
        with self._lock:
            if generation != self._generation or watch != self._watch_generation or not self._watching or self._loop is None:
                return
            self._activity_timer = None
            events = [e for key, e in self._entries.items() if key in self._changed]
            self._changed.clear()
            if events:
                self._loop.create_task(self._send({'type': 'activity', 'events': events}, generation, watch))

    def on_stream_delta(self, session_id='', turn_id='', iteration=0, delta='', kind='text', **kwargs: Any) -> None:
        # Private reasoning is not promoted to visible assistant text.
        if kind != 'text' or not isinstance(delta, str):
            return
        with self._lock:
            if (session_id, turn_id) not in self._turns:
                return
            key = self._id('a', session_id, turn_id, iteration)
            old = self._entries.get(key, {})
            if old.get('done'):
                return
            self._upsert({'id': key, 'at': old.get('at', self._now()), 'kind': 'assistant',
                          'text': self._text(old.get('text', '') + delta), 'done': False})
            self._assistant_by_turn[(session_id, turn_id)] = key

    def on_stream_end(self, session_id='', turn_id='', iteration=0, final_text='', **kwargs: Any) -> None:
        with self._lock:
            if (session_id, turn_id) not in self._turns:
                return
            key = self._id('a', session_id, turn_id, iteration)
            old = self._entries.get(key, {})
            text = self._text(final_text) or old.get('text', '')
            if text or old:
                self._upsert({'id': key, 'at': old.get('at', self._now()), 'kind': 'assistant', 'text': text, 'done': True})
                self._assistant_by_turn[(session_id, turn_id)] = key

    def post_llm_call(self, session_id='', turn_id='', assistant_response='', **kwargs: Any) -> None:
        """Authoritative final fallback, including non-streaming clients and late stream queues."""
        with self._lock:
            scope = (session_id, turn_id)
            if scope not in self._turns:
                return
            key = self._assistant_by_turn.get(scope, self._id('a', session_id, turn_id, 'final'))
            old = self._entries.get(key, {})
            text = self._text(assistant_response) or old.get('text', '')
            if old.get('done') and text != old.get('text'):
                key = self._id('a', session_id, turn_id, 'final')
                old = self._entries.get(key, {})
            if text or old:
                self._upsert({'id': key, 'at': old.get('at', self._now()), 'kind': 'assistant', 'text': text, 'done': True})
                self._assistant_by_turn[scope] = key

    def on_interim_message(self, session_id='', turn_id='', text='', already_streamed=False, **kwargs: Any) -> None:
        if already_streamed:
            return
        with self._lock:
            scope = (session_id, turn_id)
            if scope not in self._turns:
                return
            text = self._text(text)
            old = self._entries.get(self._assistant_by_turn.get(scope, ''), {})
            if not text or old.get('text') == text:
                return
            self._serial += 1
            key = self._id('a', session_id, turn_id, f'interim:{self._serial}')
            self._upsert({'id': key, 'at': self._now(), 'kind': 'assistant', 'text': text, 'done': True})

    @classmethod
    def _input(cls, args) -> str:
        if isinstance(args, dict):
            for key in ('command', 'cmd', 'code', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt'):
                if isinstance(args.get(key), str):
                    return cls._text(args[key], 600)
        try:
            return cls._text(json.dumps(args, ensure_ascii=False), 600)
        except (TypeError, ValueError):
            return ''

    def pre_tool_call(self, session_id='', turn_id='', tool_call_id='', tool_name='', args=None, **kwargs: Any) -> None:
        with self._lock:
            scope = (session_id, turn_id)
            if scope not in self._turns or not tool_call_id:
                return
            key = self._id('tool', session_id, turn_id, tool_call_id)
            at = self._now()
            intent = ''
            if isinstance(args, dict):
                intent = self._text(args.get('description') or args.get('intent'), 600).strip()
                code = args.get('code')
                if not intent and isinstance(code, str) and code.lstrip().startswith('#'):
                    intent = self._text(code.lstrip().split('\n', 1)[0].lstrip('# '), 600)
            name = self._text(tool_name, 120)
            self._tools[key] = {'scope': scope, 'name': name, 'at': at}
            if intent:
                self._activity[scope] = intent
            entry = {'id': key, 'at': at, 'kind': 'tool', 'name': name, 'input': self._input(args), 'output': '', 'state': 'running'}
            if intent:
                entry['intent'] = intent
            self._upsert(entry)
            self._schedule_status()

    def post_tool_call(self, session_id='', turn_id='', tool_call_id='', tool_name='', result='', status='', **kwargs: Any) -> None:
        with self._lock:
            key = self._id('tool', session_id, turn_id, tool_call_id)
            self._tools.pop(key, None)
            entry = self._entries.get(key)
            if entry is None:
                self._schedule_status()
                return
            if not isinstance(result, str):
                try:
                    result = json.dumps(result, ensure_ascii=False)
                except (TypeError, ValueError):
                    result = ''
            output = result if len(result) <= 4000 else '…' + result[-3999:]
            self._upsert({**entry, 'output': output, 'state': 'error' if status in ('error', 'failed', 'blocked', 'denied') else 'done'})
            self._schedule_status()
