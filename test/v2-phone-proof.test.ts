import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
for (const fixture of ["pass", "fail"])
  test(`V2 phone proof CLI ${fixture} fixture`, async () => {
    const command = [
      "scripts/prove-v2-phone-accessibility.ts",
      "--expected-commit",
      "1111111111111111111111111111111111111111",
      "--fixture-case",
      fixture,
    ];
    if (fixture === "pass") {
      const result = await execute(process.execPath, command);
      assert.equal(JSON.parse(result.stdout).exitCode, 0);
    } else {
      await assert.rejects(execute(process.execPath, command), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && error.code === 1);
        return true;
      });
    }
  });
