import { test } from './privacy';

test("28 WR588.S2", async ({}) => {
  test.skip(true, "Native sent receipt is external to the app; cannot establish checksums and recipient-count equality from activity alone.");
});
