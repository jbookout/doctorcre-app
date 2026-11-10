export function mountTourClientDownload(
  parent: HTMLElement,
  inContext: <T>(operation: () => Promise<T>) => Promise<T>,
) {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = "Download PDF";
  const status = parent.ownerDocument.createElement("p");
  status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Preparing your PDF…";
    try {
      const response = await inContext(() =>
        fetch("/api/share/download", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (!response.ok || response.headers.get("content-type") !== "application/pdf") {
        status.textContent = "This link cannot download a PDF. Ask your broker for access or a reviewed packet.";
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = parent.ownerDocument.createElement("a");
      link.href = url;
      link.download = "Tour.pdf";
      parent.append(link);
      link.click();
      link.remove();
      // eslint-disable-next-line no-restricted-syntax -- One one-second cleanup timer releases the blob after the browser starts the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "PDF downloaded.";
    } catch {
      status.textContent = "The PDF could not be downloaded. Try again.";
    } finally {
      button.disabled = false;
    }
  });
  parent.append(button, status);
}
