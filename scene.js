'use strict';
// ═══════════════════════════════════════════════════════
//  SCENE.JS  —  Three.js setup, object CRUD, orbit camera
// ═══════════════════════════════════════════════════════

// ── RENDERER ──────────────────────────────────────────
const CV = document.getElementById('three');
const renderer = new THREE.WebGLRenderer({ canvas: CV, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0, 0); // fully transparent

const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);

// Orbit state
const ORB = { th: 0.55, ph: 0.82, r: 12, tx: 0, ty: 0, tz: 0 };

function syncCam() {
  const { th, ph, r, tx, ty, tz } = ORB;
  cam3d.position.set(
    tx + r * Math.sin(ph) * Math.sin(th),
    ty + r * Math.cos(ph),
    tz + r * Math.sin(ph) * Math.cos(th)
  );
  cam3d.lookAt(tx, ty, tz);
}
syncCam();

// ── LIGHTS ────────────────────────────────────────────
const ambLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
sunLight.position.set(6, 12, 6);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0x8899ff, 0.35);
fillLight.position.set(-5, -3, -5);
scene.add(fillLight);

const movingPt = new THREE.PointLight(0xffffff, 0.2, 30);
movingPt.position.set(0, 5, 0);
scene.add(movingPt);

// ── GROUND GRID ───────────────────────────────────────
const gridHelper = new THREE.GridHelper(26, 26, 0x222233, 0x111122);
gridHelper.material.opacity = 0.55;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// Invisible ground for ray hits
const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.name = 'ground';
scene.add(groundMesh);

// ── RAYCASTER ─────────────────────────────────────────
const RAY = new THREE.Raycaster();

// ── GEOMETRY FACTORY ─────────────────────────────────
function makeGeo(shape, sz) {
  switch (shape) {
    case 'box':      return new THREE.BoxGeometry(sz, sz, sz);
    case 'sphere':   return new THREE.SphereGeometry(sz * 0.6, 32, 32);
    case 'cylinder': return new THREE.CylinderGeometry(sz*0.48, sz*0.48, sz*1.2, 32);
    case 'cone':     return new THREE.ConeGeometry(sz*0.5, sz*1.2, 32);
    case 'torus':    return new THREE.TorusGeometry(sz*0.5, sz*0.18, 16, 60);
    case 'tetra':    return new THREE.TetrahedronGeometry(sz*0.7);
    default:         return new THREE.BoxGeometry(sz, sz, sz);
  }
}

function makeMat(color) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.2,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
}

// ── OBJECT STATE ──────────────────────────────────────
const OBJS = [];     // all meshes
let SEL = null;      // currently selected mesh
let OBJ_CTR = 0;
const UNDO_STACK = [];

// ── SPAWN ─────────────────────────────────────────────
function spawnAt(pos, shape, color, sz) {
  shape = shape || APP.shape;
  color = color || APP.color;
  sz    = sz    || APP.sz;

  const geo  = makeGeo(shape, sz);
  const mat  = makeMat(color);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = {
    id: ++OBJ_CTR,
    shape, color,
    label: shape[0].toUpperCase() + shape.slice(1) + ' ' + OBJ_CTR,
  };

  // Selection box (invisible until selected)
  const bbox = new THREE.BoxHelper(mesh, 0xffffff);
  bbox.material.transparent = true;
  bbox.material.opacity = 0;
  scene.add(bbox);
  mesh.userData.bbox = bbox;

  scene.add(mesh);
  OBJS.push(mesh);
  UNDO_STACK.push({ type: 'add', mesh });

  popIn(mesh);
  selectMesh(mesh);
  refreshSceneList();
  toast(mesh.userData.label + ' placed', 's');
  return mesh;
}

function popIn(mesh) {
  const from = new THREE.Vector3(0.01, 0.01, 0.01);
  const to   = new THREE.Vector3(1, 1, 1);
  const t0 = Date.now();
  mesh.scale.copy(from);
  (function tick() {
    const p = Math.min((Date.now() - t0) / 270, 1);
    const e = 1 - Math.pow(1 - p, 3);
    mesh.scale.lerpVectors(from, to, e);
    if (p < 1) requestAnimationFrame(tick);
  })();
}

// Place at screen center
function placeCenter() {
  RAY.setFromCamera(new THREE.Vector2(0, 0), cam3d);
  const hits = RAY.intersectObject(groundMesh);
  const pos = hits.length
    ? hits[0].point.clone().setY(APP.sz * 0.5)
    : new THREE.Vector3(0, APP.sz * 0.5, 0);
  spawnAt(pos);
}

