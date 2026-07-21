import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDir, pathExists, writeFileAtomic } from "@agentpack/filesystem";
import { promises as fs } from "node:fs";

/**
 * Zero-input background operation: install `agentpack watch --collect` as a
 * per-user service (launchd on macOS, systemd --user on Linux). Never
 * requires sudo. Command execution goes through an injectable runner so
 * tests can exercise file generation without touching launchctl/systemctl.
 */

export interface ServiceInfo {
  platform: "darwin" | "linux";
  label: string;
  filePath: string;
  installed: boolean;
  running?: boolean;
  logPath: string;
  /**
   * Non-fatal problem encountered while (un)loading the service, including
   * the exact manual command the user can run instead.
   */
  warning?: string;
}

export interface ServiceOptions {
  workspaceRoot: string;
  /** Override $HOME (tests). */
  homeDir?: string;
  /** Override platform detection (tests). */
  platform?: "darwin" | "linux";
  /** Command runner (tests). Defaults to execFile. */
  run?: CommandRunner;
}

export interface InstallServiceOptions extends ServiceOptions {
  cliPath: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

const defaultRunner: CommandRunner = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15000 });
  return { stdout, stderr };
};

const DARWIN_LABEL = "dev.agentpack.watch";
const LINUX_LABEL = "agentpack-watch";

function resolvePlatform(opts: ServiceOptions): "darwin" | "linux" {
  const platform = opts.platform ?? (process.platform === "darwin" ? "darwin" : "linux");
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported platform for service install: ${process.platform}`);
  }
  return platform;
}

function homeDirOf(opts: ServiceOptions): string {
  const home = opts.homeDir ?? process.env.HOME;
  if (!home) throw new Error("cannot determine home directory for service install");
  return home;
}

function logPathOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agentpack", "service.log");
}

function serviceFilePath(platform: "darwin" | "linux", homeDir: string): string {
  return platform === "darwin"
    ? path.join(homeDir, "Library", "LaunchAgents", `${DARWIN_LABEL}.plist`)
    : path.join(homeDir, ".config", "systemd", "user", `${LINUX_LABEL}.service`);
}

function labelOf(platform: "darwin" | "linux"): string {
  return platform === "darwin" ? DARWIN_LABEL : LINUX_LABEL;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serviceArgs(opts: InstallServiceOptions): string[] {
  // When the CLI is a compiled single-file binary, cliPath === execPath and
  // the binary itself is the launcher — don't prefix it with a runtime.
  const launcher =
    opts.cliPath === process.execPath ? [opts.cliPath] : [process.execPath, opts.cliPath];
  return [...launcher, "watch", "--collect", "--workspace", opts.workspaceRoot];
}

function darwinPlist(opts: InstallServiceOptions, logPath: string): string {
  const args = serviceArgs(opts);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${DARWIN_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n")}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function linuxUnit(opts: InstallServiceOptions): string {
  const execStart = serviceArgs(opts).join(" ");
  return `[Unit]
Description=AgentPack watch (collect + sync)

[Service]
ExecStart=${execStart}
Restart=always

[Install]
WantedBy=default.target
`;
}

/** Numeric uid via `id -u`, falling back to process.getuid(). */
async function currentUid(run: CommandRunner): Promise<string> {
  try {
    const { stdout } = await run("id", ["-u"]);
    const uid = stdout.trim();
    if (uid) return uid;
  } catch {
    /* fall through */
  }
  if (typeof process.getuid === "function") return String(process.getuid());
  throw new Error("cannot determine uid for launchctl (run `id -u` manually)");
}

/**
 * Install the watch service for this platform and load it. Loading is
 * best-effort: on failure the file is still reported as written and the
 * warning carries the exact manual command.
 */
export async function installService(opts: InstallServiceOptions): Promise<ServiceInfo> {
  const run = opts.run ?? defaultRunner;
  const platform = resolvePlatform(opts);
  const homeDir = homeDirOf(opts);
  const filePath = serviceFilePath(platform, homeDir);
  const logPath = logPathOf(opts.workspaceRoot);
  const info: ServiceInfo = {
    platform,
    label: labelOf(platform),
    filePath,
    installed: true,
    logPath,
  };

  await ensureDir(path.dirname(filePath));
  await ensureDir(path.dirname(logPath));
  await writeFileAtomic(
    filePath,
    platform === "darwin" ? darwinPlist(opts, logPath) : linuxUnit(opts),
  );

  // Test escape hatch: write the unit file but never touch launchctl/systemctl.
  if (process.env.AGENTPACK_SERVICE_SKIP_LOAD === "1") {
    info.warning = "AGENTPACK_SERVICE_SKIP_LOAD set — service file written but not loaded";
    return info;
  }

  if (platform === "darwin") {
    const uid = await currentUid(run);
    const bootstrap = `launchctl bootstrap gui/${uid} ${filePath}`;
    try {
      await run("launchctl", ["bootstrap", `gui/${uid}`, filePath]);
      info.running = true;
    } catch {
      // Already loaded (or bootstrap unsupported) — poke it instead.
      try {
        await run("launchctl", ["kickstart", "-k", `gui/${uid}/${DARWIN_LABEL}`]);
        info.running = true;
      } catch (error) {
        info.warning =
          `service file written but launchctl failed: ${(error as Error).message}\n` +
          `load it manually with:\n  ${bootstrap}\n  launchctl kickstart -k gui/${uid}/${DARWIN_LABEL}`;
      }
    }
  } else {
    const enable = `systemctl --user enable --now ${LINUX_LABEL}`;
    try {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", LINUX_LABEL]);
      info.running = true;
    } catch (error) {
      info.warning =
        `service file written but systemctl failed: ${(error as Error).message}\n` +
        `load it manually with:\n  systemctl --user daemon-reload\n  ${enable}`;
    }
  }
  return info;
}

/** Unload (best-effort) and delete the service file. */
export async function uninstallService(opts: ServiceOptions): Promise<void> {
  const run = opts.run ?? defaultRunner;
  const platform = resolvePlatform(opts);
  const filePath = serviceFilePath(platform, homeDirOf(opts));

  if (platform === "darwin") {
    const uid = await currentUid(run);
    await run("launchctl", ["bootout", `gui/${uid}/${DARWIN_LABEL}`]).catch(() => undefined);
  } else {
    await run("systemctl", ["--user", "disable", "--now", LINUX_LABEL]).catch(() => undefined);
  }
  await fs.rm(filePath, { force: true });
  if (platform === "linux") {
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
}

/** Report whether the service file exists and the service is loaded. */
export async function serviceStatus(opts: ServiceOptions): Promise<ServiceInfo> {
  const run = opts.run ?? defaultRunner;
  const platform = resolvePlatform(opts);
  const filePath = serviceFilePath(platform, homeDirOf(opts));
  const info: ServiceInfo = {
    platform,
    label: labelOf(platform),
    filePath,
    installed: await pathExists(filePath),
    logPath: logPathOf(opts.workspaceRoot),
  };
  if (!info.installed) return info;

  if (platform === "darwin") {
    try {
      const uid = await currentUid(run);
      await run("launchctl", ["print", `gui/${uid}/${DARWIN_LABEL}`]);
      info.running = true;
    } catch {
      info.running = false;
    }
  } else {
    try {
      const { stdout } = await run("systemctl", ["--user", "is-active", LINUX_LABEL]);
      info.running = stdout.trim() === "active";
    } catch {
      info.running = false;
    }
  }
  return info;
}
