'use strict';
// ═══════════════════════════════════════════════════════════════
//  GESTURE.JS  —  v5 — Precision Hand Tracking
//
//  The four pillars that make this feel tight and controlled:
//
//  1. LANDMARK EMA SMOOTHING
//     Every landmark position is averaged with the previous frame
//     using an exponential moving average (alpha=0.5).
//     Raw MediaPipe output has ~5-8px jitter. After smoothing: ~1px.
//     This fixes: cursor wobble, floaty drag, jittery orbit.
//
//  2. GESTURE VOTE BUFFER
//     We keep the last VOTE_WINDOW frames of classified gestures.
//     A gesture only "fires" when it wins a majority of that window.
//     Single-frame noise (hand tremor, partial occlusion) is ignored.
//     This fixes: fist/open flipping, broken dwell, phantom pinches.
//
//  3. HYSTERETIC PINCH THRESHOLD
//     Pinch ENTERS when thumb-index dist < PINCH_ON (0.065).
//     Pinch EXITS  when thumb-index dist > PINCH_OFF (0.095).
//     The gap between them prevents bouncing at the threshold boundary.
//
//  4. ORBIT INERTIA
//     When orbit gesture ends, velocity decays over ~400ms instead of
//     stopping immediately. Makes camera movement feel physical.
// ═══════════════════════════════════════════════════════════════

// ── DOM ──────────────────────────────────────────────────────────
const vidEl = document.getElementById('video');
const hCv   = document.getElementById('hcanvas');
const hCtx  = hCv.getContext('2d');
const curL  = document.getElementById('cursor-l');
const curR  = document.getElementById('cursor-r');

// ── CAM STATE ─────────────────────────────────────────────────
let mediaStream  = null;
let handsModel   = null;
let handInterval = null;
let handBusy     = false;
let camActive    = false;

// ── SKELETON CONNECTIONS ─────────────────────────────────────
const SKEL = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

// ═══════════════════════════════════════════════════════════════
//  PILLAR 1: LANDMARK EMA SMOOTHING
// ═══════════════════════════════════════════════════════════════
const EMA_ALPHA = 0.50;   // 0=max smooth/laggy, 1=raw/instant. 0.5 is a good balance.
const smoothedLm = { Left: null, Right: null };

function smoothLandmarks(label, rawLm) {
  if (!smoothedLm[label]) {
    // First frame — initialise with raw values (deep copy)
    smoothedLm[label] = rawLm.map(p => ({ x:p.x, y:p.y, z:p.z }));
    return smoothedLm[label];
  }
  const prev = smoothedLm[label];
  rawLm.forEach((p, i) => {
    prev[i].x = EMA_ALPHA * p.x + (1 - EMA_ALPHA) * prev[i].x;
    prev[i].y = EMA_ALPHA * p.y + (1 - EMA_ALPHA) * prev[i].y;
    prev[i].z = EMA_ALPHA * p.z + (1 - EMA_ALPHA) * prev[i].z;
  });
  return prev;
}

// Smooth cursor position separately (more aggressive smoothing for visual comfort)
const CURSOR_ALPHA = 0.40;
const cursorSmooth = {
  Left:  { x: -999, y: -999 },
  Right: { x: -999, y: -999 },
};

function smoothCursor(label, rx, ry) {
  const s = cursorSmooth[label];
  if (s.x === -999) { s.x = rx; s.y = ry; return { x: rx, y: ry }; }
  s.x = CURSOR_ALPHA * rx + (1 - CURSOR_ALPHA) * s.x;
  s.y = CURSOR_ALPHA * ry + (1 - CURSOR_ALPHA) * s.y;
  return { x: s.x, y: s.y };
}

// ═══════════════════════════════════════════════════════════════
//  PILLAR 2: GESTURE VOTE BUFFER
// ═══════════════════════════════════════════════════════════════
const VOTE_WINDOW = 5;   // look at last N classified frames
const VOTE_THRESH = 3;   // need this many to agree

const gestureBuffers = {
  Left:  [],
  Right: [],
};

// Per-hand: are we currently in pinch state? (for hysteresis)
const pinchActive = { Left: false, Right: false };

function voteGesture(label, rawGest) {
  const buf = gestureBuffers[label];
  buf.push(rawGest);
  if (buf.length > VOTE_WINDOW) buf.shift();

  // Count votes
  const counts = {};
  buf.forEach(g => { counts[g] = (counts[g] || 0) + 1; });

  // Find winner
  let winner = 'none', best = 0;
  for (const [g, c] of Object.entries(counts)) {
    if (c > best) { best = c; winner = g; }
  }
  // Only emit if it clears the threshold
  return best >= VOTE_THRESH ? winner : 'none';
}

// ═══════════════════════════════════════════════════════════════
//  PILLAR 3: GESTURE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════
const PINCH_ON  = 0.065;  // enter pinch below this
const PINCH_OFF = 0.095;  // exit pinch above this (hysteresis gap)

function lmDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Is finger extended? tip clearly above pip.
// Uses a slightly generous threshold (0.025) + also checks vs MCP.
function fingerExtended(tip, pip, mcp) {
  return tip.y < pip.y - 0.025 || tip.y < mcp.y;
}

