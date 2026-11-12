// Shared Three.js scaffolding for the 3D views: renderer, camera, controls,
// lights, grid floor, DOM label projection, agent orbs and a render loop that
// only runs while the view is visible.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const accentHex = () => { const v = (getComputedStyle(document.documentElement).getPropertyValue('--lime') || '').trim(); return /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : 0xc8ff00; };
export const LIME = accentHex();
export const LIME_DIM = 0x4e6a00;
export const GLASS = 0x121a12;

export function createBase(container, { camera: camOpts = {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = '<svg></svg>';
  container.appendChild(overlay);
  const svg = overlay.querySelector('svg');

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x050705, 0.012);
  const camera = new THREE.PerspectiveCamera(camOpts.fov || 36, 1, 0.1, 500);
  camera.position.set(...(camOpts.position || [16, 13, 20]));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enablePan = camOpts.pan ?? false;
  controls.autoRotate = camOpts.autoRotate ?? true; controls.autoRotateSpeed = 0.5;
  controls.minDistance = 4; controls.maxDistance = 120;
  controls.target.set(...(camOpts.target || [0, 3, 0]));
  renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; });

  scene.add(new THREE.AmbientLight(0xaaffaa, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(10, 20, 10); scene.add(key);
  const rim = new THREE.PointLight(LIME, 40, 60); rim.position.set(0, 6, 0); scene.add(rim);

  const grid = new THREE.GridHelper(80, 40, 0x2a3a10, 0x18220c);
  grid.material.transparent = true; grid.material.opacity = 0.5;
  grid.position.y = -0.3;
  scene.add(grid);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-2, -2);
  renderer.domElement.addEventListener('pointermove', ev => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    base.pointerPx = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  });
  renderer.domElement.addEventListener('pointerleave', () => pointer.set(-2, -2));

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip hidden';
  overlay.appendChild(tooltip);

  let running = false, raf = 0;
  const tickers = new Set();
  const clock = new THREE.Clock();
  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    controls.update();
    for (const t of tickers) t(dt);
    renderer.render(scene, camera);
  }
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const v = new THREE.Vector3();
  function project(x, y, z) {
    v.set(x, y, z).project(camera);
    const w = container.clientWidth, h = container.clientHeight;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, behind: v.z > 1 };
  }

  function label(cls, html) {
    const el = document.createElement('div'); el.className = cls; el.innerHTML = html; overlay.appendChild(el); return el;
  }

  const base = {
    THREE, renderer, scene, camera, controls, overlay, svg, tooltip, raycaster, pointer, pointerPx: null, project, label, tickers, resize,
    show() { if (!running) { running = true; clock.start(); resize(); frame(); } },
    hide() { running = false; cancelAnimationFrame(raf); },
    cast(objects) { raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(objects, false); },
    showTip(text) { if (!base.pointerPx) return; tooltip.textContent = text; tooltip.classList.remove('hidden'); tooltip.style.left = base.pointerPx.x + 'px'; tooltip.style.top = base.pointerPx.y + 'px'; },
    hideTip() { tooltip.classList.add('hidden'); },
    dispose() { base.hide(); ro.disconnect(); renderer.dispose(); container.innerHTML = ''; },
  };
  return base;
}

/** Agents as glowing orbs with a DOM tag; they drift to a target when working. */
export function createAgentOrbs(base, { idleRadius = 9, idleHeight = 2 } = {}) {
  const orbs = new Map(); // key -> { mesh, tag, target, idleAngle }
  const geo = new THREE.SphereGeometry(0.28, 20, 20);
  function ensure(key, name) {
    let o = orbs.get(key);
    if (!o) {
      const mat = new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 1.6, roughness: 0.3 });
      const mesh = new THREE.Mesh(geo, mat);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending }));
      mesh.add(halo);
      base.scene.add(mesh);
      const tag = base.label('agent-tag', '');
      o = { mesh, tag, target: null, idleAngle: Math.random() * Math.PI * 2, name, until: 0 };
      mesh.position.set(Math.cos(o.idleAngle) * idleRadius, idleHeight + orbs.size * 0.8, Math.sin(o.idleAngle) * idleRadius);
      orbs.set(key, o);
    }
    if (name) { o.name = name; o.tag.textContent = name; }
    return o;
  }
  function goTo(key, name, pos, holdMs = 2500) {
    const o = ensure(key, name);
    o.target = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z);
    o.until = performance.now() + holdMs;
  }
  function setIdle(key, idle) { const o = orbs.get(key); if (o) o.mesh.material.emissiveIntensity = idle ? 0.5 : 1.6; }
  base.tickers.add(dt => {
    let i = 0;
    const now = performance.now();
    for (const o of orbs.values()) {
      if (o.target && now < o.until) {
        o.mesh.position.lerp(o.target, 1 - Math.pow(0.001, dt));
      } else {
        o.target = null;
        o.idleAngle += dt * 0.25;
        const idle = new THREE.Vector3(Math.cos(o.idleAngle) * idleRadius, idleHeight + i * 0.9 + Math.sin(now / 700 + i) * 0.2, Math.sin(o.idleAngle) * idleRadius);
        o.mesh.position.lerp(idle, 1 - Math.pow(0.02, dt));
      }
      const p = base.project(o.mesh.position.x, o.mesh.position.y + 0.5, o.mesh.position.z);
      o.tag.style.left = p.x + 'px'; o.tag.style.top = p.y + 'px'; o.tag.style.display = p.behind || !o.name ? 'none' : '';
      i++;
    }
  });
  return { ensure, goTo, setIdle, orbs, remove(key) { const o = orbs.get(key); if (!o) return; base.scene.remove(o.mesh); o.tag.remove(); orbs.delete(key); } };
}

export function topDir(path) {
  if (!path) return null;
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(0, i);
}
