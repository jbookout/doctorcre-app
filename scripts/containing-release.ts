import { execFile } from "node:child_process";

export type ReleaseEvidence = "containing" | "older" | "unrelated" | "unknown";

export async function classifyRelease(
  commit: string,
  observed: string,
  { signal, cwd }: { signal?: AbortSignal; cwd?: string } = {},
): Promise<ReleaseEvidence> {
  if (signal?.aborted) return "unknown";
  if (commit === observed) return "containing";
  const ancestor = (left: string, right: string) =>
    new Promise<boolean>((resolve, reject) =>
      execFile("git", ["merge-base", "--is-ancestor", left, right], { signal, cwd }, (error) => {
        if (!error) resolve(true);
        else if (error.code === 1) resolve(false);
        else reject(error);
      }),
    );
  try {
    if (await ancestor(commit, observed)) return "containing";
    return (await ancestor(observed, commit)) ? "older" : "unrelated";
  } catch {
    return "unknown";
  }
}
export async function requireContainingRelease(
  commit: string,
  observed: string,
  options: { signal?: AbortSignal; cwd?: string } = {},
): Promise<void> {
  const release = await classifyRelease(commit, observed, options);
  if (release !== "containing") throw Object.assign(Error(`${release} release evidence unavailable`), { exitCode: 78 });
}
