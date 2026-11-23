"""Serve a Liquid AI d1 model over the System One HTTP contract."""

import argparse
import json
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Handler(BaseHTTPRequestHandler):
    server: "Server"

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok", "model": self.server.name})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/v1/systemone":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            if not isinstance(request, dict):
                raise ValueError("the request body must be a JSON object")
            model = request.get("model", self.server.name)
            if model != self.server.name:
                raise ValueError(f"this server answers for {self.server.name}, not {model}")
            questions = request.get("questions")
            if not isinstance(questions, dict) or not questions:
                raise ValueError("questions must be a nonempty object")
            if request.get("images"):
                raise ValueError("this text routing comparison does not accept images")
            with self.server.lock:
                out = self.server.model.system_one(request.get("state"), questions)
            self.send_json(
                HTTPStatus.OK,
                {"model": self.server.name, "answers": out["answers"], "usage": out["usage"]},
            )
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    def send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("x-request-id", uuid.uuid4().hex)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


class Server(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], model: Any, name: str) -> None:
        super().__init__(address, Handler)
        self.model = model
        self.name = name
        self.lock = threading.Lock()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9966)
    args = parser.parse_args()

    import torch
    import transformers
    from transformers import AutoModel

    model = AutoModel.from_pretrained(
        args.model,
        revision=args.revision,
        trust_remote_code=True,
        dtype=torch.bfloat16,
    ).to(args.device)
    server = Server((args.host, args.port), model, args.model)
    print(
        json.dumps(
            {
                "url": f"http://{args.host}:{args.port}",
                "model": args.model,
                "revision": args.revision,
                "device": args.device,
                "torch": torch.__version__,
                "transformers": transformers.__version__,
            }
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
