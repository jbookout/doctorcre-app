import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/portal/marker-layout.ts'], bundle: true, write: false, format: 'esm' });
const { layoutMarkers } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
test('nearby anchors get separated bounded labels and retain true stem anchors', () => {
  for (const width of [390, 1000]) {
    const markers = Array.from({ length: 6 }, (_, i) => ({ x: width / 2 + i % 2, y: 180, width: 110, height: 44 }));
    const placed = layoutMarkers(markers, { width, height: 360 });
    assert.deepEqual(placed, layoutMarkers(markers, { width, height: 360 }));
    for (const [i, point] of placed.entries()) {
      assert.ok(point.x >= 55 && point.x <= width - 55);
      assert.ok(point.y >= 22 && point.y <= 338);
      assert.deepEqual(point.anchor, { x: markers[i].x, y: markers[i].y });
      for (const previous of placed.slice(0, i)) assert.ok(Math.abs(previous.x - point.x) >= 118 || Math.abs(previous.y - point.y) >= 52);
    }
    assert.ok(placed.some(p => p.x !== p.anchor.x || p.y !== p.anchor.y));
  }
});
test('empty and saturated layouts terminate and retain every marker', () => {
  assert.deepEqual(layoutMarkers([], { width: 390, height: 360 }), []);
  assert.equal(layoutMarkers(Array.from({ length: 20 }, () => ({ x: 10, y: 10, width: 180, height: 44 })), { width: 200, height: 100 }).length, 20);
});