function classifyRaw(lm, label) {
  const T=lm[4], I=lm[8], M=lm[12], R=lm[16], P=lm[20], W=lm[0];

  // Hysteretic pinch check
  const pd = lmDist(T, I);
  if (pinchActive[label]) {
    if (pd > PINCH_OFF) pinchActive[label] = false;
  } else {
    if (pd < PINCH_ON)  pinchActive[label] = true;
  }
  if (pinchActive[label]) return 'pinch';

  // Finger extension (using both PIP and MCP for reliability)
  const io = fingerExtended(I, lm[6],  lm[5]);
  const mo = fingerExtended(M, lm[10], lm[9]);
  const ro = fingerExtended(R, lm[14], lm[13]);
  const po = fingerExtended(P, lm[18], lm[17]);

  // Thumbs-up: thumb well above wrist, other fingers curled
  if (T.y < W.y - 0.10 && !io && !mo && !ro) return 'thumbsup';

  // Peace: index + middle up, ring + pinky down
  if (io && mo && !ro && !po) return 'peace';

  // Point: only index finger extended
  if (io && !mo && !ro && !po) return 'point';

  // Fist: all fingers down AND fingertips near palm base
  if (!io && !mo && !ro && !po) return 'fist';

  // Open: all four fingers extended
  if (io && mo && ro && po) return 'open';

  return 'none';
}

// ── LIVE HAND DATA ────────────────────────────────────────────
// Each entry: { label, lm (smoothed), gest (voted), rawGest }
const H = { Left: null, Right: null };

// ── lm → screen (CSS-mirrored video compensation) ─────────────
function lmScreen(pt) {
  return { x: (1 - pt.x) * innerWidth, y: pt.y * innerHeight };
}
function toNDC(sx, sy) {
  return new THREE.Vector2((sx / innerWidth)*2-1, -(sy / innerHeight)*2+1);
}

// ═══════════════════════════════════════════════════════════════
//  STATE MACHINES
// ═══════════════════════════════════════════════════════════════

// ── 1. PINCH-DRAG ────────────────────────────────────────────
// Placement requires pinch + stay still 500ms (no accidental spawning).
// Grabbing an existing object is immediate.

const PLACE_STILL  = 0.018;  // max lm movement to confirm placement
const PLACE_HOLD   = 500;    // ms to hold still before placing
const MOVE_SCALE   = 16;
const ROT_SCALE    = 4.5;
const SCALE_SCALE  = 3.0;

const PD = {
  Left:  { on:false, prevLm:null, hasObj:false, intent:null },
  Right: { on:false, prevLm:null, hasObj:false, intent:null },
};

function processPinchDrag(hand) {
  const s = PD[hand.label];

  if (hand.gest !== 'pinch') {
    s.on = false; s.prevLm = null; s.hasObj = false; s.intent = null;
    return;
  }

  // ── First frame of pinch ─────────────────────────────
  if (!s.on) {
    s.on = true;

    const lm = hand.lm;
    const mx = (lm[4].x + lm[8].x) * 0.5;
    const my = (lm[4].y + lm[8].y) * 0.5;
    const sx = (1 - mx) * innerWidth;
    const sy = my * innerHeight;

    RAY.setFromCamera(toNDC(sx, sy), cam3d);
    const hits = RAY.intersectObjects(OBJS, false);

    if (hits.length) {
      // Hit an object → grab immediately
      selectMesh(hits[0].object); refreshSceneList();
      s.hasObj = true; s.intent = null;
    } else if (APP.mode === 'create') {
      // Empty space → start placement intent timer
      s.hasObj = false;
      s.intent = { sx, sy, startX: mx, startY: my, time: Date.now() };
    } else {
      selectMesh(null); refreshSceneList();
      s.hasObj = false; s.intent = null;
    }

    s.prevLm = { x: mx, y: my };
    return;
  }

  const lm  = hand.lm;
  const mx  = (lm[4].x + lm[8].x) * 0.5;
  const my  = (lm[4].y + lm[8].y) * 0.5;

  // ── Placement intent window ───────────────────────────
  if (s.intent) {
    const moved = Math.hypot(mx - s.intent.startX, my - s.intent.startY);
    if (moved > PLACE_STILL) {
      // Moved too much — cancel. No object placed.
      s.intent = null;
    } else if (Date.now() - s.intent.time >= PLACE_HOLD) {
      // Held still — place
      RAY.setFromCamera(toNDC(s.intent.sx, s.intent.sy), cam3d);
      const gh = RAY.intersectObject(groundMesh);
      const pos = gh.length
        ? gh[0].point.clone().setY(APP.sz * 0.5)
        : new THREE.Vector3(0, APP.sz * 0.5, 0);
      spawnAt(pos);
      s.hasObj = true; s.intent = null;
    }
    s.prevLm = { x: mx, y: my };
    return;
  }

  // ── Active drag ───────────────────────────────────────
  if (!s.prevLm || !SEL || !s.hasObj) {
    s.prevLm = { x: mx, y: my };
    return;
  }

  // Delta in normalised lm space, X flipped for mirror
  const dx = -(mx - s.prevLm.x);
  const dy =   my - s.prevLm.y;

  if (APP.tm === 'move') {
    SEL.position.x += dx * MOVE_SCALE;
    SEL.position.z += dy * MOVE_SCALE;
  } else if (APP.tm === 'rotate') {
    SEL.rotation.y += dx * ROT_SCALE;
    SEL.rotation.x += dy * ROT_SCALE * 0.5;
  } else if (APP.tm === 'scale') {
    const f = 1 - dy * SCALE_SCALE;
    SEL.scale.multiplyScalar(Math.max(0.02, Math.min(20, f)));
  }

  if (SEL.userData.bbox) SEL.userData.bbox.update();
  updateTF(SEL);
  s.prevLm = { x: mx, y: my };
}

