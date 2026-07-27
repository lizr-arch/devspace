import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  formatPathForPrompt,
  loadWorkspaceSkills,
  resolveSkillReadPath,
} from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));

try {
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  await mkdir(join(projectRoot, ".pi", "skills", "project-skill"), {
    recursive: true,
  });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });

  await writeFile(
    join(projectRoot, ".pi", "skills", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: First duplicate wins.",
      "---",
      "",
      "# Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "duplicate", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: Duplicate loser.",
      "---",
      "",
      "# Duplicate Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "disabled", "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Hidden skill.",
      "disable-model-invocation: true",
      "---",
      "",
      "# Hidden Skill",
    ].join("\n"),
  );

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.deepEqual(loadWorkspaceSkills(disabledConfig, projectRoot).skills, []);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(
    loaded.skills.some((skill) => skill.name === "project-skill"),
    true,
  );
  assert.equal(
    loaded.skills.filter((skill) => skill.name === "duplicate-skill").length,
    1,
  );
  assert.equal(
    loaded.skills.some((skill) => skill.name === "hidden-skill"),
    true,
  );
  assert.equal(
    loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"),
    true,
  );

  const projectSkill = loaded.skills.find(
    (skill) => skill.name === "project-skill",
  );
  assert.ok(projectSkill);
  assert.match(formatPathForPrompt(projectSkill.filePath), /SKILL\.md$/);

  const skillFileRead = resolveSkillReadPath(
    loaded.skills,
    new Set(),
    projectSkill.filePath,
  );
  assert.equal(skillFileRead?.isSkillFile, true);
  assert.equal(
    skillFileRead?.absolutePath,
    await realpath(projectSkill.filePath),
  );

  const resourcePath = join(projectSkill.baseDir, "references.md");
  await writeFile(resourcePath, "reference\n");
  assert.equal(
    resolveSkillReadPath(loaded.skills, new Set(), resourcePath),
    undefined,
  );
  assert.equal(
    resolveSkillReadPath(
      loaded.skills,
      new Set([await realpath(projectSkill.baseDir)]),
      resourcePath,
    )?.isSkillFile,
    false,
  );

  const globalSkillRoot = await mkdtemp(
    join(homedir(), ".devspace-global-skill-test-"),
  );
  try {
    const skillDir = join(globalSkillRoot, "global");
    const skillFile = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFile, "# Global test skill\n");
    const globalSkill = {
      ...projectSkill,
      name: "global-test-skill",
      filePath: skillFile,
      baseDir: skillDir,
    };
    const advertisedHomePath = `~/${skillFile.slice(homedir().length + 1)}`;
    const advertisedRead = resolveSkillReadPath(
      [globalSkill],
      new Set(),
      advertisedHomePath,
    );
    assert.equal(advertisedRead?.isSkillFile, true);
    assert.equal(advertisedRead?.absolutePath, await realpath(skillFile));

    const activated = new Set<string>();
    const skillMain = resolveSkillReadPath([globalSkill], activated, skillFile);
    assert.ok(skillMain);
    activated.add(await realpath(skillDir));

    const childPath = join(skillDir, "references.md");
    await writeFile(childPath, "global reference\n");
    assert.equal(
      resolveSkillReadPath([globalSkill], activated, childPath)?.absolutePath,
      await realpath(childPath),
    );

    const outsidePath = join(globalSkillRoot, "outside.md");
    await writeFile(outsidePath, "outside\n");
    assert.equal(
      resolveSkillReadPath([globalSkill], activated, outsidePath),
      undefined,
    );
    assert.equal(
      resolveSkillReadPath(
        [globalSkill],
        activated,
        join(skillDir, "..", "outside.md"),
      ),
      undefined,
    );

    if (platform() !== "win32") {
      const escapePath = join(skillDir, "escape.md");
      await symlink(outsidePath, escapePath);
      assert.equal(
        resolveSkillReadPath([globalSkill], activated, escapePath),
        undefined,
      );
    }
  } finally {
    await rm(globalSkillRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
