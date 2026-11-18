"""Hermes plugin: a batch steered into a running turn reaches the model through conversation_history, not a later
user_message. It must count as seen there, or every later delivery waits for the 15-minute watchdog."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1] / "packages/hermes-plugin/message-bus"
spec = importlib.util.spec_from_file_location("hermes_bus_seen_under_test", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
assert spec is not None and spec.loader is not None
bus = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bus
spec.loader.exec_module(bus)


class Context:
    _manager = type("Manager", (), {"has_gateway_message_injector": True})()

    def __init__(self):
        self.injected: list[str] = []

    def inject_message(self, text, **kwargs):
        self.injected.append(text)
        return True


class Socket:
    def __init__(self):
        self.frames: list[dict] = []

    async def send(self, text):
        self.frames.append(json.loads(text))


def delivery(seq: int) -> dict:
    return {
        "type": "deliver", "wake": True, "replyTo": "@carol",
        "conversation": {"id": "g_1", "kind": "dm", "members": ["carol", "helper"], "addressed": ["carol", "helper"]},
        "message": {"seq": seq, "from": "carol", "fromKind": "human", "text": f"question {seq}", "files": [],
                    "createdAt": 0, "receipts": [{"to": "helper"}], "wake": ["helper"]},
    }


class SeenTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hermes-seen-test-")
        self.patches = [patch.object(bus, "STATE_DIR", Path(self.tmp.name)), patch.dict(os.environ, {"HERMES_HOME": self.tmp.name})]
        for p in self.patches:
            p.start()
        self.ctx = Context()
        client = bus.BusClient("http://unused.invalid", "helper")
        client.my_id = lambda: "helper"
        self.bridge = bus.GatewayBridge(self.ctx, client, "session-key")
        self.ws = Socket()
        self.bridge.loop = asyncio.get_running_loop()
        self.bridge.ws = self.ws

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def frames(self, kind: str) -> list[int]:
        return [f["seq"] for f in self.ws.frames if f["type"] == kind]

    async def test_a_batch_steered_into_a_running_turn_is_seen_from_history_and_releases_the_next(self):
        await self.bridge._deliver(self.ws, delivery(1))  # injected at once, acked
        await self.bridge._deliver(self.ws, delivery(2))  # held behind #1
        self.assertEqual((self.frames("ack"), len(self.ctx.injected)), ([1], 1))
        # The gateway steered #1 into the turn already running: the next pre_llm_call's user_message is something
        # else, and #1 is in the history.
        history = [{"role": "user", "content": "Fix the benchmark"}, {"role": "assistant", "content": "On it."},
                   {"role": "user", "content": self.ctx.injected[0]}]
        self.bridge.pre_llm_call(session_id="other", user_message="continue", conversation_history=history)
        await asyncio.sleep(0.05)
        self.assertEqual(self.frames("seen"), [1])
        self.assertEqual(self.frames("ack"), [1, 2])  # #2 injected now, not after the watchdog
        self.assertIn("question 2", self.ctx.injected[1])

    async def test_a_header_only_in_the_assistant_s_own_words_is_not_seen(self):
        await self.bridge._deliver(self.ws, delivery(1))
        history = [{"role": "assistant", "content": "I expect [message-bus] #1 @carol soon"}]
        self.bridge.pre_llm_call(session_id="other", user_message="continue", conversation_history=history)
        await asyncio.sleep(0.05)
        self.assertEqual(self.frames("seen"), [])


if __name__ == "__main__":
    unittest.main()