// ── 2. TWO-HAND PINCH (scale + rotate + lift) ────────────────
const TP = { active:false, prevDist:null, prevAngle:null, prevMidY:null };

function processTwoHandPinch() {
  const L = H.Left, R = H.Right;
  if (!L || !R || L.gest !== 'pinch' || R.gest !== 'pinch') {
    if (TP.active) {
      TP.active=false; TP.prevDist=null; TP.prevAngle=null; TP.prevMidY=null;
    }
    return false;
  }

  const lx = 1-(L.lm[4].x+L.lm[8].x)*0.5, ly=(L.lm[4].y+L.lm[8].y)*0.5;
  const rx = 1-(R.lm[4].x+R.lm[8].x)*0.5, ry=(R.lm[4].y+R.lm[8].y)*0.5;

  const dist  = Math.hypot(rx-lx, ry-ly);
  const angle = Math.atan2(ry-ly, rx-lx);
  const midY  = (ly+ry)*0.5;

  if (TP.prevDist !== null) {
    const dD = dist  - TP.prevDist;
    const dA = angle - TP.prevAngle;
    const dY = midY  - TP.prevMidY;

    if (SEL) {
      SEL.scale.multiplyScalar(Math.max(0.02, Math.min(20, 1 + dD * 6)));
      SEL.rotation.y += dA * 2.5;
      SEL.position.y  = Math.max(0.05, SEL.position.y - dY * 12);
      if (SEL.userData.bbox) SEL.userData.bbox.update();
      updateTF(SEL);
    } else {
      ORB.r  = Math.max(1.5, Math.min(60, ORB.r - dD * 28));
      ORB.th -= dA * 1.4;
      syncCam();
    }
  }

  TP.active=true; TP.prevDist=dist; TP.prevAngle=angle; TP.prevMidY=midY;
  return true;
}

// ── 3. ORBIT (fist or open palm) ─────────────────────────────
//
// PILLAR 4: INERTIA — when orbit gesture ends, velocity decays
// over ~400ms so the camera glides to a stop rather than snapping.

const ORBIT_DECAY = 0.88;   // velocity multiplied each frame (~30fps → ~400ms decay)
const ORBIT_MIN_V = 0.0002; // stop applying below this velocity

const orbitVel = { th: 0, ph: 0 }; // current velocity (radians/frame)

const FO = { Left:{on:false,px:null,py:null}, Right:{on:false,px:null,py:null} };
const OO = { Left:{on:false,px:null,py:null}, Right:{on:false,px:null,py:null} };

// How sensitive orbit feels (normalised units → radians)
const FIST_SENS = 3.5;
const OPEN_SENS = 2.5;

function processFistOrbit(hand) {
  const s = FO[hand.label];
  if (hand.gest !== 'fist') {
    // Store last velocity when releasing fist
    s.on=false; s.px=null; s.py=null;
    return;
  }
  const wx = 1 - hand.lm[0].x;
  const wy = hand.lm[0].y;
  if (s.on && s.px !== null) {
    const dth = -(wx - s.px) * FIST_SENS;
    const dph =  (wy - s.py) * FIST_SENS;
    orbitVel.th = dth;
    orbitVel.ph = dph;
    ORB.th += dth;
    ORB.ph  = Math.max(0.06, Math.min(Math.PI-0.06, ORB.ph + dph));
    syncCam();
  }
  s.on=true; s.px=wx; s.py=wy;
}

function processOpenOrbit(hand) {
  const s = OO[hand.label];
  if (hand.gest !== 'open') {
    s.on=false; s.px=null; s.py=null;
    return;
  }
  // Palm centre
  const pcx = (hand.lm[0].x+hand.lm[5].x+hand.lm[9].x+hand.lm[13].x+hand.lm[17].x)/5;
  const pcy = (hand.lm[0].y+hand.lm[5].y+hand.lm[9].y+hand.lm[13].y+hand.lm[17].y)/5;
  const wx = 1-pcx, wy=pcy;
  if (s.on && s.px !== null) {
    const dth = -(wx - s.px) * OPEN_SENS;
    const dph =  (wy - s.py) * OPEN_SENS;
    orbitVel.th = dth;
    orbitVel.ph = dph;
    ORB.th += dth;
    ORB.ph  = Math.max(0.06, Math.min(Math.PI-0.06, ORB.ph + dph));
    syncCam();
  }
  s.on=true; s.px=wx; s.py=wy;
}

