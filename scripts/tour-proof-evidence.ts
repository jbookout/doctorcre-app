import { PDFDocument } from "pdf-lib";
import {
  parsePublicTourPacket,
  requireCurrentTourVersion,
  UnsupportedPublicTourPacketError,
} from "../src/ui/public-tour-packet.ts";
import type { ReleaseEvidence } from "./containing-release.ts";

type PacketInput = { kind: "json"; value: unknown } | { kind: "pdf"; value: Buffer };
type PacketEvidence = "json_current" | "json_legacy" | "pdf_current" | "pdf_legacy_or_missing" | "unreadable";
type Classification = { packets: PacketEvidence[] } & (
  | { status: "ready" }
  | { status: "insufficient_evidence"; reason: string }
);
async function inspect(input: PacketInput): Promise<{ category: PacketEvidence; reason?: string }> {
  try {
    if (input.kind === "json") {
      parsePublicTourPacket(input.value);
      return { category: "json_current" };
    }
    if (!input.value.length || input.value.length > 5_000_000) throw Error("PDF byte budget");
    const document = await PDFDocument.load(input.value, { updateMetadata: false });
    const versions = [
      [document.getSubject()?.match(/^Tour template (\S+)$/)?.[1], "PDF template"],
      [document.getProducer()?.match(/^CARR deterministic PDF renderer (\S+)$/)?.[1], "PDF renderer"],
      ...(document.getCreator()?.startsWith("CARR Tour Operations ")
        ? [[document.getCreator()?.match(/^CARR Tour Operations (\S+)$/)?.[1], "PDF renderer"]]
        : []),
    ];
    for (const [version, label] of versions) {
      try {
        requireCurrentTourVersion(version, label);
      } catch (error) {
        return {
          category: "pdf_legacy_or_missing",
          reason:
            error instanceof UnsupportedPublicTourPacketError
              ? error.message
              : `Missing or unsupported ${label} metadata`,
        };
      }
    }
    return { category: "pdf_current" };
  } catch (error) {
    return error instanceof UnsupportedPublicTourPacketError
      ? { category: "json_legacy", reason: error.message }
      : { category: "unreadable", reason: "Unreadable packet evidence" };
  }
}
export async function classifyTourEvidence(
  release: ReleaseEvidence,
  inputs: readonly PacketInput[],
): Promise<Classification> {
  const evidence = await Promise.all(inputs.map(inspect));
  const packets = evidence.map((item) => item.category);
  const rejected = evidence.find((item) => item.category !== "json_current" && item.category !== "pdf_current");
  if (release !== "containing")
    return { status: "insufficient_evidence", packets, reason: `${release} release evidence` };
  if (!inputs.length || rejected)
    return { status: "insufficient_evidence", packets, reason: rejected?.reason || "Missing packet evidence" };
  return { status: "ready", packets };
}
export class TourEvidenceError extends Error {
  readonly exitCode = 78;
}
export async function requireTourEvidence(release: ReleaseEvidence, inputs: readonly PacketInput[]) {
  const result = await classifyTourEvidence(release, inputs);
  if (result.status === "insufficient_evidence") throw new TourEvidenceError(result.reason);
  return result;
}
