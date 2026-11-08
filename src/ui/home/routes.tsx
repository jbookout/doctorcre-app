import type { InboxItem } from "./inbox";
export const recordRoutes = {
  card: (id: string) => `/inbox/card/${encodeURIComponent(id)}`,
  source(item: InboxItem): string | null {
    const url = item.open_url;
    if (
      !url?.startsWith("/") ||
      url.startsWith("//") ||
      /[\\\s]/.test(url) ||
      Array.from(url).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    const parsed = new URL(url, "https://doctorcre.invalid");
    if (parsed.pathname === "/clients") {
      const records = parsed.searchParams.getAll("record");
      return records.length === 1 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(records[0] ?? "")
        ? url
        : null;
    }
    const supported = ["/deals", "/calls", "/updates", "/doc-chats"].includes(parsed.pathname);
    return parsed.origin === "https://doctorcre.invalid" && supported ? url : null;
  },
};