// Apply inertia every frame (called from render loop via updateInertia())
function updateInertia() {
  const anyOrbit = (H.Left  && (H.Left.gest ==='fist'||H.Left.gest ==='open')) ||
                   (H.Right && (H.Right.gest==='fist'||H.Right.gest==='open'));
  if (anyOrbit) return; // don't apply inertia while actively orbiting
  if (Math.abs(orbitVel.th) < ORBIT_MIN_V && Math.abs(orbitVel.ph) < ORBIT_MIN_V) return;
  orbitVel.th *= ORBIT_DECAY;
  orbitVel.ph *= ORBIT_DECAY;
  ORB.th += orbitVel.th;
  ORB.ph  = Math.max(0.06, Math.min(Math.PI-0.06, ORB.ph + orbitVel.ph));
  syncCam();
}

// ── 4. BOTH-FIST ZOOM ────────────────────────────────────────
const BFZ = { prevDist: null };

function processBothFistZoom() {
  const L=H.Left, R=H.Right;
  if (!L||!R||L.gest!=='fist'||R.gest!=='fist') { BFZ.prevDist=null; return; }
  const lx=1-L.lm[0].x, ly=L.lm[0].y;
  const rx=1-R.lm[0].x, ry=R.lm[0].y;
  const dist = Math.hypot(rx-lx, ry-ly);
  if (BFZ.prevDist !== null) {
    ORB.r = Math.max(1.5, Math.min(60, ORB.r - (dist - BFZ.prevDist) * 22));
    syncCam();
  }
  BFZ.prevDist = dist;
}

// ── 5. PEACE HOLD → DELETE ───────────────────────────────────
const PEACE_HOLD_MS = 1100;
const PH = { Left:null, Right:null, cool:false };

function processPeaceHold(hand) {
  if (hand.gest !== 'peace' || !SEL || PH.cool) {
    PH[hand.label] = null; return;
  }
  const now = Date.now();
  if (PH[hand.label] === null) { PH[hand.label] = now; return; }
  if (now - PH[hand.label] >= PEACE_HOLD_MS) {
    PH[hand.label]=null; PH.cool=true;
    setTimeout(() => PH.cool=false, 2200);
    delSel();
  }
}

// ── 6. THUMBS-UP → CYCLE VIEW ────────────────────────────────
const TV = { cool:false };
const VIEWS = [
  { label:'Perspective', th:0.55,  ph:0.82,       r:12 },
  { label:'Top',         th:0.55,  ph:0.06,       r:14 },
  { label:'Front',       th:Math.PI,    ph:Math.PI/2,  r:12 },
  { label:'Side Right',  th:Math.PI/2,  ph:Math.PI/2,  r:12 },
  { label:'Side Left',   th:-Math.PI/2, ph:Math.PI/2,  r:12 },
];
let viewIdx = 0;

function processThumbsUp(hand) {
  if (hand.gest !== 'thumbsup' || TV.cool) return;
  TV.cool = true; setTimeout(() => TV.cool=false, 1800);
  viewIdx = (viewIdx+1) % VIEWS.length;
  const v = VIEWS[viewIdx];
  ORB.th=v.th; ORB.ph=v.ph; ORB.r=v.r; syncCam();
  toast(v.label + ' view', 'i');
}

// ── 7. DRAW LINE MODE ─────────────────────────────────────────
const DRAW_MIN_DIST = 0.010;
const DRAW_MAX_PTS  = 600;

const DL = {
  Left:  { drawing:false, points:[], tempLine:null, prevX:null, prevY:null },
  Right: { drawing:false, points:[], tempLine:null, prevX:null, prevY:null },
};

const _drawPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ visible:false, side:THREE.DoubleSide })
);
_drawPlane.rotation.x = -Math.PI/2;
scene.add(_drawPlane);

function setDrawHeight(y) { _drawPlane.position.y = y; }
setDrawHeight(0);

function processDrawLine(hand) {
  if (APP.mode !== 'draw') {
    if (DL[hand.label].drawing) _commitLine(hand.label);
    return;
  }
  const s = DL[hand.label];
  if (hand.gest !== 'pinch') {
    if (s.drawing) _commitLine(hand.label);
    return;
  }
  const lm = hand.lm;
  const mx = (lm[4].x+lm[8].x)*0.5, my=(lm[4].y+lm[8].y)*0.5;
  const sx=(1-mx)*innerWidth, sy=my*innerHeight;
  RAY.setFromCamera(toNDC(sx, sy), cam3d);
  const hits = RAY.intersectObject(_drawPlane);
  if (!hits.length) return;
  const pt = hits[0].point.clone();

  if (!s.drawing) {
    s.drawing=true; s.points=[pt]; s.prevX=mx; s.prevY=my;
    s.tempLine = _makeLiveLine([pt], APP.color);
    scene.add(s.tempLine); return;
  }

  const moved = Math.hypot(mx-s.prevX, my-s.prevY);
  if (moved < DRAW_MIN_DIST) return;
  if (s.points.length >= DRAW_MAX_PTS) { _commitLine(hand.label); return; }
  s.points.push(pt); s.prevX=mx; s.prevY=my;
  _updateLiveLine(s.tempLine, s.points);
}

function _makeLiveLine(pts, color) {
  const buf = new Float32Array(DRAW_MAX_PTS*3);
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(buf, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  pts.forEach((p,i) => { buf[i*3]=p.x; buf[i*3+1]=p.y; buf[i*3+2]=p.z; });
  geo.setDrawRange(0, pts.length);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color:new THREE.Color(color), linewidth:2 }));
}

