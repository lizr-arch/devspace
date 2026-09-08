#!/usr/bin/env python3
"""Output JSON diagnostics about the Python environment at the given workspace root.

Usage:
    py -3.11 test/fixtures/inspect_python_env.py [workspace_root]

Output JSON with:
    - pythonVersion
    - resolvedExecutable
    - envPath
    - dependencyLockPath
    - dependencyLockSha256
    - installedPackages (top-level packages)
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def find_venv_python(workspace_root: Path) -> Path | None:
    """Find Python executable in .venv or venv."""
    for name in (".venv", "venv"):
        scripts_dir = "Scripts" if sys.platform == "win32" else "bin"
        exe_name = "python.exe" if sys.platform == "win32" else "python"
        python = workspace_root / name / scripts_dir / exe_name
        if python.is_file():
            return python
    return None


def get_python_version(python: Path) -> str | None:
    """Get Python version string."""
    try:
        result = subprocess.run(
            [str(python), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            output = result.stdout.strip() or result.stderr.strip()
            # "Python 3.11.9" -> "3.11.9"
            import re
            match = re.search(r"Python\s+(\S+)", output)
            return match.group(1) if match else output
    except Exception:
        pass
    return None


def get_installed_packages(python: Path) -> list[str]:
    """Get list of top-level installed packages."""
    try:
        result = subprocess.run(
            [str(python), "-m", "pip", "list", "--format=json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            packages = json.loads(result.stdout)
            return [p["name"] for p in packages]
    except Exception:
        pass
    return []


def find_dependency_lock(workspace_root: Path) -> tuple[str | None, str | None]:
    """Find dependency lock file and compute its SHA-256."""
    candidates = [
        "poetry.lock",
        "Pipfile.lock",
        "requirements-lock.txt",
        "requirements.txt",
    ]
    for candidate in candidates:
        lock_path = workspace_root / candidate
        if lock_path.is_file():
            sha = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            return candidate, sha
    return None, None


def main() -> None:
    workspace_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

    python = find_venv_python(workspace_root)
    python_version = get_python_version(python) if python else None
    dep_lock_path, dep_lock_sha = find_dependency_lock(workspace_root)
    installed = get_installed_packages(python) if python else []

    result = {
        "pythonVersion": python_version,
        "resolvedExecutable": str(python) if python else None,
        "envPath": str(workspace_root),
        "dependencyLockPath": dep_lock_path,
        "dependencyLockSha256": dep_lock_sha,
        "installedPackages": installed,
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
