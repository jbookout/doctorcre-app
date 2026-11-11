import { tourPacketPresentation } from "./fixtures/tour-packet/tour-packet-template.ts";

export function presentedPacket(stops: Parameters<typeof tourPacketPresentation>[0]) {
  return { stops, presentation: tourPacketPresentation(stops) };
}
