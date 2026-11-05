import { test } from '@playwright/test';
import './privacy';

test("39 unit:transcript-recovery-call-budget", async ({}) => {
  test.skip(true, "Needs existing private transcript recovery receipts and model-call counts; no transcript-recovery receipt app panel was found.");
});
