import { test } from '@playwright/test';
import './privacy';

test("45 WR591.S7", async ({}) => {
  test.skip(true, "Home week has no week navigation controls and meeting dialog has no deal link. Needs designated mixed-offset/all-day test calendar cohort and source instants.");
});
