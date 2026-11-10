import type { TestContext } from "node:test";
export declare function assertProofDeadlineCleanup(
  t: TestContext,
  options: { entry: string; args: string[]; mode: string; timeoutMs?: number },
): Promise<unknown>;
