import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import {
  installService,
  serviceStatus,
  uninstallService,
  type CommandRunner,
} from "../src/index.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

interface RecordedCall {
  command: string;
  args: string[];
}

/** Runner that records calls; `failures` maps "cmd arg0" to an error. */
function fakeRunner(failures: Record<string, string> = {}, uid = "501") {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "id") return { stdout: `${uid}\n`, stderr: "" };
    if (command === "systemctl" && args[1] === "is-active") {
      return { stdout: "active\n", stderr: "" };
    }
    const key = `${command} ${args[0] ?? ""}`;
    if (failures[key]) throw new Error(failures[key]);
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

const CLI = "/usr/local/bin/agentpack";

describe("service (darwin)", () => {
  it("writes a launchd plist with the correct ProgramArguments and loads it", async () => {
    const home = path.join(tmp.dir, "home");
    const workspace = path.join(tmp.dir, "ws");
    const { calls, run } = fakeRunner();

    const info = await installService({
      workspaceRoot: workspace,
      cliPath: CLI,
      homeDir: home,
      platform: "darwin",
      run,
    });

    const plistPath = path.join(home, "Library", "LaunchAgents", "dev.agentpack.watch.plist");
    expect(info.filePath).toBe(plistPath);
    expect(info.installed).toBe(true);
    expect(info.running).toBe(true);
    expect(info.logPath).toBe(path.join(workspace, ".agentpack", "service.log"));

    const plist = await fs.readFile(plistPath, "utf8");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>dev.agentpack.watch</string>");
    for (const arg of [process.execPath, CLI, "watch", "--collect", "--workspace", workspace]) {
      expect(plist).toContain(`<string>${arg}</string>`);
    }
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(
      `<string>${path.join(workspace, ".agentpack", "service.log")}</string>`,
    );

    expect(calls).toContainEqual({
      command: "launchctl",
      args: ["bootstrap", "gui/501", plistPath],
    });
  });

  it("falls back to kickstart when bootstrap fails, then reports a warning", async () => {
    const home = path.join(tmp.dir, "home");
    const { calls, run } = fakeRunner({ "launchctl bootstrap": "already loaded" });

    const info = await installService({
      workspaceRoot: tmp.dir,
      cliPath: CLI,
      homeDir: home,
      platform: "darwin",
      run,
    });
    expect(info.running).toBe(true);
    expect(info.warning).toBeUndefined();
    expect(calls).toContainEqual({
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/dev.agentpack.watch"],
    });

    // When both fail the file is still reported, with a manual command.
    const { run: failing } = fakeRunner({
      "launchctl bootstrap": "nope",
      "launchctl kickstart": "nope",
    });
    const degraded = await installService({
      workspaceRoot: tmp.dir,
      cliPath: CLI,
      homeDir: home,
      platform: "darwin",
      run: failing,
    });
    expect(degraded.installed).toBe(true);
    expect(degraded.running).toBeUndefined();
    expect(degraded.warning).toContain("launchctl bootstrap gui/501");
  });

  it("status reflects the plist and launchctl print", async () => {
    const home = path.join(tmp.dir, "home");
    const missing = await serviceStatus({
      workspaceRoot: tmp.dir,
      homeDir: home,
      platform: "darwin",
      run: fakeRunner().run,
    });
    expect(missing.installed).toBe(false);
    expect(missing.running).toBeUndefined();

    await installService({
      workspaceRoot: tmp.dir,
      cliPath: CLI,
      homeDir: home,
      platform: "darwin",
      run: fakeRunner().run,
    });
    const running = await serviceStatus({
      workspaceRoot: tmp.dir,
      homeDir: home,
      platform: "darwin",
      run: fakeRunner().run,
    });
    expect(running.installed).toBe(true);
    expect(running.running).toBe(true);

    const notLoaded = await serviceStatus({
      workspaceRoot: tmp.dir,
      homeDir: home,
      platform: "darwin",
      run: fakeRunner({ "launchctl print": "not found" }).run,
    });
    expect(notLoaded.running).toBe(false);
  });

  it("uninstall bootouts (best-effort) and deletes the plist", async () => {
    const home = path.join(tmp.dir, "home");
    await installService({
      workspaceRoot: tmp.dir,
      cliPath: CLI,
      homeDir: home,
      platform: "darwin",
      run: fakeRunner().run,
    });
    const { calls, run } = fakeRunner({ "launchctl bootout": "not loaded" });
    await uninstallService({ workspaceRoot: tmp.dir, homeDir: home, platform: "darwin", run });
    expect(calls).toContainEqual({
      command: "launchctl",
      args: ["bootout", "gui/501/dev.agentpack.watch"],
    });
    await expect(
      fs.stat(path.join(home, "Library", "LaunchAgents", "dev.agentpack.watch.plist")),
    ).rejects.toThrow();
  });
});

describe("service (linux)", () => {
  it("writes a systemd user unit and enables it", async () => {
    const home = path.join(tmp.dir, "home");
    const workspace = path.join(tmp.dir, "ws");
    const { calls, run } = fakeRunner();

    const info = await installService({
      workspaceRoot: workspace,
      cliPath: CLI,
      homeDir: home,
      platform: "linux",
      run,
    });

    const unitPath = path.join(home, ".config", "systemd", "user", "agentpack-watch.service");
    expect(info.filePath).toBe(unitPath);
    expect(info.label).toBe("agentpack-watch");
    expect(info.running).toBe(true);

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unit).toContain(
      `ExecStart=${process.execPath} ${CLI} watch --collect --workspace ${workspace}`,
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");

    expect(calls).toContainEqual({ command: "systemctl", args: ["--user", "daemon-reload"] });
    expect(calls).toContainEqual({
      command: "systemctl",
      args: ["--user", "enable", "--now", "agentpack-watch"],
    });
  });

  it("uninstall disables (best-effort), deletes the unit and reloads", async () => {
    const home = path.join(tmp.dir, "home");
    await installService({
      workspaceRoot: tmp.dir,
      cliPath: CLI,
      homeDir: home,
      platform: "linux",
      run: fakeRunner().run,
    });
    const { calls, run } = fakeRunner({ "systemctl --user": "" });
    await uninstallService({ workspaceRoot: tmp.dir, homeDir: home, platform: "linux", run });
    expect(calls).toContainEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "agentpack-watch"],
    });
    await expect(
      fs.stat(path.join(home, ".config", "systemd", "user", "agentpack-watch.service")),
    ).rejects.toThrow();
  });
});
