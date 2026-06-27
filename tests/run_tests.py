#!/usr/bin/env python3
"""
Simple test runner for DevSpace collaboration workflow.
Does not require pytest - runs tests directly.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from devspace_worker import (
    BoundaryChecker,
    DevSpaceWorker,
    EventLogger,
    TaskParser,
)


class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []

    def ok(self, name):
        self.passed += 1
        print(f"  ✓ {name}")

    def fail(self, name, reason):
        self.failed += 1
        self.errors.append((name, reason))
        print(f"  ✗ {name}: {reason}")

    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*50}")
        print(f"Results: {self.passed}/{total} passed, {self.failed} failed")
        if self.errors:
            print("\nFailed tests:")
            for name, reason in self.errors:
                print(f"  - {name}: {reason}")
        print(f"{'='*50}")
        return self.failed == 0


def create_test_project():
    """Create a temporary project with .devspace structure."""
    tmpdir = tempfile.mkdtemp()
    devspace_dir = os.path.join(tmpdir, ".devspace")
    os.makedirs(os.path.join(devspace_dir, "task_history"))
    os.makedirs(os.path.join(tmpdir, "src"))

    with open(os.path.join(devspace_dir, "context.md"), "w", encoding="utf-8") as f:
        f.write("# 项目背景\n\n## 项目名称\nTest Project\n")

    with open(os.path.join(devspace_dir, "current_task.md"), "w", encoding="utf-8") as f:
        f.write("""# 当前任务

## 状态
待执行

## 任务ID
`task-test-001`

## 目标
Test task

