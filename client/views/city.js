// "Exploded 3D" tab: the whole repository laid out as a city. Directories are
// platforms, files are towers (height follows size). Agents fly to the tower
// they touch; a touched tower flashes.
import * as THREE from 'three';
import { createBase, createAgentOrbs, LIME } from './three-base.js';
import { layout } from '../layout.js';
import { roleOf } from '../roles.js';

export function createCity(container, { onSelect } = {}) {
  const base = createBase(container, { camera: { position: [30, 28, 30], target: [0, 0, 0], fov: 40, pan: true, autoRotate: false } });
  const orbs = createAgentOrbs(base, { idleRadius: 14, idleHeight: 6 });
  const group = new THREE.Group();
  base.scene.add(group);
  let files = null, fileBlocks = [], index = new Map(), dirMeshes = [], flash = new Map(), labelsOn = true, labels = [];
  const colorBase = new THREE.Color(0x4e7a00), colorHot = new THREE.Color(0xe8ff80), tmp = new THREE.Color();

  function build(state) {
    group.clear(); for (const l of labels) l.remove(); labels = []; index.clear(); dirMeshes = []; flash.clear();
    if (!state.tree) return;
    const blocks = layout(state.tree);
    const root = blocks.find(b => b.path === '') || blocks[0];
    const cx = root.x + root.w / 2, cz = root.z + root.d / 2;
    const dirs = blocks.filter(b => b.type === 'dir');
    fileBlocks = blocks.filter(b => b.type === 'file');

    // platforms
    const maxDepth = Math.max(1, ...dirs.map(d => d.depth));
    for (const d of dirs) {
      const h = 0.12;
      const m = new THREE.Mesh(new THREE.BoxGeometry(d.w, h, d.d), new THREE.MeshPhysicalMaterial({ color: 0x0f160f, transparent: true, opacity: 0.75, roughness: 0.3, metalness: 0.2, emissive: 0x0b1a05, emissiveIntensity: 0.4 + d.depth / maxDepth * 0.5 }));
      m.position.set(d.x + d.w / 2 - cx, -0.2 + d.depth * 0.14, d.z + d.d / 2 - cz);
      m.userData = { path: d.path, name: d.name, dir: true };
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: LIME, transparent: true, opacity: 0.25 + 0.4 / (1 + d.depth) }));
      m.add(edges);
      group.add(m); dirMeshes.push(m);
      if (d.depth <= 1) { const l = base.label('layer-label', ''); l.textContent = d.path === '' ? `${d.name}/` : `${d.name}/`; l.dataset.x = m.position.x; l.dataset.y = m.position.y + 0.3; l.dataset.z = d.z - cz - 0.2; labels.push(l); }
    }
    // files as one instanced mesh
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1, emissive: 0x6fa800, emissiveIntensity: 0.25 });
    files = new THREE.InstancedMesh(geo, mat, Math.max(1, fileBlocks.length));
    const m4 = new THREE.Matrix4();
    fileBlocks.forEach((b, i) => {
      const y = -0.2 + b.depth * 0.14 + b.h / 2;
      m4.compose(new THREE.Vector3(b.x + b.w / 2 - cx, y, b.z + b.d / 2 - cz), new THREE.Quaternion(), new THREE.Vector3(b.w * 0.7, b.h, b.d * 0.7));
      files.setMatrixAt(i, m4);
      files.setColorAt(i, colorBase);
      index.set(b.path, i);
    });
    files.instanceMatrix.needsUpdate = true; if (files.instanceColor) files.instanceColor.needsUpdate = true;
    group.add(files);
    // fit camera
    const span = Math.max(root.w, root.d);
    base.controls.target.set(0, 0, 0);
    base.camera.position.set(span * 0.9, span * 0.8, span * 0.9);
    base.controls.maxDistance = span * 4;
  }

  base.tickers.add(dt => {
    for (const l of labels) { const p = base.project(Number(l.dataset.x), Number(l.dataset.y), Number(l.dataset.z)); l.style.left = p.x + 'px'; l.style.top = p.y + 'px'; l.style.display = labelsOn && !p.behind ? '' : 'none'; }
    if (files && flash.size) {
      for (const [i, v] of flash) {
        const nv = v - dt * 0.35;
        tmp.copy(colorBase).lerp(colorHot, Math.max(0, nv));
        files.setColorAt(i, tmp);
        if (nv <= 0) flash.delete(i); else flash.set(i, nv);
      }
      files.instanceColor.needsUpdate = true;
    }
    const hits = base.cast([files, ...dirMeshes].filter(Boolean));
    const hit = hits[0];
    if (hit) {
      const u = hit.object === files ? fileBlocks[hit.instanceId] : hit.object.userData;
      base.showTip(u.dir ? `${u.path || u.name}/` : `${u.path} · ${u.size ?? 0} B`); container.style.cursor = 'pointer';
      container._hover = u.path;
    } else { base.hideTip(); container.style.cursor = ''; container._hover = null; }
  });
  base.renderer.domElement.addEventListener('click', () => { if (container._hover != null) onSelect?.(container._hover); });

  function posOf(path) {
    const i = index.get(path);
    if (i == null) return null;
    const m4 = new THREE.Matrix4(); files.getMatrixAt(i, m4);
    const p = new THREE.Vector3().setFromMatrixPosition(m4);
    p.y += 1.2;
    return p;
  }
  function pulse(path) {
    let i = index.get(path);
    if (i == null) { // a directory: flash all its files
      for (const [p, j] of index) if (p.startsWith(path + '/')) flash.set(j, 1);
      return posOf([...index.keys()].find(p => p.startsWith(path + '/')));
    }
    flash.set(i, 1.4);
    return posOf(path);
  }

  return {
    update(state) { build(state); for (const [key, a] of state.agents) { orbs.ensure(key, roleOf(a).name); orbs.setIdle(key, a.status !== 'active'); } },
    show(state) { base.show(); if (!files && state?.tree) build(state); },
    hide() { base.hide(); },
    resize() { base.resize(); },
    setLabels(on) { labelsOn = on; },
    pulse(path) { pulse(path); },
    agentEvent(e, a) { if (e.file) { const p = pulse(e.file); if (p) orbs.goTo(a.key, roleOf(a).name, p, 3000); } else orbs.ensure(a.key, roleOf(a).name); },
    focus(path) { const p = posOf(path) || pulse(path); if (p) base.controls.target.lerp(p, 0.7); },
    dispose() { base.dispose(); },
  };
}