// ── SELECT / DESELECT ─────────────────────────────────
function selectMesh(mesh) {
  if (SEL && SEL !== mesh) {
    if (SEL.userData.bbox) SEL.userData.bbox.material.opacity = 0;
    SEL.material.emissive && SEL.material.emissive.set(0, 0, 0);
    SEL.material.emissiveIntensity = 0;
  }
  SEL = mesh;
  if (mesh) {
    if (mesh.userData.bbox) mesh.userData.bbox.material.opacity = 0.25;
    mesh.material.emissiveIntensity = 0.08;
    mesh.material.emissive = mesh.material.color.clone().multiplyScalar(0.3);
    updateTF(mesh);
    highlightListItem(mesh.userData.id);
  } else {
    highlightListItem(null);
    clearTF();
  }
}

// ── DELETE ────────────────────────────────────────────
function delSel() {
  if (!SEL) { toast('Nothing selected', 'w'); return; }
  const m = SEL;
  if (m.userData.bbox) scene.remove(m.userData.bbox);
  scene.remove(m);
  m.geometry.dispose(); m.material.dispose();
  OBJS.splice(OBJS.indexOf(m), 1);
  SEL = null;
  refreshSceneList(); clearTF();
  toast('Deleted', 'w');
}

function deleteById(id) {
  const m = OBJS.find(o => o.userData.id === id);
  if (m) { selectMesh(m); delSel(); }
}

// ── DUPLICATE ─────────────────────────────────────────
function duplicate() {
  if (!SEL) { toast('Nothing selected', 'w'); return; }
  const src = SEL;
  const mesh = new THREE.Mesh(src.geometry.clone(), src.material.clone());
  mesh.position.copy(src.position).add(new THREE.Vector3(0.9, 0, 0.9));
  mesh.rotation.copy(src.rotation);
  mesh.scale.copy(src.scale);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData = {
    ...src.userData, id: ++OBJ_CTR,
    label: src.userData.shape[0].toUpperCase() + src.userData.shape.slice(1) + ' ' + OBJ_CTR,
  };
  const bbox = new THREE.BoxHelper(mesh, 0xffffff);
  bbox.material.transparent = true; bbox.material.opacity = 0;
  scene.add(bbox); mesh.userData.bbox = bbox;
  scene.add(mesh); OBJS.push(mesh);
  selectMesh(mesh); refreshSceneList();
  toast(mesh.userData.label + ' duplicated', 's');
}

// ── CLEAR / UNDO ──────────────────────────────────────
function clearAll() {
  OBJS.forEach(m => {
    if (m.userData.bbox) scene.remove(m.userData.bbox);
    scene.remove(m); m.geometry.dispose(); m.material.dispose();
  });
  OBJS.length = 0; SEL = null; OBJ_CTR = 0;
  refreshSceneList(); clearTF(); toast('Scene cleared', 'w');
}

function doUndo() {
  if (!UNDO_STACK.length) { toast('Nothing to undo', 'w'); return; }
  const a = UNDO_STACK.pop();
  if (a.type === 'add') {
    if (a.mesh.userData.bbox) scene.remove(a.mesh.userData.bbox);
    scene.remove(a.mesh); a.mesh.geometry.dispose(); a.mesh.material.dispose();
    OBJS.splice(OBJS.indexOf(a.mesh), 1);
    if (SEL === a.mesh) { SEL = null; clearTF(); }
    refreshSceneList(); toast('Undone', 'i');
  }
}

// ── FOCUS ─────────────────────────────────────────────
function focusSel() {
  if (!SEL) return;
  ORB.tx = SEL.position.x;
  ORB.ty = SEL.position.y;
  ORB.tz = SEL.position.z;
  ORB.r = 4.5;
  syncCam();
}

// ── MATERIAL UPDATES ─────────────────────────────────
function setSelColor(c) {
  APP.color = c;
  document.querySelectorAll('.color').forEach(el =>
    el.classList.toggle('on', el.dataset.c === c));
  if (SEL) {
    SEL.material.color.set(c);
    SEL.material.emissive.set(new THREE.Color(c).multiplyScalar(0.3));
    SEL.userData.color = c;
    refreshSceneList();
  }
}

