import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

export function packetPdfCsp(): Plugin {
  return {
    name: "packet-pdf-csp",
    setup(build) {
      build.onLoad({ filter: /pdfjs-dist\/.*\/pdf\.mjs$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const before = 'style="fill:red;"';
        if (source.split(before).length !== 2) throw new Error("Review PDF.js SVG feature probe on upgrade");
        return { contents: source.replace(before, 'fill="red"'), loader: "js" };
      });
    },
  };
}
