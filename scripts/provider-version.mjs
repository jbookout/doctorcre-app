const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function uploadedVersionId(output) {
  const matches = [...String(output).matchAll(new RegExp(`Worker Version ID:\\s*(${UUID})`, "ig"))];
  if (matches.length !== 1) throw new Error("Cloudflare returned no unique Worker Version ID");
  return matches[0][1].toLowerCase();
}
