import { InvalidArgumentError, Option } from "commander";
import {
  INSTALL_MODES,
  SCOPES,
  STRICTNESS_LEVELS,
  TARGET_IDS,
  type TargetId,
} from "@agentpack/schema";

/** Parse a comma-separated target list, validating each entry. */
export function parseTargetList(value: string): TargetId[] {
  const targets = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (targets.length === 0) throw new InvalidArgumentError("target list must not be empty");
  for (const target of targets) {
    if (!(TARGET_IDS as readonly string[]).includes(target)) {
      throw new InvalidArgumentError(
        `unknown target "${target}" (expected one of: ${TARGET_IDS.join(", ")})`,
      );
    }
  }
  return targets as TargetId[];
}

/** Parse a comma-separated plain string list (e.g. pack names). */
export function parseCommaList(value: string): string[] {
  const items = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (items.length === 0) throw new InvalidArgumentError("list must not be empty");
  return items;
}

export function strictnessOption(): Option {
  return new Option("--strictness <level>", "capability strictness").choices([
    ...STRICTNESS_LEVELS,
  ]);
}

export function scopeOption(): Option {
  return new Option("--scope <scope>", "install scope").choices([...SCOPES]);
}

export function modeOption(): Option {
  return new Option("--mode <mode>", "install mode").choices([...INSTALL_MODES]);
}

export function kimiPathStrategyOption(): Option {
  return new Option("--kimi-path-strategy <strategy>", "kimi path strategy").choices([
    "shared",
    "kimi",
  ]);
}

export function targetOption(): Option {
  return new Option("--target <target>", "single target").choices([...TARGET_IDS]);
}

/** Adapter options bag understood by the core (currently kimi only). */
export function adapterOptionsOf(options: { kimiPathStrategy?: string }): Record<string, unknown> {
  return options.kimiPathStrategy ? { pathStrategy: options.kimiPathStrategy } : {};
}
