export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly parameter?: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function unsupported(parameter: string, reason = "is not safely adaptable"): never {
  throw new AdapterError("unsupported_feature", `${parameter} ${reason}.`, parameter);
}

export function invalid(parameter: string, reason: string): never {
  throw new AdapterError("invalid_request", `${parameter} ${reason}.`, parameter);
}
