import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = "/js/ui-packet-worker.js";
export function packetDownloadPath(job: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job))
    throw new Error("Choose a rendered packet from Tours.");
  return `/api/tours/pdf/download?render_job_id=${encodeURIComponent(job)}`;
}

export async function mountPacketPreview(root: HTMLElement, job: string): Promise<() => void> {
  const controller = new AbortController();
  let disposed = false;
  let loading: ReturnType<typeof getDocument> | undefined;
  const dispose = () => {
    disposed = true;
    controller.abort();
    if (loading) void loading.destroy();
    root.replaceChildren();
  };
  addEventListener("pagehide", dispose, { once: true });
  try {
    const path = packetDownloadPath(job);
    const response = await fetch(path, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/pdf")
      throw new Error("This packet is unavailable. Return to Tours and refresh.");
    const blob = await response.arrayBuffer();
    if (disposed) return dispose;
    const download = document.createElement("a");
    download.href = path;
    download.textContent = "Download this PDF";
    root.replaceChildren(download);
    loading = getDocument({ data: new Uint8Array(blob) });
    const pdf = await loading.promise;
    if (disposed) return dispose;
    if (pdf.numPages > 50) throw new Error("Packet exceeds the preview page limit.");
    // eslint-disable-next-line no-restricted-syntax -- Limit rendering to 50 stored pages without network pagination or retries.
    for (let n = 1; n <= pdf.numPages; n++) {
      if (disposed) break;
      const page = await pdf.getPage(n);
      if (disposed) break;
      const base = page.getViewport({ scale: 1 });
      const scale = (Math.min(2, devicePixelRatio || 1) * Math.max(280, root.clientWidth)) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Packet page ${n} of ${pdf.numPages}`);
      const section = document.createElement("section");
      const zoom = document.createElement("button");
      zoom.type = "button";
      zoom.textContent = "Zoom in";
      zoom.setAttribute("aria-pressed", "false");
      const scroller = document.createElement("div");
      scroller.className = "packet-page";
      zoom.addEventListener("click", () => {
        const enlarged = zoom.getAttribute("aria-pressed") !== "true";
        zoom.setAttribute("aria-pressed", String(enlarged));
        zoom.textContent = enlarged ? "Fit page" : "Zoom in";
        scroller.dataset.zoom = enlarged ? "2" : "1";
      });
      scroller.append(canvas);
      section.append(zoom, scroller);
      root.append(section);
      await page.render({ canvas, viewport }).promise;
      canvas.dataset.rendered = "true";
      const content = await page.getTextContent();
      if (disposed) break;
      const text = document.createElement("details"),
        summary = document.createElement("summary"),
        body = document.createElement("p");
      summary.textContent = "Read page text";
      body.textContent = content.items
        .filter((item) => "str" in item)
        .map((item) => item.str)
        .join("\n");
      text.append(summary, body);
      section.append(text);
    }
  } catch (error) {
    if (!disposed) root.textContent = error instanceof Error ? error.message : "Packet unavailable.";
  }
  return () => {
    removeEventListener("pagehide", dispose);
    dispose();
  };
}

const root = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("#packet-preview");
if (root) void mountPacketPreview(root, new URLSearchParams(location.search).get("render_job_id") || "");
