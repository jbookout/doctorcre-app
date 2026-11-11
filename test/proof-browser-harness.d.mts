import type { TestContext } from "node:test";
export declare function assertProofDeadlineCleanup(
  t: TestContext,
  options: {
    entry: string;
    args: string[];
    mode: string;
    timeoutMs?: number;
    acquisitionDelayMs?: number;
    evaluationTarget?: "page" | "locator" | "locatorAll";
  },
): Promise<{ code: number; stdout: string; stderr: string }>;
export declare function ownedBrowserProcesses(root: string, ownerPid?: number): number[];