function _updateLiveLine(line, pts) {
  const attr = line.geometry.attributes.position;
  const buf  = attr.array;
  pts.forEach((p,i) => { buf[i*3]=p.x; buf[i*3+1]=p.y; buf[i*3+2]=p.z; });
  line.geometry.setDrawRange(0, pts.length);
  attr.needsUpdate = true;
}

function _commitLine(label) {
  const s = DL[label]; if (!s.drawing) return;
  s.drawing = false;
  if (s.tempLine) { scene.remove(s.tempLine); s.tempLine=null; }
  if (s.points.length < 2) { s.points=[]; return; }

  const buf = new Float32Array(s.points.length*3);
  s.points.forEach((p,i) => { buf[i*3]=p.x; buf[i*3+1]=p.y; buf[i*3+2]=p.z; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(buf,3));
  const mat = new THREE.LineBasicMaterial({ color:new THREE.Color(APP.color), linewidth:2 });
  const line = new THREE.Line(geo, mat);
  line.userData = {
    id:++OBJ_CTR, type:'line', color:APP.color,
    label:'Line '+OBJ_CTR,
    points: s.points.map(p=>({x:p.x,y:p.y,z:p.z})),
  };
  const bbox = new THREE.BoxHelper(line, 0xffffff);
  bbox.material.transparent=true; bbox.material.opacity=0;
  scene.add(bbox); line.userData.bbox=bbox;
  scene.add(line); OBJS.push(line);
  UNDO_STACK.push({type:'add',mesh:line});
  selectMesh(line); refreshSceneList();
  toast('Line '+OBJ_CTR+' ('+s.points.length+' pts)', 's');
  s.points=[];
}

function closeSelectedLine() {
  if (!SEL||SEL.userData.type!=='line') { toast('Select a line first','w'); return; }
  const attr=SEL.geometry.attributes.position, arr=attr.array, n=arr.length/3;
  const nb=new Float32Array((n+1)*3); nb.set(arr);
  nb[n*3]=arr[0]; nb[n*3+1]=arr[1]; nb[n*3+2]=arr[2];
  SEL.geometry.setAttribute('position',new THREE.BufferAttribute(nb,3));
  SEL.geometry.setDrawRange(0,n+1);
  if (SEL.userData.points) SEL.userData.points.push(SEL.userData.points[0]);
  if (SEL.userData.bbox) SEL.userData.bbox.update();
  toast('Path closed','s');
}

function extrudeSelectedLine() {
  if (!SEL||SEL.userData.type!=='line') { toast('Select a line first','w'); return; }
  const pts=SEL.userData.points; if (!pts||pts.length<2) return;
  const height=APP.sz*1.5, verts=[];
  for (let i=0;i<pts.length-1;i++) {
    const a=pts[i],b=pts[i+1];
    verts.push(a.x,a.y,a.z, b.x,b.y,b.z, a.x,a.y+height,a.z);
    verts.push(b.x,b.y,b.z, b.x,b.y+height,b.z, a.x,a.y+height,a.z);
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(verts),3));
  geo.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({
    color:new THREE.Color(SEL.userData.color),
    side:THREE.DoubleSide,metalness:0.15,roughness:0.5,transparent:true,opacity:0.85
  });
  const mesh=new THREE.Mesh(geo,mat);
  mesh.userData={id:++OBJ_CTR,type:'extruded',color:SEL.userData.color,label:'Extrude '+OBJ_CTR};
  const bbox=new THREE.BoxHelper(mesh,0xffffff);
  bbox.material.transparent=true;bbox.material.opacity=0;
  scene.add(bbox);mesh.userData.bbox=bbox;
  scene.add(mesh);OBJS.push(mesh);UNDO_STACK.push({type:'add',mesh});
  selectMesh(mesh);refreshSceneList();
  toast('Extruded to 3D','s');
}

// ── 8. DWELL (point + hover 1.4s = click button) ─────────────
const DWELL_MS = 1400;
// Grace period: if gesture drops to 'none' for ≤ DWELL_GRACE frames,
// we keep the timer running (handles single-frame classification noise).
const DWELL_GRACE = 2;
const dwellState = {};
const dwellGrace  = { Left: 0, Right: 0 }; // frames since last 'point'

function processDwell(hand) {
  const label = hand.label;

  if (hand.gest === 'point') {
    dwellGrace[label] = 0;
  } else {
    dwellGrace[label]++;
    if (dwellGrace[label] > DWELL_GRACE) {
      clearDwellFor(label);
      return;
    }
    // Within grace period — keep processing as if still pointing
  }

  const sx = lmScreen(hand.lm[8]).x;
  const sy = lmScreen(hand.lm[8]).y;

  const targets = document.querySelectorAll('[data-action]');
  targets.forEach(el => {
    const rect = el.getBoundingClientRect();
    const inside = sx>=rect.left && sx<=rect.right && sy>=rect.top && sy<=rect.bottom;
    const key    = (el.dataset.action||'el')+'_'+label;

    if (inside) {
      el.classList.add('dwell-hover');
      if (!dwellState[key]) {
        const ring = document.createElement('div');
        ring.className='dwell-ring';
        ring.style.left=(rect.left+rect.width/2)+'px';
        ring.style.top =(rect.top+rect.height/2)+'px';
        document.body.appendChild(ring);
        dwellState[key]={
          el, ring, start:Date.now(),
          timer:setTimeout(() => fireDwell(el,key), DWELL_MS),
        };
      } else {
        const pct=Math.min(1,(Date.now()-dwellState[key].start)/DWELL_MS);
        dwellState[key].ring.style.setProperty('--pct', pct);
      }
    } else {
      clearDwellEntry(key);
    }
  });
}

