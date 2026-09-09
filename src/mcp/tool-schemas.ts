import { z } from "zod";

export const TOOL_NAMES = [
  "agent_start",
  "agent_list",
  "agent_status",
  "agent_output",
  "agent_continue",
  "agent_cancel",
  "repo_list",
  "repo_read",
  "repo_search",
  "session_list",
  "session_read",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export interface ToolAnnotationSet {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodTypeAny>;
  readonly annotations: ToolAnnotationSet;
}

/**
 * The complete, deliberately small MCP tool surface. There is no run_shell, arbitrary
 * executable, environment, model, sandbox-bypass, download, or delete-log tool: only these eleven.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "agent_start",
    description: "Start a new Codex or Claude Code task in an allowlisted local working directory.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]),
      cwd: z.string().min(1).describe("Absolute path to the working directory"),
      prompt: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "agent_list",
    description: "List bridge tasks, newest first, optionally filtered by provider or state.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]).optional(),
      state: z.enum(TASK_STATES).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_status",
    description: "Get the current status of one bridge task.",
    inputSchema: {
      taskId: z.string().min(1),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_output",
    description: "Read paginated, redacted output events for one bridge task.",
    inputSchema: {
      taskId: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_continue",
    description: "Continue a finished or waiting task's provider session with a follow-up message.",
    inputSchema: {
      taskId: z.string().min(1),
      message: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "agent_cancel",
    description: "Cancel a running bridge task. Cancelling a task that already finished is a no-op.",
    inputSchema: {
      taskId: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "repo_list",
    description:
      "List files and directories under an allowlisted path. Hides .git, node_modules, .env*, and build/cache directories.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path inside an allowlisted root"),
      depth: z.number().int().positive().max(5).optional(),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "repo_read",
    description: "Read a file's content by line range. Refuses .env files and binary files.",
    inputSchema: {
      path: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "repo_search",
    description: "Search for a literal substring across an allowlisted path, bounded to a result limit.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path inside an allowlisted root to search under"),
      query: z.string().min(1),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_list",
    description:
      "List Claude Code and Codex terminal sessions whose working directory is inside an allowlisted root. lastEventHint is a best-effort heuristic, not authoritative status.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_read",
    description: "Read the content of one Claude Code or Codex session, paginated.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]),
      sessionId: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