// ── SCENE LIST (DOM) ──────────────────────────────────
function refreshSceneList() {
  const el = document.getElementById('scl');
  const cnt = document.getElementById('ocnt');
  const sobjct = document.getElementById('sobjct');
  if (cnt) cnt.textContent = OBJS.length;
  if (sobjct) sobjct.textContent = OBJS.length;
  if (!el) return;
  if (!OBJS.length) {
    el.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.2);padding:4px 2px">Empty</div>';
    return;
  }
  el.innerHTML = OBJS.map(o => `
    <div class="scene-item${SEL === o ? ' on' : ''}" onclick="selectById(${o.userData.id})" data-id="${o.userData.id}">
      <div class="scene-dot" style="background:${o.userData.color}"></div>
      <span>${o.userData.label}</span>
      <span class="scene-del" onclick="event.stopPropagation();deleteById(${o.userData.id})">✕</span>
    </div>`).join('');
}

function selectById(id) {
  const m = OBJS.find(o => o.userData.id === id);
  if (m) { selectMesh(m); refreshSceneList(); }
}

function highlightListItem(id) {
  document.querySelectorAll('.scene-item').forEach(el =>
    el.classList.toggle('on', +el.dataset.id === id));
}

// ── TRANSFORM DISPLAY ─────────────────────────────────
function updateTF(m) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('tfx',  m.position.x.toFixed(1));
  set('tfy',  m.position.y.toFixed(1));
  set('tfz',  m.position.z.toFixed(1));
  set('tfry', (m.rotation.y * 180 / Math.PI).toFixed(0) + '°');
  set('tfsx', m.scale.x.toFixed(2));
  set('tfsy', m.scale.y.toFixed(2));
}
function clearTF() {
  ['tfx','tfy','tfz','tfry','tfsx','tfsy'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  });
}

// ── MOUSE ORBIT/DRAG FALLBACK ─────────────────────────
const MOUSE = { down: false, btn: -1, lx: 0, ly: 0, draggingObj: false };

CV.addEventListener('mousedown', e => {
  if (e.button === 2 || e.button === 1) {
    MOUSE.down = true; MOUSE.btn = e.button;
    MOUSE.lx = e.clientX; MOUSE.ly = e.clientY;
    return;
  }
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = -(e.clientY / innerHeight) * 2 + 1;
  RAY.setFromCamera(new THREE.Vector2(nx, ny), cam3d);
  const hits = RAY.intersectObjects(OBJS, false);
  if (hits.length) {
    selectMesh(hits[0].object); refreshSceneList();
    MOUSE.down = true; MOUSE.btn = 0; MOUSE.draggingObj = true;
    MOUSE.lx = e.clientX; MOUSE.ly = e.clientY;
  } else {
    if (APP.mode === 'create') {
      const gh = RAY.intersectObject(groundMesh);
      if (gh.length) spawnAt(gh[0].point.clone().setY(APP.sz * 0.5));
    } else {
      selectMesh(null); refreshSceneList();
    }
  }
});

CV.addEventListener('mousemove', e => {
  if (!MOUSE.down) return;
  const dx = e.clientX - MOUSE.lx;
  const dy = e.clientY - MOUSE.ly;
  if (MOUSE.btn === 2) {
    ORB.th -= dx * 0.006;
    ORB.ph  = Math.max(0.06, Math.min(Math.PI - 0.06, ORB.ph + dy * 0.006));
    syncCam();
  } else if (MOUSE.btn === 1) {
    const right = new THREE.Vector3()
      .crossVectors(cam3d.getWorldDirection(new THREE.Vector3()), cam3d.up).normalize();
    ORB.tx -= right.x * dx * 0.016; ORB.ty += dy * 0.016; ORB.tz -= right.z * dx * 0.016;
    syncCam();
  } else if (MOUSE.btn === 0 && MOUSE.draggingObj && SEL) {
    const nx = (e.clientX / innerWidth) * 2 - 1;
    const ny = -(e.clientY / innerHeight) * 2 + 1;
    RAY.setFromCamera(new THREE.Vector2(nx, ny), cam3d);
    if (APP.tm === 'move') {
      const gh = RAY.intersectObject(groundMesh);
      if (gh.length) { SEL.position.x = gh[0].point.x; SEL.position.z = gh[0].point.z; }
    } else if (APP.tm === 'rotate') {
      SEL.rotation.y += dx * 0.013;
    } else if (APP.tm === 'scale') {
      SEL.scale.multiplyScalar(Math.max(0.05, 1 - dy * 0.007));
    }
    if (SEL.userData.bbox) SEL.userData.bbox.update();
    updateTF(SEL);
  }
  MOUSE.lx = e.clientX; MOUSE.ly = e.clientY;
});

