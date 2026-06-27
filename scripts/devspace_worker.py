#!/usr/bin/env python3
"""
DevSpace Worker - Local Orchestrator

This script automatically discovers pending tasks, calls local LLM,
applies code changes, runs tests, and generates execution reports.

Usage:
    python devspace_worker.py [--config config.yaml]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Tuple

import yaml

DEVSPACE_DIR = ".devspace"
TASK_FILE = "current_task.md"
REPORT_FILE = "execution_report.md"
EVENTS_FILE = "events.jsonl"
STATE_FILE = "state.json"

DEFAULT_CONFIG = {
    "ollama_url": "http://localhost:11434",
    "model": "llama3",
    "poll_interval": 10,
    "max_execution_time": 1800,
    "max_retries": 1,
}


class TaskParser:
    @staticmethod
    def parse(content: str) -> dict:
        task = {
            "id": "",
            "title": "",
            "status": "待执行",
            "goal": "",
            "allowed_changes": [],
            "forbidden_changes": [],
            "required_tests": [],
        }

        lines = content.split("\n")
        current_section = None
        in_code_block = False

        for line in lines:
            if line.startswith("```"):
                in_code_block = not in_code_block
                continue

            if in_code_block:
                if current_section == "required_tests":
                    task["required_tests"].append(line.strip())
                continue

            if line.startswith("# 任务："):
                task["title"] = line[5:].strip()
                continue

            if line.startswith("## 状态"):
                current_section = "status"
                continue
            if line.startswith("## 任务ID"):
                current_section = "id"
                continue
            if line.startswith("## 目标"):
                current_section = "goal"
                continue
            if line.startswith("## 允许修改范围"):
                current_section = "allowed_changes"
                task["allowed_changes"] = []
                continue
            if line.startswith("## 禁止修改范围"):
                current_section = "forbidden_changes"
                task["forbidden_changes"] = []
                continue
            if line.startswith("## 必须运行的测试"):
                current_section = "required_tests"
                task["required_tests"] = []
                continue

            trimmed = line.strip()
            if not trimmed:
                continue

            if current_section == "status":
                task["status"] = trimmed
            elif current_section == "id":
                task["id"] = trimmed.replace("`", "")
            elif current_section == "goal":
                task["goal"] = trimmed
            elif current_section == "allowed_changes" and trimmed.startswith("- "):
                task["allowed_changes"].append(trimmed[2:])
            elif current_section == "forbidden_changes" and trimmed.startswith("- "):
                task["forbidden_changes"].append(trimmed[2:])

        return task

    @staticmethod
    def is_pending(task: dict) -> bool:
        return task["status"] == "待执行"


class BoundaryChecker:
    @staticmethod
    def check_file_allowed(file_path: str, allowed: list, forbidden: list) -> bool:
        for pattern in forbidden:
            if BoundaryChecker._match_pattern(file_path, pattern):
                return False

        for pattern in allowed:
            if BoundaryChecker._match_pattern(file_path, pattern):
                return True

        return False

    @staticmethod
    def _match_pattern(file_path: str, pattern: str) -> bool:
        if pattern.endswith("/*"):
            prefix = pattern[:-2]
            return file_path.startswith(prefix)
        return file_path == pattern

    @staticmethod
    def check_git_diff(task: dict) -> Tuple[bool, List[str]]:
        try:
            result = subprocess.run(
                ["git", "diff", "--name-only"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            modified_files = [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]

            violations = []
            for file in modified_files:
                if not BoundaryChecker.check_file_allowed(
                    file, task["allowed_changes"], task["forbidden_changes"]
                ):
                    violations.append(file)

            return len(violations) == 0, violations
        except Exception as e:
            return False, [f"Error checking boundaries: {e}"]


class OllamaClient:
    def __init__(self, url: str, model: str):
        self.url = url
        self.model = model

    def generate(self, prompt: str, timeout: int = 300) -> Optional[str]:
        import urllib.request
        import urllib.error

        data = json.dumps({
            "model": self.model,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.url}/api/generate",
            data=data,
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
                return result.get("response")
        except urllib.error.URLError as e:
            print(f"Error calling Ollama API: {e}")
            return None
        except Exception as e:
            print(f"Unexpected error: {e}")
            return None


class EventLogger:
    def __init__(self, events_file: Path):
        self.events_file = events_file

    def log(self, event_type: str, task_id: str, data: dict = None):
        event = {
            "event": event_type,
            "task_id": task_id,
            "ts": datetime.now().isoformat(),
        }
        if data:
            event["data"] = data

        with open(self.events_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")


class DevSpaceWorker:
    def __init__(self, config: dict, project_root: str):
        self.config = config
        self.project_root = Path(project_root)
        self.devspace_dir = self.project_root / DEVSPACE_DIR
        self.ollama = OllamaClient(config["ollama_url"], config["model"])
        self.event_logger = EventLogger(self.devspace_dir / EVENTS_FILE)
        self.state = self._load_state()

    def _load_state(self) -> dict:
        state_file = self.devspace_dir / STATE_FILE
        if state_file.exists():
            with open(state_file, "r", encoding="utf-8") as f:
                return json.load(f)
        return {
            "current_phase": "idle",
            "active_tasks": [],
            "completed_tasks": [],
            "blocked_tasks": [],
        }

    def _save_state(self):
        state_file = self.devspace_dir / STATE_FILE
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)

    def check_pending_task(self) -> Optional[dict]:
        task_file = self.devspace_dir / TASK_FILE
        if not task_file.exists():
            return None

        with open(task_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        task = TaskParser.parse(content)
        if TaskParser.is_pending(task):
            return task
        return None

    def update_task_status(self, status: str):
        task_file = self.devspace_dir / TASK_FILE
        with open(task_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        content = re.sub(
            r"## 状态\n.+",
            f"## 状态\n{status}",
            content,
        )

        with open(task_file, "w", encoding="utf-8") as f:
            f.write(content)

    def build_prompt(self, task: dict) -> str:
        return f"""你是一个专业的软件开发者。请执行以下任务：

