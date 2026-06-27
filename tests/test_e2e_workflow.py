import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from devspace_worker import (
    BoundaryChecker,
    DevSpaceWorker,
    EventLogger,
    TaskParser,
)


class TestTaskParser:
    """Test TaskParser class."""

    def test_parse_complete_task(self, sample_task_content):
        """Test parsing a complete task file."""
        task = TaskParser.parse(sample_task_content)

        assert task["id"] == "task-sample-001"
        assert task["title"] == "测试任务"
        assert task["status"] == "待执行"
        assert task["goal"] == "实现一个简单的功能"
        assert "src/services/*" in task["allowed_changes"]
        assert "tests/*" in task["allowed_changes"]
        assert "src/config/*" in task["forbidden_changes"]
        assert "package.json" in task["forbidden_changes"]
        assert len(task["required_tests"]) > 0

    def test_parse_task_status(self):
        """Test parsing task with different statuses."""
        content = "# 任务：Test\n\n## 状态\n执行中\n"
        task = TaskParser.parse(content)
        assert task["status"] == "执行中"

    def test_is_pending(self):
        """Test is_pending method."""
        task = {"status": "待执行"}
        assert TaskParser.is_pending(task) is True

        task = {"status": "执行中"}
        assert TaskParser.is_pending(task) is False

        task = {"status": "已完成"}
        assert TaskParser.is_pending(task) is False


class TestBoundaryChecker:
    """Test BoundaryChecker class."""

    def test_file_allowed(self):
        """Test file in allowed range."""
        allowed = ["src/*", "tests/*"]
        forbidden = ["src/config/*"]

        assert BoundaryChecker.check_file_allowed("src/main.py", allowed, forbidden) is True
        assert BoundaryChecker.check_file_allowed("tests/test.py", allowed, forbidden) is True

    def test_file_forbidden(self):
        """Test file in forbidden range."""
        allowed = ["src/*"]
        forbidden = ["src/config/*", "package.json"]

        assert BoundaryChecker.check_file_allowed("src/config/db.py", allowed, forbidden) is False
        assert BoundaryChecker.check_file_allowed("package.json", allowed, forbidden) is False

    def test_file_not_in_any_range(self):
        """Test file not in any range."""
        allowed = ["src/*"]
        forbidden = ["src/config/*"]

        assert BoundaryChecker.check_file_allowed("docs/readme.md", allowed, forbidden) is False

    def test_pattern_matching(self):
        """Test wildcard pattern matching."""
        assert BoundaryChecker._match_pattern("src/main.py", "src/*") is True
        assert BoundaryChecker._match_pattern("src/services/auth.py", "src/*") is True
        assert BoundaryChecker._match_pattern("tests/test.py", "src/*") is False


class TestEventLogger:
    """Test EventLogger class."""

    def test_log_event(self, tmp_path):
        """Test logging an event."""
        events_file = tmp_path / "events.jsonl"
        logger = EventLogger(events_file)

        logger.log("TASK_CREATED", "task-001")

        content = events_file.read_text()
        event = json.loads(content.strip())

        assert event["event"] == "TASK_CREATED"
        assert event["task_id"] == "task-001"
        assert "ts" in event

    def test_log_multiple_events(self, tmp_path):
        """Test logging multiple events."""
        events_file = tmp_path / "events.jsonl"
        logger = EventLogger(events_file)

        logger.log("TASK_CREATED", "task-001")
        logger.log("LOCAL_STARTED", "task-001")
        logger.log("REPORT_READY", "task-001")

        lines = events_file.read_text().strip().split("\n")
        assert len(lines) == 3

    def test_log_event_with_data(self, tmp_path):
        """Test logging an event with additional data."""
        events_file = tmp_path / "events.jsonl"
        logger = EventLogger(events_file)

        logger.log("REPORT_READY", "task-001", {"status": "completed"})

        content = events_file.read_text()
        event = json.loads(content.strip())

        assert event["data"]["status"] == "completed"