function fireDwell(el, key) {
  clearDwellEntry(key);
  el.click();
  el.classList.add('dwell-fired');
  setTimeout(() => el.classList.remove('dwell-fired'), 350);
  // Flash cursors
  [curL,curR].forEach(c => {
    if (c&&c.style.display!=='none') {
      c.style.transform='translate(-50%,-50%) scale(1.7)';
      setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',200);
    }
  });
  toast('✓ activated','s');
}

function clearDwellFor(label) {
  Object.keys(dwellState)
    .filter(k=>k.endsWith('_'+label))
    .forEach(clearDwellEntry);
}
function clearDwellEntry(key) {
  if (!dwellState[key]) return;
  clearTimeout(dwellState[key].timer);
  const {ring,el}=dwellState[key];
  if (ring&&ring.parentNode) ring.parentNode.removeChild(ring);
  if (el) el.classList.remove('dwell-hover');
  delete dwellState[key];
}

// ═══════════════════════════════════════════════════════════════
//  MAIN RESULT HANDLER
// ═══════════════════════════════════════════════════════════════
function onHandResults(results) {
  // Sync canvas size to video
  if (vidEl.videoWidth>0 && hCv.width!==vidEl.videoWidth) {
    hCv.width=vidEl.videoWidth; hCv.height=vidEl.videoHeight;
  }
  hCtx.clearRect(0,0,hCv.width,hCv.height);

  H.Left=null; H.Right=null;

  if (results.multiHandLandmarks && results.multiHandLandmarks.length) {
    results.multiHandLandmarks.forEach((rawLm, i) => {
      // Mirror-compensate label (MediaPipe sees un-mirrored video)
      const raw   = results.multiHandedness[i].label;
      const label = raw==='Left'?'Right':'Left';

      // Apply EMA smoothing to landmarks
      const lm = smoothLandmarks(label, rawLm);

      // Classify raw gesture on smoothed landmarks
      const rawGest = classifyRaw(lm, label);

      // Vote for stability
      const gest = voteGesture(label, rawGest);

      H[label] = { label, lm, gest, rawGest };
    });
  } else {
    // No hands — reset smoothing state
    smoothedLm.Left=null; smoothedLm.Right=null;
    cursorSmooth.Left={x:-999,y:-999}; cursorSmooth.Right={x:-999,y:-999};
    gestureBuffers.Left.length=0; gestureBuffers.Right.length=0;
    pinchActive.Left=false; pinchActive.Right=false;
  }

  drawSkeletons();
  updateCursors();
  dispatch();
  updateHUD();
}

// ═══════════════════════════════════════════════════════════════
//  DISPATCH
// ═══════════════════════════════════════════════════════════════
function dispatch() {
  const L=H.Left, R=H.Right;

  const twoPin = processTwoHandPinch();
  if (!twoPin) processBothFistZoom();

  [L,R].forEach(hand => {
    if (!hand) return;
    if (APP.mode==='draw') {
      processDrawLine(hand);
    } else if (!twoPin) {
      processPinchDrag(hand);
    }
    processFistOrbit(hand);
    processOpenOrbit(hand);
    processDwell(hand);
    processPeaceHold(hand);
    processThumbsUp(hand);
  });
}

// Called every frame by the Three.js render loop (scene.js exposes this)
function updateInertiaFromLoop() { updateInertia(); }