CV.addEventListener('mouseup', () => { MOUSE.down = false; MOUSE.btn = -1; MOUSE.draggingObj = false; });
CV.addEventListener('contextmenu', e => e.preventDefault());
CV.addEventListener('wheel', e => {
  ORB.r = Math.max(1.5, Math.min(60, ORB.r + e.deltaY * 0.012));
  syncCam();
}, { passive: true });

// ── SAVE / LOAD ───────────────────────────────────────
const SAVED_KEY = 'air3d_v4';
let savedModels = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');

function openSave()  { document.getElementById('savedlg').classList.add('open'); refreshSaved(); }
function closeSave() { document.getElementById('savedlg').classList.remove('open'); }

function doSave() {
  const name = (document.getElementById('mname').value || '').trim() || 'My Model';
  const entry = {
    id: Date.now(), name, date: new Date().toLocaleDateString(),
    objs: OBJS.map(m => ({
      shape: m.userData.shape, color: m.userData.color, label: m.userData.label,
      pos: [m.position.x, m.position.y, m.position.z],
      rot: [m.rotation.x, m.rotation.y, m.rotation.z],
      sc:  [m.scale.x,    m.scale.y,    m.scale.z],
    }))
  };
  savedModels.push(entry);
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedModels));
  refreshSaved(); toast('"' + name + '" saved', 's');
}

function loadModel(id) {
  const d = savedModels.find(x => x.id === id); if (!d) return;
  clearAll();
  d.objs.forEach(o => {
    const mesh = new THREE.Mesh(makeGeo(o.shape, 1), makeMat(o.color));
    mesh.position.set(...o.pos); mesh.rotation.set(...o.rot); mesh.scale.set(...o.sc);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { id: ++OBJ_CTR, shape: o.shape, color: o.color, label: o.label };
    const bbox = new THREE.BoxHelper(mesh, 0xffffff);
    bbox.material.transparent = true; bbox.material.opacity = 0;
    scene.add(bbox); mesh.userData.bbox = bbox;
    scene.add(mesh); OBJS.push(mesh);
  });
  closeSave(); refreshSceneList(); toast('"' + d.name + '" loaded', 's');
}

function delSaved(id) {
  savedModels = savedModels.filter(x => x.id !== id);
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedModels));
  refreshSaved(); toast('Deleted', 'w');
}

function refreshSaved() {
  const el = document.getElementById('slist'); if (!el) return;
  if (!savedModels.length) {
    el.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.25);padding:4px 2px">No saved models</div>';
    return;
  }
  el.innerHTML = savedModels.map(m => `
    <div class="sitem">
      <div>
        <div style="color:#fff;font-weight:500">${m.name}</div>
        <div style="font-size:10px;margin-top:1px">${m.date} · ${m.objs.length} objects</div>
      </div>
      <div class="sitem-btns">
        <button onclick="loadModel(${m.id})" style="color:#60a5fa">Load</button>
        <button onclick="delSaved(${m.id})" style="color:#f87171">✕</button>
      </div>
    </div>`).join('');
}

function exportJSON() {
  const d = { version:'4.0', objects: OBJS.map(m => ({
    shape: m.userData.shape, color: m.userData.color, label: m.userData.label,
    position: m.position, rotation: m.rotation, scale: m.scale,
  }))};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(d,null,2)], {type:'application/json'}));
  a.download = 'air3d-model.json'; a.click();
  toast('Exported', 's');
}

// ── RENDER LOOP ───────────────────────────────────────
let _fc = 0, _ft = Date.now();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const now = Date.now();
  _fc++;
  if (now - _ft >= 1000) {
    const el = document.getElementById('sfps'); if (el) el.textContent = _fc;
    _fc = 0; _ft = now;
  }
  // orbit inertia (gesture.js)
  if (typeof updateInertiaFromLoop === 'function') updateInertiaFromLoop();
  // drift point light
  movingPt.position.x = Math.sin(now * 0.0007) * 6;
  movingPt.position.z = Math.cos(now * 0.0007) * 6;
  // update bboxes
  OBJS.forEach(m => { if (m.userData.bbox) m.userData.bbox.update(); });
  // pulse selected bbox
  if (SEL && SEL.userData.bbox) {
    SEL.userData.bbox.material.opacity = 0.15 + 0.14 * Math.abs(Math.sin(now * 0.003));
  }
  renderer.render(scene, cam3d);
}

window.addEventListener('resize', () => {
  cam3d.aspect = innerWidth / innerHeight;
  cam3d.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});