## 允许修改范围
- src/*

## 禁止修改范围
- .devspace/*
- package.json

## 验收标准
- [ ] All tests pass

## 必须运行的测试
```bash
echo "test passed"
```

## 报告格式要求
1. git diff --stat
2. Test results

## 失败时如何处理
Explain what went wrong

## 优先级
P1
""")

    with open(os.path.join(devspace_dir, "execution_report.md"), "w", encoding="utf-8") as f:
        f.write("# 执行报告\n\n## 状态\n待执行\n")

    with open(os.path.join(devspace_dir, "review.md"), "w", encoding="utf-8") as f:
        f.write("# 审核意见\n\n## 审核结果\n待审核\n")

    with open(os.path.join(devspace_dir, "decision.md"), "w", encoding="utf-8") as f:
        f.write("# 最终裁决\n\n## 裁决结果\n待裁决\n")

    with open(os.path.join(devspace_dir, "next_task.md"), "w", encoding="utf-8") as f:
        f.write("# 下一轮任务\n\n## 状态\n待创建\n")

    with open(os.path.join(devspace_dir, "events.jsonl"), "w", encoding="utf-8") as f:
        f.write("")

    with open(os.path.join(devspace_dir, "state.json"), "w", encoding="utf-8") as f:
        json.dump({
            "current_phase": "idle",
            "active_tasks": [],
            "completed_tasks": [],
            "blocked_tasks": [],
        }, f, indent=2)

    with open(os.path.join(tmpdir, "src", "main.py"), "w", encoding="utf-8") as f:
        f.write("def main():\n    print('Hello')\n")

    return tmpdir


SAMPLE_TASK = """# 任务：测试任务

## 状态
待执行

## 任务ID
`task-sample-001`

## 目标
实现一个简单的功能

## 允许修改范围
- src/services/*
- tests/*

## 禁止修改范围
- src/config/*
- package.json

## 验收标准
- [ ] 所有测试通过
- [ ] 无类型错误

## 必须运行的测试
```bash
echo "Tests passed"
```

## 报告格式要求
1. git diff --stat
2. 测试结果

## 失败时如何处理
说明问题和尝试的解决方案

## 优先级
P1
"""


def test_task_parser(result):
    """Test TaskParser class."""
    print("\n[TestTaskParser]")

    task = TaskParser.parse(SAMPLE_TASK)
    if task["id"] == "task-sample-001":
        result.ok("parse_complete_task - id")
    else:
        result.fail("parse_complete_task - id", f"Expected 'task-sample-001', got '{task['id']}'")

    if task["title"] == "测试任务":
        result.ok("parse_complete_task - title")
    else:
        result.fail("parse_complete_task - title", f"Expected '测试任务', got '{task['title']}'")

    if task["status"] == "待执行":
        result.ok("parse_complete_task - status")
    else:
        result.fail("parse_complete_task - status", f"Expected '待执行', got '{task['status']}'")

    if task["goal"] == "实现一个简单的功能":
        result.ok("parse_complete_task - goal")
    else:
        result.fail("parse_complete_task - goal", f"Expected '实现一个简单的功能', got '{task['goal']}'")

    if "src/services/*" in task["allowed_changes"]:
        result.ok("parse_complete_task - allowed_changes")
    else:
        result.fail("parse_complete_task - allowed_changes", "src/services/* not found")

    if "src/config/*" in task["forbidden_changes"]:
        result.ok("parse_complete_task - forbidden_changes")
    else:
        result.fail("parse_complete_task - forbidden_changes", "src/config/* not found")

    task2 = TaskParser.parse("# 任务：Test\n\n## 状态\n执行中\n")
    if task2["status"] == "执行中":
        result.ok("parse_task_status")
    else:
        result.fail("parse_task_status", f"Expected '执行中', got '{task2['status']}'")

    if TaskParser.is_pending({"status": "待执行"}):
        result.ok("is_pending - 待执行")
    else:
        result.fail("is_pending - 待执行", "Should be pending")

    if not TaskParser.is_pending({"status": "执行中"}):
        result.ok("is_pending - 执行中")
    else:
        result.fail("is_pending - 执行中", "Should not be pending")


def test_boundary_checker(result):
    """Test BoundaryChecker class."""
    print("\n[TestBoundaryChecker]")

    allowed = ["src/*", "tests/*"]
    forbidden = ["src/config/*"]

    if BoundaryChecker.check_file_allowed("src/main.py", allowed, forbidden):
        result.ok("file_allowed - src/main.py")
    else:
        result.fail("file_allowed - src/main.py", "Should be allowed")

    if BoundaryChecker.check_file_allowed("tests/test.py", allowed, forbidden):
        result.ok("file_allowed - tests/test.py")
    else:
        result.fail("file_allowed - tests/test.py", "Should be allowed")

    allowed2 = ["src/*"]
    forbidden2 = ["src/config/*", "package.json"]

    if not BoundaryChecker.check_file_allowed("src/config/db.py", allowed2, forbidden2):
        result.ok("file_forbidden - src/config/db.py")
    else:
        result.fail("file_forbidden - src/config/db.py", "Should be forbidden")

    if not BoundaryChecker.check_file_allowed("package.json", allowed2, forbidden2):
        result.ok("file_forbidden - package.json")
    else:
        result.fail("file_forbidden - package.json", "Should be forbidden")

    if not BoundaryChecker.check_file_allowed("docs/readme.md", allowed2, forbidden2):
        result.ok("file_not_in_range - docs/readme.md")
    else:
        result.fail("file_not_in_range - docs/readme.md", "Should not be allowed")

    if BoundaryChecker._match_pattern("src/main.py", "src/*"):
        result.ok("pattern_match - src/main.py")
    else:
        result.fail("pattern_match - src/main.py", "Should match")

    if BoundaryChecker._match_pattern("src/services/auth.py", "src/*"):
        result.ok("pattern_match - src/services/auth.py")
    else:
        result.fail("pattern_match - src/services/auth.py", "Should match")

    if not BoundaryChecker._match_pattern("tests/test.py", "src/*"):
        result.ok("pattern_no_match - tests/test.py")
    else:
        result.fail("pattern_no_match - tests/test.py", "Should not match")


def test_event_logger(result):
    """Test EventLogger class."""
    print("\n[TestEventLogger]")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        events_file = Path(f.name)

    try:
        logger = EventLogger(events_file)
        logger.log("TASK_CREATED", "task-001")

        content = events_file.read_text()
        event = json.loads(content.strip())

        if event["event"] == "TASK_CREATED":
            result.ok("log_event - event type")
        else:
            result.fail("log_event - event type", f"Expected 'TASK_CREATED', got '{event['event']}'")

        if event["task_id"] == "task-001":
            result.ok("log_event - task_id")
        else:
            result.fail("log_event - task_id", f"Expected 'task-001', got '{event['task_id']}'")

        if "ts" in event:
            result.ok("log_event - timestamp")
        else:
            result.fail("log_event - timestamp", "Timestamp not found")

        logger.log("LOCAL_STARTED", "task-001")
        logger.log("REPORT_READY", "task-001")

        lines = events_file.read_text().strip().split("\n")
        if len(lines) == 3:
            result.ok("log_multiple_events")
        else:
            result.fail("log_multiple_events", f"Expected 3 events, got {len(lines)}")

        events_file.unlink()
    except Exception as e:
        result.fail("event_logger", str(e))
        if events_file.exists():
            events_file.unlink()


def test_devspace_worker(result):
    """Test DevSpaceWorker class."""
    print("\n[TestDevSpaceWorker]")

    project_dir = create_test_project()

    config = {
        "ollama_url": "http://localhost:11434",
        "model": "llama3",
        "poll_interval": 10,
        "max_execution_time": 1800,
        "max_retries": 1,
    }

    try:
        worker = DevSpaceWorker(config, project_dir)

        if worker.state["current_phase"] == "idle":
            result.ok("load_state - current_phase")
        else:
            result.fail("load_state - current_phase", f"Expected 'idle', got '{worker.state['current_phase']}'")

        if worker.state["active_tasks"] == []:
            result.ok("load_state - active_tasks")
        else:
            result.fail("load_state - active_tasks", "Should be empty")

        task = worker.check_pending_task()
        if task is not None:
            result.ok("check_pending_task - found")
        else:
            result.fail("check_pending_task - found", "Task not found")

        if task and task["id"] == "task-test-001":
            result.ok("check_pending_task - id")
        else:
            result.fail("check_pending_task - id", f"Expected 'task-test-001', got '{task['id'] if task else None}'")

        worker.update_task_status("执行中")
        task_file = os.path.join(project_dir, ".devspace", "current_task.md")
        with open(task_file, "r", encoding="utf-8") as f:
            content = f.read()
        if "执行中" in content:
            result.ok("update_task_status")
        else:
            result.fail("update_task_status", "Status not updated")

        task_obj = {"id": "task-test-001", "title": "Test Task"}
        worker.generate_report(task_obj, True, "All tests passed", [])

        report_file = os.path.join(project_dir, ".devspace", "execution_report.md")
        with open(report_file, "r", encoding="utf-8") as f:
            content = f.read()

        if "已完成" in content:
            result.ok("generate_report - status")
        else:
            result.fail("generate_report - status", "Status not found in report")

        if "task-test-001" in content:
            result.ok("generate_report - task_id")
        else:
            result.fail("generate_report - task_id", "Task ID not found in report")

    except Exception as e:
        import traceback
        result.fail("devspace_worker", f"{str(e)}\n{traceback.format_exc()}")
    finally:
        import shutil
        shutil.rmtree(project_dir, ignore_errors=True)


def test_workflow_integration(result):
    """Test complete workflow integration."""
    print("\n[TestEndToEndWorkflow]")

    project_dir = create_test_project()

    config = {
        "ollama_url": "http://localhost:11434",
        "model": "llama3",
        "poll_interval": 10,
        "max_execution_time": 1800,
        "max_retries": 1,
    }

    try:
        worker = DevSpaceWorker(config, project_dir)

        task = worker.check_pending_task()
        if task is not None and task["status"] == "待执行":
            result.ok("workflow - check_pending_task")
        else:
            result.fail("workflow - check_pending_task", "Task not found or wrong status")

        events_file = Path(project_dir) / ".devspace" / "events.jsonl"
        logger = EventLogger(events_file)
        logger.log("TASK_CREATED", task["id"])

        lines = events_file.read_text().strip().split("\n")
        if len(lines) == 1:
            event = json.loads(lines[0])
            if event["event"] == "TASK_CREATED":
                result.ok("workflow - event_logging")
            else:
                result.fail("workflow - event_logging", f"Wrong event type: {event['event']}")
        else:
            result.fail("workflow - event_logging", f"Expected 1 event, got {len(lines)}")

        if BoundaryChecker.check_file_allowed("src/main.py", ["src/*"], ["src/config/*"]):
            result.ok("workflow - boundary_check_allowed")
        else:
            result.fail("workflow - boundary_check_allowed", "Should be allowed")

        if not BoundaryChecker.check_file_allowed("src/config/db.py", ["src/*"], ["src/config/*"]):
            result.ok("workflow - boundary_check_forbidden")
        else:
            result.fail("workflow - boundary_check_forbidden", "Should be forbidden")

        state_file = Path(project_dir) / ".devspace" / "state.json"
        state = json.loads(state_file.read_text())
        if state["current_phase"] == "idle":
            result.ok("workflow - state_initial")
        else:
            result.fail("workflow - state_initial", f"Expected 'idle', got '{state['current_phase']}'")

        worker.state["current_phase"] = "executing"
        worker.state["active_tasks"] = ["task-001"]
        worker._save_state()

        state = json.loads(state_file.read_text())
        if state["current_phase"] == "executing" and "task-001" in state["active_tasks"]:
            result.ok("workflow - state_update")
        else:
            result.fail("workflow - state_update", "State not updated correctly")

    except Exception as e:
        result.fail("workflow_integration", str(e))
    finally:
        import shutil
        shutil.rmtree(project_dir, ignore_errors=True)


def main():
    print("=" * 50)
    print("DevSpace Collaboration Workflow Tests")
    print("=" * 50)

    result = TestResult()

    test_task_parser(result)
    test_boundary_checker(result)
    test_event_logger(result)
    test_devspace_worker(result)
    test_workflow_integration(result)

    success = result.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
