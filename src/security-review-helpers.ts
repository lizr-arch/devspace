import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const isWin = process.platform === "win32";
export const scriptsDir = isWin ? "Scripts" : "bin";
export const pythonName = isWin ? "python.exe" : "python";

export function createFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `devspace-sec-${prefix}-`));
  mkdirSync(join(dir, ".devspace"), { recursive: true });
  return dir;
}

export function writeManifest(dir: string, yaml: string): void {
  writeFileSync(join(dir, ".devspace", "tasks.yaml"), yaml, "utf8");
}

export function createFakeVenv(dir: string, venvName: string = ".venv"): string {
  const venvRoot = join(dir, venvName);
  const venvScripts = join(venvRoot, scriptsDir);
  mkdirSync(venvScripts, { recursive: true });
  writeFileSync(join(venvRoot, "pyvenv.cfg"), "home = test\n", "utf8");
  const expectedPrefix = realpathSync(venvRoot);

  if (isWin) {
    const batContent = `@echo off\r\nif "%1"=="--version" echo Python 3.11.9\r\n`;
    const batPath = join(venvScripts, "python.bat");
    writeFileSync(batPath, batContent);
    writeFileSync(join(venvScripts, pythonName), " ");
  } else {
    const pythonPath = join(venvScripts, pythonName);
    const wrapperJs = join(venvScripts, "_python_wrapper.js");
    writeFileSync(
      wrapperJs,
      `const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Python 3.11.9'); process.exit(0); }
if (args[0] === '-c') { console.log(${JSON.stringify(expectedPrefix)}); process.exit(0); }
console.log(JSON.stringify({ argv: args }));
`,
    );
    writeFileSync(
      pythonPath,
      `#!/bin/sh\nexec "${process.execPath}" "${wrapperJs}" "$@"\n`,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("fs").chmodSync(pythonPath, 0o700);
  }
  return join(venvScripts, pythonName);
}

export function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file locks
  }
}

export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export const TEST_SECRET = "sk_live_1234567890abcdef_SECRET_VALUE_xyz";
export const ANOTHER_SECRET = "ghp_another_secret_token_67890";

export const SECRET_TASK_MANIFEST = `version: 1
tasks:
  echo-secret:
    mode: run
    command: ["node", "-e", "console.log(process.env.MY_TOKEN || 'no-secret')"]
    runtime: system
    timeout_seconds: 30
    secrets:
      - secret_ref: github_token
        target_env: MY_TOKEN
`;

export const PARAM_TASK_MANIFEST = `version: 1
tasks:
  param-echo:
    mode: run
    command: ["node", "-e", "console.log(process.argv.slice(2).join(' '))"]
    runtime: system
    timeout_seconds: 10
    parameters:
      message:
        type: string
        required: true
`;

export const PATH_PARAM_MANIFEST = `version: 1
tasks:
  path-echo:
    mode: run
    command: ["node", "-e", "console.log(process.argv[2])"]
    runtime: system
    timeout_seconds: 10
    parameters:
      file:
        type: path
        required: true
`;

export const ARTIFACT_TASK_MANIFEST = `version: 1
tasks:
  write-output:
    mode: run
    command: ["node", "-e", "const fs=require('fs');fs.writeFileSync('output.txt','secret data')"]
    runtime: system
    timeout_seconds: 10
`;
