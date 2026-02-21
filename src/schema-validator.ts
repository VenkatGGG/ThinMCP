import { Ajv, type ValidateFunction } from "ajv";
import type { ToolRecord } from "./catalog-store.js";

export class ToolInputValidator {
  private readonly ajv: Ajv;
  private readonly validatorByKey: Map<string, ValidateFunction>;

  public constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateSchema: false,
      allowUnionTypes: true,
    });
    this.validatorByKey = new Map();
  }

  public validate(tool: ToolRecord, args: Record<string, unknown> | undefined): void {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") {
      return;
    }

    const validator = this.getOrCreateValidator(tool);
    const payload = args ?? {};
    const valid = validator(payload);

    if (valid) {
      return;
    }

    const details =
      validator.errors && validator.errors.length > 0
        ? this.ajv.errorsText(validator.errors, { separator: "; " })
        : "Unknown validation error";

    throw new Error(
      `Input validation failed for ${tool.serverId}.${tool.toolName}: ${details}`,
    );
  }

  private getOrCreateValidator(tool: ToolRecord): ValidateFunction {
    const key = `${tool.serverId}:${tool.toolName}:${tool.snapshotHash}`;
    const existing = this.validatorByKey.get(key);
    if (existing) {
      return existing;
    }

    const compiled = this.ajv.compile(tool.inputSchema);
    this.validatorByKey.set(key, compiled);
    return compiled;
  }
}