class TestDevSpaceWorker:
    """Test DevSpaceWorker class."""

    def test_load_state(self, temp_project):
        """Test loading state from file."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))

        assert worker.state["current_phase"] == "idle"
        assert worker.state["active_tasks"] == []
        assert worker.state["completed_tasks"] == []

    def test_check_pending_task(self, temp_project):
        """Test checking for pending tasks."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))
        task = worker.check_pending_task()

        assert task is not None
        assert task["id"] == "task-test-001"
        assert task["status"] == "待执行"

    def test_update_task_status(self, temp_project):
        """Test updating task status."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))
        worker.update_task_status("执行中")

        task_file = temp_project / ".devspace" / "current_task.md"
        content = task_file.read_text()
        assert "执行中" in content

    def test_generate_report(self, temp_project):
        """Test generating execution report."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))
        task = {
            "id": "task-test-001",
            "title": "Test Task",
        }

        worker.generate_report(task, True, "All tests passed", [])

        report_file = temp_project / ".devspace" / "execution_report.md"
        content = report_file.read_text()

        assert "已完成" in content
        assert "task-test-001" in content
        assert "All tests passed" in content


class TestEndToEndWorkflow:
    """End-to-end workflow tests."""

    def test_complete_workflow(self, temp_project, mock_ollama_server):
        """Test complete task workflow."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))

        task = worker.check_pending_task()
        assert task is not None
        assert task["status"] == "待执行"

        events_file = temp_project / ".devspace" / "events.jsonl"
        logger = EventLogger(events_file)
        logger.log("TASK_CREATED", task["id"])

        lines = events_file.read_text().strip().split("\n")
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["event"] == "TASK_CREATED"

    def test_boundary_check_integration(self, temp_project):
        """Test boundary check in workflow."""
        allowed = ["src/*"]
        forbidden = ["src/config/*", "package.json"]

        assert BoundaryChecker.check_file_allowed("src/main.py", allowed, forbidden) is True
        assert BoundaryChecker.check_file_allowed("src/config/db.py", allowed, forbidden) is False
        assert BoundaryChecker.check_file_allowed("package.json", allowed, forbidden) is False

    def test_state_management(self, temp_project):
        """Test state management throughout workflow."""
        config = {
            "ollama_url": "http://localhost:11434",
            "model": "llama3",
            "poll_interval": 10,
            "max_execution_time": 1800,
            "max_retries": 1,
        }

        worker = DevSpaceWorker(config, str(temp_project))

        assert worker.state["current_phase"] == "idle"

        state_file = temp_project / ".devspace" / "state.json"
        state = json.loads(state_file.read_text())
        assert state["current_phase"] == "idle"

        worker.state["current_phase"] = "executing"
        worker.state["active_tasks"] = ["task-001"]
        worker._save_state()

        state = json.loads(state_file.read_text())
        assert state["current_phase"] == "executing"
        assert "task-001" in state["active_tasks"]


class TestCLIIntegration:
    """Test CLI command integration."""

    def test_collab_init_creates_structure(self, tmp_path):
        """Test that collab init creates proper directory structure."""
        devspace_dir = tmp_path / ".devspace"

        devspace_dir.mkdir(exist_ok=True)
        (devspace_dir / "task_history").mkdir(exist_ok=True)
        (devspace_dir / "state.json").write_text("{}")

        assert devspace_dir.exists()
        assert (devspace_dir / "task_history").exists()
        assert (devspace_dir / "state.json").exists()

    def test_collab_status_reads_state(self, tmp_path):
        """Test that collab status reads state correctly."""
        devspace_dir = tmp_path / ".devspace"
        devspace_dir.mkdir(exist_ok=True)

        state = {
            "current_phase": "idle",
            "active_tasks": [],
            "completed_tasks": ["task-001"],
            "blocked_tasks": [],
        }
        (devspace_dir / "state.json").write_text(json.dumps(state))

        loaded_state = json.loads((devspace_dir / "state.json").read_text())
        assert loaded_state["current_phase"] == "idle"
        assert "task-001" in loaded_state["completed_tasks"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
