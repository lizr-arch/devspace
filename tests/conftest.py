import json
import os
import shutil
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def temp_project(tmp_path):
    """Create a temporary project directory with .devspace structure."""
    devspace_dir = tmp_path / ".devspace"
    devspace_dir.mkdir()
    (devspace_dir / "task_history").mkdir()

    (devspace_dir / "context.md").write_text(
        "# 项目背景\n\n## 项目名称\nTest Project\n"
    )

    (devspace_dir / "current_task.md").write_text(
        """# 当前任务

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
"""
    )

    (devspace_dir / "execution_report.md").write_text("# 执行报告\n\n## 状态\n待执行\n")
    (devspace_dir / "review.md").write_text("# 审核意见\n\n## 审核结果\n待审核\n")
    (devspace_dir / "decision.md").write_text("# 最终裁决\n\n## 裁决结果\n待裁决\n")
    (devspace_dir / "next_task.md").write_text("# 下一轮任务\n\n## 状态\n待创建\n")

    (devspace_dir / "events.jsonl").write_text("")
    (devspace_dir / "state.json").write_text(
        json.dumps(
            {
                "current_phase": "idle",
                "active_tasks": [],
                "completed_tasks": [],
                "blocked_tasks": [],
            },
            indent=2,
        )
    )

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "main.py").write_text("def main():\n    print('Hello')\n")

    return tmp_path


@pytest.fixture
def mock_ollama_server():
    """Mock Ollama server responses."""

    class MockOllama:
        def __init__(self):
            self.responses = {}
            self.default_response = "diff --git a/src/main.py b/src/main.py\n+print('Modified')"

        def set_response(self, prompt_pattern, response):
            self.responses[prompt_pattern] = response

        def generate(self, prompt, **kwargs):
            for pattern, response in self.responses.items():
                if pattern in prompt:
                    return response
            return self.default_response

    return MockOllama()


@pytest.fixture
def sample_task_content():
    """Sample task content for testing."""
    return """# 任务：测试任务

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