// ═══════════════════════════════════════════════════════════════
//  DRAW SKELETONS
//  hcanvas has CSS scaleX(-1), matching the video mirror.
//  So we draw in raw landmark space (lm.x*W) and CSS handles the flip.
// ═══════════════════════════════════════════════════════════════
function drawSkeletons() {
  const W=hCv.width, H2=hCv.height;
  const defs=[
    {hand:H.Left,  lineCol:'rgba(96,165,250,0.75)',  dotCol:'#60a5fa'},
    {hand:H.Right, lineCol:'rgba(244,114,182,0.75)', dotCol:'#f472b6'},
  ];

  defs.forEach(({hand,lineCol,dotCol}) => {
    if (!hand) return;
    const lm=hand.lm;

    // Skeleton lines
    hCtx.strokeStyle=lineCol; hCtx.lineWidth=2.5;
    SKEL.forEach(([a,b]) => {
      hCtx.beginPath();
      hCtx.moveTo(lm[a].x*W,lm[a].y*H2);
      hCtx.lineTo(lm[b].x*W,lm[b].y*H2);
      hCtx.stroke();
    });

    // Joints
    lm.forEach((p,i) => {
      const key=i===4||i===8;
      hCtx.beginPath();
      hCtx.arc(p.x*W,p.y*H2,key?7:(i===0?5:3.5),0,Math.PI*2);
      hCtx.fillStyle=key?dotCol:'rgba(255,255,255,0.8)';
      hCtx.fill();
      if (key) { hCtx.strokeStyle='rgba(255,255,255,0.45)'; hCtx.lineWidth=1.5; hCtx.stroke(); }
    });

    // Pinch proximity line
    const pd=lmDist(lm[4],lm[8]);
    if (pd<0.11) {
      hCtx.save();
      hCtx.setLineDash([5,5]);
      hCtx.strokeStyle=hand.gest==='pinch'?dotCol:'rgba(255,255,255,0.4)';
      hCtx.lineWidth=2;
      hCtx.beginPath();
      hCtx.moveTo(lm[4].x*W,lm[4].y*H2);
      hCtx.lineTo(lm[8].x*W,lm[8].y*H2);
      hCtx.stroke();
      hCtx.restore();
    }

    // Gesture label badge next to wrist
    const gLabel = hand.gest !== 'none' ? hand.gest.toUpperCase() : '';
    if (gLabel) {
      const bx=lm[0].x*W, by=lm[0].y*H2;
      hCtx.save();
      hCtx.font='bold 11px sans-serif';
      const tw=hCtx.measureText(gLabel).width;
      hCtx.fillStyle='rgba(0,0,0,0.55)';
      hCtx.fillRect(bx+10,by-11,tw+8,16);
      hCtx.fillStyle=dotCol;
      hCtx.fillText(gLabel, bx+14, by+2);
      hCtx.restore();
    }

    // Placement intent arc
    if (PD[hand.label].intent) {
      const intent=PD[hand.label].intent;
      const pct=Math.min(1,(Date.now()-intent.time)/PLACE_HOLD);
      const mx=(lm[4].x+lm[8].x)*0.5*W;
      const my=(lm[4].y+lm[8].y)*0.5*H2;
      hCtx.save();
      hCtx.beginPath(); hCtx.arc(mx,my,18,0,Math.PI*2);
      hCtx.strokeStyle='rgba(255,255,255,0.12)'; hCtx.lineWidth=3; hCtx.stroke();
      hCtx.beginPath();
      hCtx.arc(mx,my,18,-Math.PI/2,-Math.PI/2+pct*Math.PI*2);
      hCtx.strokeStyle=dotCol; hCtx.lineWidth=3; hCtx.stroke();
      hCtx.beginPath(); hCtx.arc(mx,my,4,0,Math.PI*2);
      hCtx.fillStyle=dotCol; hCtx.fill();
      hCtx.restore();
    }

    // Draw-mode stroke indicator
    if (APP.mode==='draw'&&DL[hand.label].drawing) {
      const mx=(lm[4].x+lm[8].x)*0.5*W;
      const my=(lm[4].y+lm[8].y)*0.5*H2;
      hCtx.save();
      hCtx.beginPath(); hCtx.arc(mx,my,10,0,Math.PI*2);
      hCtx.strokeStyle=dotCol; hCtx.lineWidth=2;
      hCtx.setLineDash([3,3]); hCtx.stroke(); hCtx.setLineDash([]);
      hCtx.fillStyle='rgba(255,255,255,0.65)'; hCtx.font='11px sans-serif';
      hCtx.fillText(DL[hand.label].points.length+' pts',mx+14,my+4);
      hCtx.restore();
    }

    // Peace-hold arc
    if (hand.gest==='peace'&&SEL&&PH[hand.label]!==null) {
      const pct=Math.min(1,(Date.now()-PH[hand.label])/PEACE_HOLD_MS);
      const cx=lm[9].x*W, cy=lm[9].y*H2;
      hCtx.save();
      hCtx.strokeStyle='#f87171'; hCtx.lineWidth=3;
      hCtx.beginPath();
      hCtx.arc(cx,cy,20,-Math.PI/2,-Math.PI/2+pct*Math.PI*2);
      hCtx.stroke();
      hCtx.restore();
    }
  });

  // Two-pinch connector line
  if (H.Left&&H.Right&&H.Left.gest==='pinch'&&H.Right.gest==='pinch') {
    const ll=H.Left.lm, rl=H.Right.lm;
    const lx=(ll[4].x+ll[8].x)*0.5*W, ly=(ll[4].y+ll[8].y)*0.5*H2;
    const rx=(rl[4].x+rl[8].x)*0.5*W, ry=(rl[4].y+rl[8].y)*0.5*H2;
    hCtx.save();
    hCtx.strokeStyle='rgba(255,255,255,0.5)'; hCtx.lineWidth=1.5;
    hCtx.setLineDash([8,8]);
    hCtx.beginPath(); hCtx.moveTo(lx,ly); hCtx.lineTo(rx,ry); hCtx.stroke();
    hCtx.setLineDash([]);
    hCtx.beginPath(); hCtx.arc((lx+rx)*0.5,(ly+ry)*0.5,5,0,Math.PI*2);
    hCtx.fillStyle='rgba(255,255,255,0.65)'; hCtx.fill();
    hCtx.restore();
  }
}

// ── CURSORS ─────────────────────────────────────────────────────
function updateCursors() {
  moveCursor(curL, H.Left);
  moveCursor(curR, H.Right);
}

