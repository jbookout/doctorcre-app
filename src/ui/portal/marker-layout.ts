type Point = { x: number; y: number };
type MarkerBox = Point & { width: number; height: number };

export function layoutMarkers(markers: readonly MarkerBox[], viewport: { width: number; height: number }) {
  const placed: (MarkerBox & { anchor: Point })[] = [];
  for (const marker of markers) {
    const halfWidth = marker.width / 2;
    const halfHeight = marker.height / 2;
    const bound = (point: Point) => ({
      x: Math.max(halfWidth, Math.min(viewport.width - halfWidth, point.x)),
      y: Math.max(halfHeight, Math.min(viewport.height - halfHeight, point.y)),
    });
    const candidates = [bound(marker)];
    const columns = Array.from({ length: Math.max(0, Math.floor((viewport.width - 8) / (marker.width + 8))) }, (_, i) => halfWidth + 8 + i * (marker.width + 8));
    const rows = Array.from({ length: Math.max(0, Math.floor((viewport.height - 8) / (marker.height + 8))) }, (_, i) => halfHeight + 8 + i * (marker.height + 8));
    for (const y of rows) for (const x of columns) candidates.push({ x, y });
    candidates.sort((a, b) => Math.hypot(a.x - marker.x, a.y - marker.y) - Math.hypot(b.x - marker.x, b.y - marker.y));
    const centre = candidates.find(candidate => placed.every(previous =>
      Math.abs(candidate.x - previous.x) >= (marker.width + previous.width) / 2 + 8 ||
      Math.abs(candidate.y - previous.y) >= (marker.height + previous.height) / 2 + 8)) ?? bound(marker);
    placed.push({ ...marker, ...centre, anchor: { x: marker.x, y: marker.y } });
  }
  return placed;
}
