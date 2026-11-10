import type { TestContext } from "node:test";

export function temporaryDirectory(prefix: string, owner?: Pick<TestContext, "after">): string;
