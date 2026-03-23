/**
 * Workspace setup: repo cloning, skill injection, plugin loading, branch detection.
 *
 * Consolidates logic previously spread across server.ts into testable functions
 * that return data (WorkspaceResult) instead of mutating module-level state.
 */

import type { RoleConfig } from "./role-config";
import { loadPlugins, type PluginPath } from "./plugins";

export interface WorkspaceResult {
  agentCwd: string;
  additionalDirs: string[];
  plugins: PluginPath[];
}

export interface WorkspaceSetupOptions {
  repos: string[];
  githubToken?: string;
  roleConfig: RoleConfig;
  phoneHome: (message: string) => void;
}

const REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function repoName(repo: string): string {
  const name = repo.split("/").pop()!;
  if (!REPO_NAME_RE.test(name)) {
    throw new Error(`Invalid repo name: ${name}`);
  }
  return name;
}

/** Set up .netrc so git clone can authenticate with GitHub. */
async function setupNetrc(githubToken: string): Promise<void> {
  const home = process.env.HOME || "/home/agent";
  const netrc = `machine github.com\nlogin x-access-token\npassword ${githubToken}\n`;
  await Bun.write(`${home}/.netrc`, netrc);
  await Bun.spawn(["chmod", "600", `${home}/.netrc`]).exited;
}

/** Clone a single repo into /workspace/<name>. */
async function cloneRepo(repo: string): Promise<void> {
  const name = repoName(repo);
  console.log(`[Workspace] Cloning ${repo}...`);
  const proc = Bun.spawn([
    "git", "clone",
    `https://github.com/${repo}.git`,
    `/workspace/${name}`,
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = proc.stderr
      ? await new Response(proc.stderr).text()
      : "no stderr";
    throw new Error(`Failed to clone ${repo}: exit code ${exitCode} — ${stderr}`);
  }
  console.log(`[Workspace] Cloned ${repo}`);
}

/**
 * Inject skills from a source directory into a target .claude/skills/ directory.
 *
 * Discovers skill folders (directories containing SKILL.md) and copies the
 * entire folder — including code, examples, and any other files — into
 * targetSkillsDir/<skillName>/.
 *
 * @returns list of skill names injected
 */
export async function injectSkills(
  targetSkillsDir: string,
  skillsSourceDir: string = "/app/src/skills",
): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("*/SKILL.md").scan({ cwd: skillsSourceDir }),
  );

  for (const entry of entries) {
    const skillName = entry.split("/")[0];
    const srcDir = `${skillsSourceDir}/${skillName}`;
    const destDir = `${targetSkillsDir}/${skillName}`;
    // Copy the entire skill folder (SKILL.md + code, examples, etc.)
    const cp = Bun.spawn(["cp", "-r", srcDir, destDir]);
    const exitCode = await cp.exited;
    if (exitCode !== 0) {
      console.error(`[Workspace] Failed to copy skill ${skillName}`);
    }
  }

  const names = entries.map((e) => e.split("/")[0]);
  console.log(`[Workspace] Injected ${names.length} skills: ${names.join(", ")}`);
  return names;
}

/**
 * Check for an existing work branch (ticket/* or feedback/*) on the remote
 * and check it out if found.
 *
 * Must be called from within the repo working directory.
 *
 * @returns branch name if found and checked out, null otherwise
 */
export async function checkAndCheckoutWorkBranch(
  ticketUUID: string,
): Promise<string | null> {
  const prefixes = [`ticket/${ticketUUID}`, `feedback/${ticketUUID}`];

  for (const branch of prefixes) {
    const check = Bun.spawn(["git", "ls-remote", "--heads", "origin", branch]);
    const output = await new Response(check.stdout).text();
    const exitCode = await check.exited;

    if (exitCode === 0 && output.trim().length > 0) {
      console.log(`[Workspace] Found existing branch: ${branch}`);
      const checkout = Bun.spawn(["git", "checkout", branch]);
      const checkoutExit = await checkout.exited;
      if (checkoutExit !== 0) {
        // Branch doesn't exist locally — create tracking branch
        const track = Bun.spawn(["git", "checkout", "-b", branch, `origin/${branch}`]);
        await track.exited;
      }
      return branch;
    }
  }

  return null;
}

/**
 * Clone repos, inject skills, load plugins. Returns workspace layout.
 *
 * Project-lead: clones PE repo + target repos, cwd = PE repo, additionalDirs = targets.
 * Ticket-agent: clones target repos only, cwd = first target repo.
 */
export async function setupWorkspace(
  options: WorkspaceSetupOptions,
): Promise<WorkspaceResult> {
  const { repos, githubToken, roleConfig, phoneHome } = options;

  // 1. Set up .netrc
  if (githubToken) {
    console.log("[Workspace] Setting up .netrc for GitHub auth...");
    await setupNetrc(githubToken);
  }

  // 2. Determine repos to clone
  const reposToClone = [...repos];
  if (roleConfig.isProjectLead && !reposToClone.includes(roleConfig.peRepo)) {
    reposToClone.unshift(roleConfig.peRepo);
  }

  if (reposToClone.length === 0) {
    console.log("[Workspace] No repos configured — skipping clone");
    return { agentCwd: "/workspace", additionalDirs: [], plugins: [] };
  }

  // 3. Clone all repos in parallel
  await Promise.all(
    reposToClone.map(async (repo) => {
      await cloneRepo(repo);
      phoneHome(`clone_done repo=${repoName(repo)}`);
    }),
  );

  // 4. Determine workspace layout
  let agentCwd: string;
  let additionalDirs: string[];

  if (roleConfig.isProjectLead) {
    agentCwd = `/workspace/${repoName(roleConfig.peRepo)}`;
    additionalDirs = repos
      .filter((r) => r !== roleConfig.peRepo)
      .map((r) => `/workspace/${repoName(r)}`);
    console.log(
      `[Workspace] Project lead: cwd=${agentCwd} additionalDirs=${additionalDirs.join(",")}`,
    );
  } else {
    agentCwd = `/workspace/${repoName(repos[0])}`;
    additionalDirs = [];
    console.log(`[Workspace] Ticket agent: cwd=${agentCwd}`);
  }

  // 5. Inject skills (single code path for both roles)
  const targetSkillsDir = `${agentCwd}/.claude/skills`;
  try {
    await injectSkills(targetSkillsDir);
  } catch (err) {
    console.error("[Workspace] Skill injection failed (non-fatal):", err);
  }

  // 6. Load plugins
  let plugins: PluginPath[] = [];
  phoneHome("loading_plugins");
  try {
    plugins = await loadPlugins(agentCwd);
    if (plugins.length > 0) {
      phoneHome(
        `plugins_loaded count=${plugins.length} names=${plugins.map((p) => p.path.split("/").pop()).join(",")}`,
      );
    }
  } catch (err) {
    console.error("[Workspace] Plugin loading failed (non-fatal):", err);
    phoneHome("plugins_failed");
  }

  return { agentCwd, additionalDirs, plugins };
}
