type Revision = { revision_id: string; revision_number: number; content: Record<string, unknown> };
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function sheetHistory(value: unknown): Revision[] {
  if (!record(value) || !Array.isArray(value.revisions) || value.revisions.length > 100)
    throw new Error("history_invalid");
  return value.revisions.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.revision_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.revision_id) ||
      typeof item.revision_number !== "number" ||
      !Number.isSafeInteger(item.revision_number) ||
      item.revision_number < 1 ||
      !record(item.content)
    )
      throw new Error("history_invalid");
    return { revision_id: item.revision_id, revision_number: item.revision_number, content: item.content };
  });
}

export function generatedSheet(content: unknown): string {
  return record(content) && typeof content.generated_itinerary === "string" ? content.generated_itinerary : "";
}

export function appendSheetSections(output: HTMLElement, generated: string): void {
  const blocks = generated.split("\n\n").filter(Boolean);
  for (const block of blocks.slice(3).filter((block) => block !== "Not on the active itinerary")) {
    const section = output.ownerDocument.createElement("section");
    section.className = "sheet-property";
    const [title, ...lines] = block.split("\n");
    const heading = output.ownerDocument.createElement("h2");
    heading.textContent = title || "Property";
    const facts = output.ownerDocument.createElement("pre");
    facts.textContent = lines.join("\n");
    section.append(heading, facts);
    output.append(section);
  }
}
