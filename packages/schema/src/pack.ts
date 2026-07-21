import { z } from "zod";
import { envValueSchema } from "./secrets.js";
import { targetIdSchema } from "./targets.js";

export const API_VERSION = "agentpack.dev/v1alpha1";

/** Pack / skill / instruction / hook identifier: lowercase, digits, hyphens. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAME_PATTERN, "must contain only lowercase letters, numbers and hyphens");

/* ------------------------------- MCP -------------------------------- */

export const mcpApprovalSchema = z
  .object({
    default: z.enum(["prompt", "always", "never"]),
  })
  .strict();
export type McpApproval = z.infer<typeof mcpApprovalSchema>;

export const mcpServerSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), envValueSchema).optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    passEnv: z.array(z.string().min(1)).optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    toolTimeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    approval: mcpApprovalSchema.optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === "stdio") {
      if (!server.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "stdio transport requires `command`",
        });
      }
      if (server.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "stdio transport must not set `url`",
        });
      }
    } else {
      if (!server.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${server.transport} transport requires \`url\``,
        });
      }
      if (server.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${server.transport} transport must not set \`command\``,
        });
      }
    }
  });
export type McpServerSpec = z.infer<typeof mcpServerSchema>;

/* ------------------------------ Hooks ------------------------------- */

export const HOOK_EVENTS = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "notification",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const hookSchema = z
  .object({
    id: nameSchema,
    event: z.enum(HOOK_EVENTS),
    matcher: z.string().optional(),
    command: z.array(z.string().min(1)).min(1),
    targets: z.array(targetIdSchema).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type HookSpec = z.infer<typeof hookSchema>;

/* --------------------------- Instructions --------------------------- */

export const instructionSchema = z
  .object({
    id: nameSchema,
    path: z.string().min(1),
    scope: z.enum(["global", "project", "directory"]).default("project"),
    /** Required when scope is "directory"; relative to the project root. */
    directory: z.string().optional(),
    priority: z.number().int().default(100),
    targets: z.array(targetIdSchema).optional(),
    mergeStrategy: z.enum(["managed-section", "append"]).default("managed-section"),
  })
  .strict()
  .superRefine((instruction, ctx) => {
    if (instruction.scope === "directory" && !instruction.directory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "directory scope requires `directory`",
      });
    }
  });
export type InstructionSpec = z.infer<typeof instructionSchema>;

/* ------------------------------ Plugin ------------------------------ */

export const pluginSchema = z
  .object({
    enabled: z.boolean().default(false),
    interface: z
      .object({
        displayName: z.string().optional(),
        shortDescription: z.string().optional(),
        longDescription: z.string().optional(),
        author: z.string().optional(),
        homepage: z.string().optional(),
        categories: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PluginSpec = z.infer<typeof pluginSchema>;

/* --------------------------- Pack manifest -------------------------- */

const targetToggleSchema = z.object({ enabled: z.boolean().default(true) }).strict();

export const packManifestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Pack"),
    metadata: z
      .object({
        name: nameSchema,
        version: z.string().min(1),
        description: z.string().optional(),
        license: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      })
      .strict(),
    spec: z
      .object({
        skills: z.array(z.object({ path: z.string().min(1) }).strict()).default([]),
        instructions: z.array(instructionSchema).default([]),
        mcpServers: z.record(nameSchema, mcpServerSchema).default({}),
        hooks: z.array(hookSchema).default([]),
        plugin: pluginSchema.optional(),
        targets: z.record(targetIdSchema, targetToggleSchema).optional(),
        /** Unknown fields per target are retained and passed to that adapter only. */
        extensions: z.record(targetIdSchema, z.record(z.string(), z.unknown())).optional(),
      })
      .strict(),
  })
  .strict();
export type PackManifest = z.infer<typeof packManifestSchema>;

/* ------------------------- Workspace manifest ------------------------ */

export const gitSourceSchema = z
  .object({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1).optional(),
    subdirectory: z.string().optional(),
  })
  .strict();
export type GitSource = z.infer<typeof gitSourceSchema>;

export const packSourceSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ source: gitSourceSchema }).strict(),
]);
export type PackSource = z.infer<typeof packSourceSchema>;

export const profileSchema = z
  .object({
    packs: z.array(z.string().min(1)).min(1),
    targets: z.array(targetIdSchema).min(1),
    scope: z.enum(["project", "user"]).default("project"),
    installMode: z.enum(["auto", "symlink", "copy"]).default("auto"),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

export const workspaceManifestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Workspace"),
    packs: z.array(packSourceSchema).default([]),
    profiles: z.record(z.string().min(1), profileSchema).default({}),
    /**
     * Gateway mode: instead of merging each MCP server into every target's
     * native config, targets get a single `agentpack` entry pointing at the
     * AgentPack MCP gateway, which fans out to the canonical servers.
     */
    gateway: z
      .object({
        enabled: z.boolean().default(false),
        name: nameSchema.default("agentpack"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
