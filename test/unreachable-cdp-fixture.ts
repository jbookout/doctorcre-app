import { startFixture } from "../scripts/fixture-http.mjs";

export async function unreachableCdpEndpoint(): Promise<string> {
  const reservation = await startFixture();
  const endpoint = reservation.origin;
  await reservation.close();
  return endpoint;
}
