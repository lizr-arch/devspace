#!/usr/bin/env python3
"""Mock OpenAI-compatible HTTP server for testing"""

import json
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

TEST_CASES = {
    "pass_next_task": {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": """## Verdict
PASS

## Reasoning Summary
All tests passed

## Next Action
Continue to next task

## Next Task
# Task: Next Task

## Task ID
task-002

## Objective
Continue development

## Status
pending

## Allowed Changes
- src/*

## Forbidden Changes
- .devspace/*

## Required Validation
npm test

## Acceptance Criteria
- Tests pass

## Blocking Issues
- None

## Non-blocking Issues
- None"""
            },
            "finish_reason": "stop"
        }]
    },
    "done": {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": """## Verdict
DONE

## Reasoning Summary
All tasks completed successfully

## Next Action
DONE

## Blocking Issues
- None

## Non-blocking Issues
- None"""
            },
            "finish_reason": "stop"
        }]
    },
    "missing_verdict": {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": """## Reasoning Summary
Some reasoning

## Next Action
Continue

## Blocking Issues
- None

## Non-blocking Issues
- None"""
            },
            "finish_reason": "stop"
        }]
    },
    "pass_no_next_task": {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": """## Verdict
PASS

## Reasoning Summary
Tests passed but no next task

## Next Action

## Blocking Issues
- None

## Non-blocking Issues
- None"""
            },
            "finish_reason": "stop"
        }]
    },
    "invalid_json": {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "not valid json at all"
            },
            "finish_reason": "stop"
        }]
    },
    "timeout": None,
}

request_count = 0
current_test_case = "pass_next_task"
request_log_path = os.path.join(os.path.dirname(__file__), "tmp", "openai_mock_requests.jsonl")

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class MockHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/request_count":
            response_body = json.dumps({"count": request_count}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global request_count
        request_count += 1

        if self.path == "/v1/chat/completions":
            content_length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(content_length).decode("utf-8")

            os.makedirs(os.path.dirname(request_log_path), exist_ok=True)
            with open(request_log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"n": request_count, "case": current_test_case}) + "\n")

            print(f"[Mock] req #{request_count} case={current_test_case}", flush=True)

            if current_test_case == "timeout":
                import time
                time.sleep(30)

            response = TEST_CASES.get(current_test_case, TEST_CASES["pass_next_task"])
            response_body = json.dumps(response).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(response_body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11435
    current_test_case = sys.argv[2] if len(sys.argv) > 2 else "pass_next_task"
    print(f"[Mock] port={port} case={current_test_case}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), MockHandler).serve_forever()
