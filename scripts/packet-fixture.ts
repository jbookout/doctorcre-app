import { readFile } from "node:fs/promises";

export async function packetFixturePdf(): Promise<Uint8Array> {
  return readFile(new URL("../test/fixtures/packet-parity/packet.pdf", import.meta.url));
}
