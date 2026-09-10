import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeTask, Provider, TaskState } from "../domain/task.js";
import {
  BinaryFileError,
  ConcurrencyLimitError,
  FileTooLargeError,
  PathNotAllowedError,
  PromptTooLargeError,
  ProviderUnavailableError,
  TaskNotFoundError,
  TaskNotResumableError,
} from "../errors.js";
import type { AccessPolicy } from "../policy/files-policy.js";
import { listDirectory, readFileLines, searchRepo } from "../repo/repo-reader.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { EventLog } from "../store/event-log.js";
import type { TaskStore } from "../store/task-store.js";
import type { JobSupervisor } from "../supervisor/job-supervisor.js";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-schemas.js";

export interface RegisterToolsDeps {
  readonly supervisor: JobSupervisor;
  readonly taskStore: TaskStore;
  readonly eventLog: EventLog;
  readonly policy: AccessPolicy;
  readonly sessionStore: SessionStore;
}

/** Errors expected in normal operation: reported as a tool-level error, never an internal 500. */
const EXPECTED_ERROR_TYPES = [
  BinaryFileError,
  ConcurrencyLimitError,
  FileTooLargeError,
  PathNotAllowedError,
  PromptTooLargeError,
  ProviderUnavailableError,
  TaskNotFoundError,
  TaskNotResumableError,
];

function isExpectedError(error: unknown): error is Error {
  return EXPECTED_ERROR_TYPES.some((ctor) => error instanceof ctor);
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: Error): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error.message }] };
}

/** Extra context an MCP tool callback receives; only the auth info matters here. */
export interface ToolExtra {
  readonly authInfo?: AuthInfo;
}

/**
 * When no auth is wired at all (authInfo undefined — e.g. a loopback dev setup with no OAuth
 * configured), access is unrestricted. When a token IS present, it must actually carry the
 * scope: this is what makes a read-only token unable to call a write tool.
 */
function hasScope(extra: ToolExtra | undefined, scope: string): boolean {
  if (!extra?.authInfo) return true;
  return extra.authInfo.scopes.includes(scope);
}

function insufficientScope(scope: string): CallToolResult {
  return errorResult(new Error(`Insufficient scope: ${scope} required`));
}

/**
 * The only fields ever returned to a caller. Deliberately excludes prompt text (never stored
 * anyway), environment variables, and raw database rows — only a compact status summary.
 */
export interface TaskSummary {
  readonly taskId: string;
  readonly provider: Provider;
  readonly cwd: string;
  readonly state: TaskState;
  readonly parentId: string | null;
  readonly hasProviderSession: boolean;
  readonly exitCode: number | null;
  readonly errorSummary: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toSummary(task: BridgeTask): TaskSummary {
  return {
    taskId: task.id,
    provider: task.provider,
    cwd: task.cwd,
    state: task.state,
    parentId: task.parentId,
    hasProviderSession: task.providerSessionId !== null,
    exitCode: task.exitCode,
    errorSummary: task.errorSummary,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export interface AgentStartArgs {
  readonly provider: Provider;
  readonly cwd: string;
  readonly prompt: string;
}

export interface AgentListArgs {
  readonly provider?: Provider;
  readonly state?: TaskState;
  readonly limit?: number;
}

export interface AgentStatusArgs {
  readonly taskId: string;
}

export interface AgentOutputArgs {
  readonly taskId: string;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface AgentContinueArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface AgentCancelArgs {
  readonly taskId: string;
}

export interface RepoListArgs {
  readonly path: string;
  readonly depth?: number;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface RepoReadArgs {
  readonly path: string;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface RepoSearchArgs {
  readonly path: string;
  readonly query: string;
  readonly limit?: number;
}

export interface SessionListArgs {
  readonly provider?: "codex" | "claude";
  readonly limit?: number;
}

export interface SessionReadArgs {
  readonly provider: "codex" | "claude";
  readonly sessionId: string;
  readonly cursor?: number;
  readonly limit?: number;
}

/**
 * Pure handler implementations, independent of any MCP transport. Kept separate from
 * `registerTools` so behavior can be tested directly without spinning up a server or transport.
 */
export function createToolHandlers(deps: RegisterToolsDeps) {
  return {
    async agent_start(args: AgentStartArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:write")) return insufficientScope("agent:write");
      try {
        const task = await deps.supervisor.start(args);
        return jsonResult(toSummary(task));
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async agent_list(args: AgentListArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const tasks = deps.taskStore.list(args);
      return jsonResult({ tasks: tasks.map(toSummary) });
    },

    async agent_status(args: AgentStatusArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const task = deps.taskStore.get(args.taskId);
      if (!task) return errorResult(new TaskNotFoundError(args.taskId));
      return jsonResult(toSummary(task));
    },

    async agent_output(args: AgentOutputArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const task = deps.taskStore.get(args.taskId);
      if (!task) return errorResult(new TaskNotFoundError(args.taskId));
      const page = deps.eventLog.read(args.taskId, { cursor: args.cursor ?? 0, limit: args.limit ?? 50 });
      return jsonResult(page);
    },

    async agent_continue(args: AgentContinueArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:write")) return insufficientScope("agent:write");
      try {
        const child = await deps.supervisor.continue(args);
        return jsonResult(toSummary(child));
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async agent_cancel(args: AgentCancelArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:write")) return insufficientScope("agent:write");
      try {
        const task = deps.supervisor.cancel(args.taskId);
        return jsonResult(toSummary(task));
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async repo_list(args: RepoListArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await listDirectory(args.path, deps.policy.files, {
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async repo_read(args: RepoReadArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await readFileLines(args.path, deps.policy.files, {
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async repo_search(args: RepoSearchArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await searchRepo(args.path, deps.policy.files, args.query, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async session_list(args: SessionListArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const sessions = await deps.sessionStore.list({
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return jsonResult({ sessions });
    },

    async session_read(args: SessionReadArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const page = await deps.sessionStore.read(args.provider, args.sessionId, {
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return jsonResult(page);
    },
  } as const;
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

/** Registers all eleven tools, and no others, on the given MCP server. */
export function registerTools(server: McpServer, deps: RegisterToolsDeps): void {
  const handlers = createToolHandlers(deps);
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      // Each handler's args type matches its own schema; the registry only needs a uniform
      // callable, and every branch above is exercised directly by tool-handler unit tests.
      handlers[definition.name as ToolName] as (
        args: Record<string, unknown>,
        extra: ToolExtra,
      ) => Promise<CallToolResult>,
    );
  }
}
