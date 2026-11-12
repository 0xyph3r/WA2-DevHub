// Pure layout: a repo tree becomes blocks on a plane. Directories are
// platforms, files are towers whose height follows their size.
// Works in the browser and under node --test (no DOM, no Three).

const CELL = 1;      // footprint of one file
const GAP = 0.35;    // space between siblings
const PAD = 0.6;     // directory border

export function fileHeight(size) {
  return 0.3 + Math.log2(1 + (size || 0) / 512) * 0.45;
}

function measure(node) {
  if (node.type === 'file') return { w: CELL, d: CELL };
  const kids = node.children || [];
  if (kids.length === 0) return { w: CELL + 2 * PAD, d: CELL + 2 * PAD };
  const sizes = kids.map(measure);
  const cols = Math.ceil(Math.sqrt(kids.length));
  const colW = [], rowD = [];
  sizes.forEach((s, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] || 0, s.w);
    rowD[r] = Math.max(rowD[r] || 0, s.d);
  });
  const w = colW.reduce((a, b) => a + b, 0) + GAP * (colW.length - 1) + 2 * PAD;
  const d = rowD.reduce((a, b) => a + b, 0) + GAP * (rowD.length - 1) + 2 * PAD;
  node._m = { w, d, cols, colW, rowD, sizes };
  return { w, d };
}

function place(node, x, z, depth, out) {
  if (node.type === 'file') {
    out.push({ path: node.path, name: node.name, type: 'file', x, z, w: CELL, d: CELL, h: fileHeight(node.size), depth, size: node.size || 0 });
    return;
  }
  const m = node._m || { ...measure(node), ...node._m };
  const { w, d, cols, colW = [], rowD = [], sizes = [] } = node._m || m;
  out.push({ path: node.path, name: node.name, type: 'dir', x, z, w, d, h: 0.12, depth });
  const kids = node.children || [];
  let cz = z + PAD;
  for (let r = 0; r < rowD.length; r++) {
    let cx = x + PAD;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= kids.length) break;
      // centre each child inside its grid cell
      const s = sizes[i];
      place(kids[i], cx + (colW[c] - s.w) / 2, cz + (rowD[r] - s.d) / 2, depth + 1, out);
      cx += colW[c] + GAP;
    }
    cz += rowD[r] + GAP;
  }
  delete node._m;
}

/** Returns blocks {path,name,type,x,z,w,d,h,depth}. Origin is the root's corner. */
export function layout(tree) {
  const out = [];
  measure(tree);
  place(tree, 0, 0, 0, out);
  return out;
}