任务标题：{task['title']}
任务目标：{task['goal']}

允许修改的文件范围：
{chr(10).join('- ' + f for f in task['allowed_changes'])}

禁止修改的文件范围：
{chr(10).join('- ' + f for f in task['forbidden_changes'])}

请完成以下步骤：
1. 阅读相关代码
2. 实现所需的修改
3. 确保代码风格一致
4. 添加必要的错误处理

请直接输出代码修改，不要输出解释。使用标准的 diff 格式。"""

    def apply_changes(self, diff_content: str) -> bool:
        try:
            process = subprocess.run(
                ["git", "apply", "--check"],
                input=diff_content,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=self.project_root,
            )

            if process.returncode != 0:
                print(f"Diff check failed: {process.stderr}")
                return False

            process = subprocess.run(
                ["git", "apply"],
                input=diff_content,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=self.project_root,
            )

            return process.returncode == 0
        except Exception as e:
            print(f"Error applying changes: {e}")
            return False

    def run_tests(self, test_commands: List[str]) -> Tuple[bool, str]:
        results = []
        all_passed = True

        for cmd in test_commands:
            if not cmd.strip():
                continue

            print(f"Running: {cmd}")
            try:
                process = subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=300,
                    cwd=self.project_root,
                )

                result = {
                    "command": cmd,
                    "success": process.returncode == 0,
                    "output": process.stdout + process.stderr,
                }
                results.append(result)

                if not result["success"]:
                    all_passed = False
            except subprocess.TimeoutExpired:
                results.append({
                    "command": cmd,
                    "success": False,
                    "output": "Test timed out after 300 seconds",
                })
                all_passed = False
            except Exception as e:
                results.append({
                    "command": cmd,
                    "success": False,
                    "output": str(e),
                })
                all_passed = False

        output = "\n".join(
            f"$ {r['command']}\n{r['output']}\n{'✓ Passed' if r['success'] else '✗ Failed'}"
            for r in results
        )

        return all_passed, output

    def get_git_diff_stat(self) -> str:
        try:
            result = subprocess.run(
                ["git", "diff", "--stat"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                cwd=self.project_root,
            )
            return result.stdout
        except Exception:
            return "Error getting git diff stat"

    def get_git_diff(self) -> str:
        try:
            result = subprocess.run(
                ["git", "diff"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                cwd=self.project_root,
            )
            return result.stdout
        except Exception:
            return "Error getting git diff"

    def generate_report(self, task: dict, success: bool, test_output: str, problems: List[str] = None):
        status = "已完成" if success else "失败"
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        report = f"""# 执行报告

## 状态
{status}

## 任务ID
{task['id']}

## 执行时间
- 开始：{now}
- 结束：{now}
- 耗时：N/A

## 修改文件列表
```bash
$ git diff --stat
{self.get_git_diff_stat()}
```

## 测试结果
```bash
{test_output}
```

