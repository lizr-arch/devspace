import type { ToolName } from "./ui/card-types.js";

export type ToolFunctionalTestMode =
  "isolated_read" | "temp_workspace" | "local_bare_remote" | "mock_runtime";

export interface ToolTestCoverage {
  subsystem: string;
  functionalTests: string[];
  mode: ToolFunctionalTestMode;
  visualContract: "sandbox_fixture";
}

interface CoverageGroup extends ToolTestCoverage {
  tools: ToolName[];
}

const coverageGroups: CoverageGroup[] = [
  {
    tools: ["devspace_info"],
    subsystem: "service diagnostics",
    functionalTests: ["src/doctor.test.ts"],
    mode: "isolated_read",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["list_workspaces", "open_workspace", "resume_workspace"],
    subsystem: "workspace lifecycle",
    functionalTests: ["src/workspaces.test.ts", "src/doctor.test.ts"],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "list_artifacts",
      "inspect_artifact",
      "publish_artifact",
      "preview_artifact",
    ],
    subsystem: "artifact lifecycle",
    functionalTests: [
      "src/artifact-ledger.test.ts",
      "src/artifact-publisher.test.ts",
      "src/inspectors.test.ts",
    ],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["project_memory_preflight"],
    subsystem: "project memory",
    functionalTests: [
      "src/project-memory.test.ts",
      "src/project-memory-characterization.test.ts",
    ],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "read",
      "read_file",
      "write",
      "write_file",
      "edit",
      "edit_file",
      "grep",
      "grep_files",
      "glob",
      "find_files",
      "ls",
      "list_directory",
      "bash",
      "run_shell",
    ],
    subsystem: "workspace coding primitives",
    functionalTests: ["src/pi-tools.test.ts", "src/roots.test.ts"],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["mkdir", "copy", "move", "move_to_trash"],
    subsystem: "workspace file lifecycle",
    functionalTests: ["src/workspace-files.test.ts"],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["import_asset"],
    subsystem: "asset intake",
    functionalTests: ["src/asset-import.test.ts"],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["import_png"],
    subsystem: "PNG intake",
    functionalTests: [
      "src/png-import.test.ts",
      "src/openai-file.test.ts",
      "src/asset-receipts.test.ts",
    ],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "archive_approved_image",
      "find_approved_assets",
      "verify_approved_asset",
      "recover_approved_asset",
      "reindex_approved_assets",
    ],
    subsystem: "approved asset registry",
    functionalTests: [
      "src/approved-assets.test.ts",
      "src/approved-assets-registry.test.ts",
    ],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "git_status",
      "git_diff",
      "git_stage_paths",
      "git_unstage_paths",
      "git_commit",
      "git_branch",
    ],
    subsystem: "local Git",
    functionalTests: ["src/git-tools.test.ts"],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["git_fetch", "git_merge", "git_push"],
    subsystem: "remote Git",
    functionalTests: ["src/git-remote-tools.test.ts"],
    mode: "local_bare_remote",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "start_game_session",
      "inspect_game_session",
      "send_game_input",
      "capture_game_frame",
      "read_game_logs",
      "stop_game_session",
    ],
    subsystem: "game session",
    functionalTests: ["src/game-sessions.test.ts"],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
  {
    tools: [
      "inspect_glb",
      "inspect_blend",
      "inspect_audio",
      "render_model_preview",
    ],
    subsystem: "external inspectors",
    functionalTests: ["src/inspectors.test.ts"],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["show_changes"],
    subsystem: "review checkpoints",
    functionalTests: ["src/review-checkpoints.test.ts"],
    mode: "temp_workspace",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["start_job", "wait_job", "list_jobs", "poll_job", "cancel_job"],
    subsystem: "background jobs",
    functionalTests: [
      "src/background-jobs.test.ts",
      "src/background-jobs-venv.test.ts",
    ],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
  {
    tools: ["start_capture"],
    subsystem: "capture jobs",
    functionalTests: [
      "src/capture-profiles.test.ts",
      "src/background-jobs.test.ts",
    ],
    mode: "mock_runtime",
    visualContract: "sandbox_fixture",
  },
];

export const TOOL_TEST_COVERAGE = Object.fromEntries(
  coverageGroups.flatMap((group) =>
    group.tools.map((tool) => [
      tool,
      {
        subsystem: group.subsystem,
        functionalTests: group.functionalTests,
        mode: group.mode,
        visualContract: group.visualContract,
      },
    ]),
  ),
) as Record<ToolName, ToolTestCoverage>;
