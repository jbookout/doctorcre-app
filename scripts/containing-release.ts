import { execFile } from "node:child_process";

export async function requireContainingRelease(
  commit: string,
  observed: string,
  { signal, cwd }: { signal?: AbortSignal; cwd?: string } = {},
): Promise<void> {
  if (commit === observed) return;
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("git", ["merge-base", "--is-ancestor", commit, observed], { signal, cwd }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } catch {
    throw Object.assign(Error("Containing release evidence unavailable"), { exitCode: 78 });
  }
}