function moveCursor(el, hand) {
  if (!el) return;
  if (!hand) { el.style.display='none'; cursorSmooth[el.id.includes('-l')?'Left':'Right']={x:-999,y:-999}; return; }
  // Apply cursor-specific EMA on top of landmark EMA
  const raw = lmScreen(hand.lm[8]);
  const label = hand.label;
  const pos = smoothCursor(label, raw.x, raw.y);
  el.style.left=pos.x+'px'; el.style.top=pos.y+'px'; el.style.display='block';
  el.className='hand-cursor';
  if      (hand.gest==='pinch') el.classList.add('pinch');
  else if (hand.gest==='fist')  el.classList.add('grab');
  else if (hand.gest==='open')  el.classList.add('open');
  else if (hand.gest==='point') el.classList.add('point');
}

// ── HUD ──────────────────────────────────────────────────────────
function updateHUD() {
  const L=H.Left, R=H.Right;
  const lg=L?L.gest:'none', rg=R?R.gest:'none';
  const t=(id,v)=>{ const e=document.getElementById(id); if(e)e.classList.toggle('active',v); };
  t('gp-pinch-l', lg==='pinch');
  t('gp-pinch-r', rg==='pinch');
  t('gp-both',    lg==='pinch'&&rg==='pinch');
  t('gp-fist',    lg==='fist'||rg==='fist');
  t('gp-open',    lg==='open'||rg==='open');
  t('gp-point',   lg==='point'||rg==='point');
  t('gp-peace',   lg==='peace'||rg==='peace');
  t('gp-thumb',   lg==='thumbsup'||rg==='thumbsup');
  const hc=document.getElementById('hand-count');
  if (hc) hc.textContent=(!L&&!R)?'No hands':(!L||!R)?'1 hand':'2 hands';
}

function resetHUD() {
  ['gp-pinch-l','gp-pinch-r','gp-both','gp-fist','gp-open','gp-point','gp-peace','gp-thumb']
    .forEach(id=>{const e=document.getElementById(id);if(e)e.classList.remove('active');});
  const hc=document.getElementById('hand-count'); if(hc) hc.textContent='No hands';
}

// ═══════════════════════════════════════════════════════════════
//  WEBCAM
// ═══════════════════════════════════════════════════════════════
async function startCam() {
  if (camActive) return;
  hideCamErr(); setCamBtn('loading');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio:false,
    });
    vidEl.srcObject = mediaStream;
    await new Promise(res => { vidEl.onloadedmetadata=res; });
    await vidEl.play();
    camActive=true;
    hCv.width=vidEl.videoWidth||1280; hCv.height=vidEl.videoHeight||720;
    setCamBtn('on');
    toast('Camera on — loading hand model…','i');
    await loadMP();
  } catch (err) {
    setCamBtn('off');
    let msg='Camera error: '+err.message;
    if (err.name==='NotAllowedError') msg='Camera denied. Click Allow then press Retry.';
    else if (err.name==='NotFoundError') msg='No camera found.';
    else if (location.protocol==='file:') msg='Needs HTTP: run  npx serve .  then open localhost:3000';
    showCamErr(msg);
  }
}

function stopCam() {
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  stopLoop(); vidEl.srcObject=null; camActive=false;
  H.Left=null; H.Right=null;
  setCamBtn('off');
  hCtx.clearRect(0,0,hCv.width,hCv.height);
  if(curL)curL.style.display='none'; if(curR)curR.style.display='none';
  resetHUD(); toast('Camera off','i');
}

function toggleCam() { camActive?stopCam():startCam(); }
function retryCam()  { hideCamErr(); startCam(); }

function setCamBtn(state) {
  const b=document.getElementById('cbtn'); if(!b)return;
  b.style.opacity=state==='loading'?'0.4':'1';
  b.classList.toggle('on', state==='on');
}
function showCamErr(msg) {
  const e=document.getElementById('camerr'); if(!e)return;
  document.getElementById('camerrmsg').textContent=msg; e.style.display='block';
}
function hideCamErr() { const e=document.getElementById('camerr'); if(e)e.style.display='none'; }

// ── MEDIAPIPE ────────────────────────────────────────────────────
async function loadMP() {
  if (typeof Hands!=='undefined') { initHands(); return; }
  const urls=[
    'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3/drawing_utils.js',
    'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js',
  ];
  for (const url of urls) {
    if (document.querySelector(`script[src="${url}"]`)) continue;
    await new Promise((ok,fail)=>{
      const s=document.createElement('script');
      s.src=url; s.crossOrigin='anonymous';
      s.onload=ok; s.onerror=()=>fail(new Error('CDN failed: '+url));
      document.head.appendChild(s);
    });
  }
  initHands();
}

function initHands() {
  handsModel=new Hands({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`});
  handsModel.setOptions({
    maxNumHands:2,
    modelComplexity:1,
    minDetectionConfidence:0.60,
    minTrackingConfidence:0.50,
  });
  handsModel.onResults(onHandResults);
  startLoop();
  toast('Hand tracking ready!','s');
}

function startLoop() {
  if (handInterval) return;
  handBusy=false;
  handInterval=setInterval(async()=>{
    if (!camActive||!handsModel||handBusy) return;
    if (vidEl.readyState<2||vidEl.paused||vidEl.ended) return;
    handBusy=true;
    try { await handsModel.send({image:vidEl}); } catch(e){}
    handBusy=false;
  }, 33);
}

function stopLoop() {
  if (handInterval) { clearInterval(handInterval); handInterval=null; }
}