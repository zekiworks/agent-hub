"""Hermes op=home publishes to the status extension after the old project Home route was removed (toolbench #15068)."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1] / "packages/hermes-plugin/message-bus"
spec = importlib.util.spec_from_file_location("hermes_bus_home_under_test", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
assert spec is not None and spec.loader is not None
bus = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bus
spec.loader.exec_module(bus)


class Context:
    def __init__(self):
        self.handler = None

    def get_config(self, key, default=None):
        return {"url": "http://unused.invalid", "name": "toolbench", "session_key": None}.get(key, default)

    def register_tool(self, **kwargs):
        self.handler = kwargs["handler"]


class HomeTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.my_id = patch.object(bus.BusClient, "my_id", return_value="toolbench")
        self.my_id.start()
        bus.register(self.ctx)
        assert self.ctx.handler is not None

    def tearDown(self):
        self.my_id.stop()

    @staticmethod
    def response(text):
        return {
            "message": {"seq": 42, "from": "toolbench", "text": text, "files": [], "receipts": [], "wake": []},
            "conversation": {"id": "g_status", "kind": "dm", "members": ["toolbench", "status"]},
        }

    def test_home_publishes_a_status_update_without_waking(self):
        text = "### Latest\n\nTool benchmark finished."
        with patch.object(bus.BusClient, "write", return_value=self.response(text)) as write, patch.object(
            bus.BusClient, "delivery_status", return_value="delivered to @status"
        ):
            result = self.ctx.handler({"op": "home", "to": "@@toolbench", "message": text})
        write.assert_called_once_with({"to": "@status"}, text, [])
        self.assertIn("Published a Home update for @@toolbench through @status", result)

    def test_home_without_message_explains_the_stream_instead_of_calling_removed_route(self):
        with patch.object(bus.BusClient, "write") as write:
            result = self.ctx.handler({"op": "home"})
        write.assert_not_called()
        self.assertIn("newest-first stream", result)
        self.assertIn("reply to @status", result)

    def test_agent_cannot_publish_another_agents_home(self):
        with self.assertRaisesRegex(ValueError, "may publish only @@toolbench"):
            self.ctx.handler({"op": "home", "to": "@@logic", "message": "not mine"})


if __name__ == "__main__":
    unittest.main()
