export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathNotAllowedError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class IllegalTaskTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = "IllegalTaskTransitionError";
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyLimitError";
  }
}

export class PromptTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTooLargeError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class TaskNotResumableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotResumableError";
  }
}
