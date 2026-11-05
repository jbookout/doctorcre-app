import { test } from '@playwright/test';
import './privacy';

test("48 unit:client-fit-charts", async ({}) => {
  test.skip(true, "Historical client fit consumes the full production cohort. Needs a designated test cohort with independently recorded win IDs.");
});
