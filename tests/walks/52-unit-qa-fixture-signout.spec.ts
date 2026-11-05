import { test } from './privacy';

test("52 unit:qa-fixture-signout", async ({}) => {
  test.skip(true, "Sign out revokes the shared saved server session used by the other worker. Needs a separate designated test account/session, not Joe shared sign-in.");
});