## git diff
```diff
{self.get_git_diff()}
```

## 遇到的问题
{chr(10).join(f'{i+1}. {p}' for i, p in enumerate(problems or [])) or '无'}

## 未完成部分
无

## 建议下一步
{'继续下一步任务' if success else '修复失败的测试后重新提交'}

## 备注
自动生成于 {now}
"""

        report_file = self.devspace_dir / REPORT_FILE
        with open(report_file, "w", encoding="utf-8") as f:
            f.write(report)

    def archive_task(self, task: dict):
        history_dir = self.devspace_dir / "task_history"
        history_dir.mkdir(exist_ok=True)

        date_str = datetime.now().strftime("%Y-%m-%d")
        archive_name = f"{date_str}_{task['id']}.md"

        task_file = self.devspace_dir / TASK_FILE
        if task_file.exists():
            archive_path = history_dir / archive_name
            with open(task_file, "r", encoding="utf-8") as f:
                content = f.read()
            with open(archive_path, "w", encoding="utf-8") as f:
                f.write(content)

    def execute_task(self, task: dict):
        print(f"Executing task: {task['title']}")
        self.event_logger.log("LOCAL_STARTED", task["id"])
        self.update_task_status("执行中")

        self.state["current_phase"] = "executing"
        self.state["active_tasks"] = [task["id"]]
        self._save_state()

        prompt = self.build_prompt(task)
        print("Calling local LLM...")
        response = self.ollama.generate(prompt, timeout=self.config["max_execution_time"])

        if not response:
            print("Failed to get response from LLM")
            self.generate_report(task, False, "LLM call failed", ["Failed to get response from local model"])
            self.update_task_status("待审核")
            self.event_logger.log("REPORT_READY", task["id"], {"status": "failed"})
            return

        print("Applying changes...")
        if not self.apply_changes(response):
            print("Failed to apply changes")
            self.generate_report(task, False, "Failed to apply changes", ["Git apply failed"])
            self.update_task_status("待审核")
            self.event_logger.log("REPORT_READY", task["id"], {"status": "failed"})
            return

        is_allowed, violations = BoundaryChecker.check_git_diff(task)
        if not is_allowed:
            print(f"Boundary violations detected: {violations}")
            self.generate_report(task, False, "Boundary violations", [f"Modified forbidden files: {violations}"])
            self.update_task_status("待审核")
            self.event_logger.log("REPORT_READY", task["id"], {"status": "boundary_violation"})
            return

        print("Running tests...")
        all_passed, test_output = self.run_tests(task["required_tests"])

        for attempt in range(self.config["max_retries"]):
            if all_passed:
                break
            print(f"Test failed, retry {attempt + 1}/{self.config['max_retries']}...")
            all_passed, test_output = self.run_tests(task["required_tests"])

        self.generate_report(task, all_passed, test_output)
        self.update_task_status("待审核")

        self.event_logger.log("TEST_PASSED" if all_passed else "TEST_FAILED", task["id"])
        self.event_logger.log("REPORT_READY", task["id"], {"status": "completed" if all_passed else "failed"})

        self.state["current_phase"] = "idle"
        self.state["active_tasks"] = []
        if all_passed:
            self.state["completed_tasks"].append(task["id"])
        self._save_state()

        print(f"Task execution {'completed' if all_passed else 'failed'}")

    def run(self):
        print(f"DevSpace Worker started")
        print(f"Ollama URL: {self.config['ollama_url']}")
        print(f"Model: {self.config['model']}")
        print(f"Poll interval: {self.config['poll_interval']}s")
        print(f"Max execution time: {self.config['max_execution_time']}s")
        print()

        while True:
            task = self.check_pending_task()
            if task:
                print(f"Found pending task: {task['title']}")
                self.event_logger.log("TASK_CREATED", task["id"])
                self.execute_task(task)
            else:
                print(".", end="", flush=True)

            time.sleep(self.config["poll_interval"])


def load_config(config_path: str) -> dict:
    config = DEFAULT_CONFIG.copy()

    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            user_config = yaml.safe_load(f)
            if user_config:
                config.update(user_config)

    return config


def main():
    parser = argparse.ArgumentParser(description="DevSpace Worker - Local Orchestrator")
    parser.add_argument(
        "--config",
        default="devspace_worker_config.yaml",
        help="Path to config file",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Path to project root",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    worker = DevSpaceWorker(config, args.project_root)
    worker.run()


if __name__ == "__main__":
    main()
