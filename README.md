# AIR3D — Hand-Controlled 3D Model Studio

> **"Build in thin air. No mouse. No controller. Just your hands."**

AIR3D is a browser-based 3D modeling studio that uses your webcam to track both of your hands in real time. You can create 3D shapes, move and scale them, draw freehand lines in 3D space, extrude them into surfaces, and navigate the entire scene — all purely through hand gestures. No plugins, no hardware beyond a standard webcam, no installation.

---

## Credits

**Built by Mohammad Shakeel**
Designed, architected, and developed from the ground up — from the hand tracking pipeline to the 3D rendering engine to the gesture state machines. Every interaction model, sensitivity tuning decision, and UX detail in this project came from iterative hands-on testing and refinement.

---

## What It Does

- **Create** 3D primitives (box, sphere, cylinder, cone, torus, prism) by pinching in mid-air
- **Grab and drag** objects across the scene with one hand
- **Scale and rotate** objects using both hands simultaneously — spread apart to grow, twist to rotate
- **Zoom the viewport** by moving two fists apart or together
- **Orbit the camera** freely with a fist or open palm
- **Draw freehand 3D lines** in Draw mode, then close them into shapes or extrude them into 3D walls
- **Activate any UI button** by pointing your index finger at it and holding for 1.5 seconds
- **Cycle through views** (perspective, top, front, side) with a thumbs-up
- **Delete objects** by holding a peace sign over a selected object for 1.2 seconds
- **Save models** to the browser's localStorage and reload them later
- **Export** the full scene as a structured JSON file

---

## How to Run It

AIR3D requires a proper HTTP server because browsers block camera access on `file://` URLs.

### Option 1 — Node.js (recommended)
```bash
npx serve .
# then open http://localhost:3000
```

### Option 2 — Python
```bash
python -m http.server 8080
# then open http://localhost:8080
```

### Option 3 — VS Code
Install the **Live Server** extension and click "Go Live" — it handles everything automatically.

When the page loads, click **Open Studio**, allow camera access when the browser asks, and you're in.

---

## Gesture Reference

| Gesture | What it does |
|---|---|
| 🤌 **Pinch on object** | Grab it immediately and drag |
| 🤌 **Pinch empty space (hold still 0.5s)** | Place a new object at that position |
| 🤌🤌 **Both hands pinch — spread** | Scale selected object up (or zoom viewport) |
| 🤌🤌 **Both hands pinch — squeeze** | Scale selected object down |
| 🤌🤌 **Both hands pinch — twist** | Rotate selected object around Y axis |
| 🤌🤌 **Both hands pinch — move up/down** | Lift or lower selected object |
| ✊ **Fist + move** | Orbit the camera |
| ✋ **Open palm + move** | Orbit the camera (smoother) |
| ✊✊ **Both fists — apart/together** | Zoom viewport in and out |
| ☝️ **Point finger + hover button (1.5s)** | Activate that button (dwell click) |
| ✌️ **Peace sign — hold 1.2s** | Delete the selected object |
| 👍 **Thumbs up** | Cycle views: Perspective → Top → Front → Side |
| ✏️ **Pinch + move (Draw mode)** | Trace a freehand 3D line |

---

## File Structure

```
air3d/
├── index.html      — UI shell, layout, styles, shared APP state
├── scene.js        — Three.js setup, 3D objects, orbit camera, save/load
├── gesture.js      — Webcam, MediaPipe, hand tracking, all gesture logic
└── README.md       — This file
```

The three files are deliberately separated by concern. `index.html` handles what the user sees. `scene.js` handles the 3D world. `gesture.js` handles everything hands-related. They share a small global `APP` state object defined in `index.html` that both JS files read from.

---

## How the Code Works

### index.html

The HTML file is the UI shell. It defines the layer stack that makes everything work visually:

```
z-index 1  — <video>    camera feed, CSS scaleX(-1) mirrored, dimmed to 38%
z-index 2  — <canvas>   Three.js renders transparent 3D on top of the camera
z-index 3  — <canvas>   hand skeleton overlay, also CSS-mirrored
z-index 10 — <div>      UI panels (sidebar, topbar, status bar)
z-index 20 — <div>      cursors, toasts, dwell rings
```

The video element has `transform: scaleX(-1)` so the camera feed looks like a mirror, which is the natural expectation. The hand skeleton canvas has the same CSS flip. The Three.js canvas is fully transparent (`alpha: true`, `clearColor(0, 0)`) so the camera feed shows through.

The file also defines the shared `APP` object:

```javascript
const APP = {
  mode:  'create',  // 'create' | 'edit' | 'draw'
  shape: 'box',
  color: '#60a5fa',
  sz:    1.0,
  tm:    'move',    // 'move' | 'rotate' | 'scale'
  drawY: 0,         // Y height of the 3D drawing plane
};
```

Both `scene.js` and `gesture.js` read from this object. Mode switching, shape selection, color picking — all just update `APP` and let each file react accordingly.

---

### scene.js

Handles everything Three.js-related. Loaded after `index.html` defines `APP`.

**Renderer setup**

```javascript
const renderer = new THREE.WebGLRenderer({ canvas: CV, antialias: true, alpha: true });
renderer.setClearColor(0, 0);  // alpha=0 so camera video shows through
```

**Orbit system**

The camera doesn't use any third-party orbit controls — it's a hand-rolled spherical coordinate system:

```javascript
const ORB = { th: 0.55, ph: 0.82, r: 12, tx: 0, ty: 0, tz: 0 };

function syncCam() {
  cam3d.position.set(
    ORB.tx + ORB.r * Math.sin(ORB.ph) * Math.sin(ORB.th),
    ORB.ty + ORB.r * Math.cos(ORB.ph),
    ORB.tz + ORB.r * Math.sin(ORB.ph) * Math.cos(ORB.th)
  );
  cam3d.lookAt(ORB.tx, ORB.ty, ORB.tz);
}
```

`th` = horizontal angle (theta), `ph` = vertical angle (phi), `r` = distance from target. Gesture deltas just add to `th` and `ph` each frame.

**Object placement via raycasting**

Objects are placed by casting a ray from the camera through the pinch point on screen into an invisible ground plane:

```javascript
RAY.setFromCamera(toNDC(sx, sy), cam3d);
const hits = RAY.intersectObject(groundMesh);
const pos  = hits[0].point.clone().setY(APP.sz * 0.5);
```

**Object data model**

Every spawned mesh carries its own metadata via `userData`:

```javascript
mesh.userData = {
  id:    ++OBJ_CTR,
  shape: 'box',
  color: '#60a5fa',
  label: 'Box 1',
  bbox:  <BoxHelper>,   // selection outline
};
```

**Save / Load**

Models are serialised to a plain JSON structure and stored in `localStorage`:

```javascript
{
  id: 1718293847000,
  name: "My Model",
  date: "6/13/2025",
  objs: [
    {
      shape: "box", color: "#60a5fa",
      pos: [1.2, 0.5, -0.8],
      rot: [0, 0.45, 0],
      sc:  [1.0, 1.0, 1.0]
    }
  ]
}
```

---

### gesture.js

This is the most technically involved file. It handles the webcam, runs MediaPipe, and contains eight independent gesture state machines.

**The Four Pillars of Accurate Gesture Tracking**

The raw MediaPipe output is useful but imprecise. These four techniques stack on top of each other to turn it into something that actually feels controlled.

**1. Landmark EMA Smoothing**

Every landmark's (x, y, z) position is smoothed using an exponential moving average before any gesture classification happens:

```javascript
const EMA_ALPHA = 0.50;

function smoothLandmarks(label, rawLm) {
  const prev = smoothedLm[label];
  rawLm.forEach((p, i) => {
    prev[i].x = EMA_ALPHA * p.x + (1 - EMA_ALPHA) * prev[i].x;
    prev[i].y = EMA_ALPHA * p.y + (1 - EMA_ALPHA) * prev[i].y;
    prev[i].z = EMA_ALPHA * p.z + (1 - EMA_ALPHA) * prev[i].z;
  });
  return prev;
}
```

Alpha 0.5 means each new frame is half new data, half history. Raw MediaPipe has ~5-8px of jitter per frame. After this pass it's ~1px. The cursor gets a second pass at alpha 0.40 on top of this.

**2. Gesture Vote Buffer**

Instead of using the gesture classified from each individual frame, the last 5 frames are kept in a ring buffer. A gesture only registers if it wins at least 3 of the 5 most recent frames:

```javascript
const VOTE_WINDOW = 5;
const VOTE_THRESH = 3;

function voteGesture(label, rawGest) {
  const buf = gestureBuffers[label];
  buf.push(rawGest);
  if (buf.length > VOTE_WINDOW) buf.shift();
  // count, find winner, require VOTE_THRESH agreement
}
```

This kills single-frame noise completely. A hand tremor that briefly opens the fist for one frame won't break a drag operation.

**3. Hysteretic Pinch Threshold**

The pinch gesture uses different thresholds for entering and exiting:

```javascript
const PINCH_ON  = 0.065;  // enter pinch state below this distance
const PINCH_OFF = 0.095;  // exit pinch state above this distance
```

The gap between 0.065 and 0.095 means hands naturally hovering near the threshold don't bounce in and out of pinch state. Once you commit a pinch, it stays until you clearly open your hand.

**4. Orbit Inertia**

When the orbit gesture ends, a velocity is stored and decays over ~400ms:

```javascript
const ORBIT_DECAY = 0.88;  // applied every frame at ~30fps

function updateInertia() {
  orbitVel.th *= ORBIT_DECAY;
  orbitVel.ph *= ORBIT_DECAY;
  ORB.th += orbitVel.th;
  ORB.ph  = clamp(ORB.ph + orbitVel.ph);
  syncCam();
}
```

This is called from the Three.js render loop (`scene.js`) every frame. The camera glides to a stop naturally rather than cutting dead.

**The Eight State Machines**

Each gesture type has a completely isolated state object and function — no shared state between machines:

| Machine | Gesture | What it does |
|---|---|---|
| `PD` | Pinch | Drag objects, placement intent timer |
| `TP` | Both pinch | Two-hand scale, rotate, lift |
| `FO` | Fist | Camera orbit (wrist-anchored) |
| `OO` | Open palm | Camera orbit (palm-centre-anchored) |
| `BFZ` | Both fists | Viewport zoom |
| `PH` | Peace hold | Delete with progress arc |
| `TV` | Thumbs up | Cycle elevation views |
| `DL` | Draw pinch | Freehand 3D line tracing |

The ninth feature, dwell click, runs across all modes and maps the pointing gesture to UI button activation.

**Mirror Compensation**

MediaPipe processes the raw (un-mirrored) camera feed and labels hands from the camera's perspective. Our video element is CSS-flipped. So labels are swapped on input:

```javascript
const raw   = results.multiHandedness[i].label; // camera's POV
const label = raw === 'Left' ? 'Right' : 'Left'; // person's POV
```

And landmarks are flipped when converting to screen coordinates:

```javascript
function lmScreen(pt) {
  return {
    x: (1 - pt.x) * innerWidth,  // flip X
    y:       pt.y  * innerHeight, // Y unchanged
  };
}
```

But when drawing the skeleton on the hand overlay canvas (which also has CSS `scaleX(-1)`), we draw in raw landmark space and let CSS handle the flip:

```javascript
hCtx.moveTo(lm[a].x * W, lm[a].y * H);  // raw, no flip
```

**The Draw Line System**

In Draw mode, pinching traces a 3D line projected onto a horizontal plane at a configurable height:

```javascript
const _drawPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
_drawPlane.rotation.x = -Math.PI / 2;
```

Points are sampled only when the hand moves more than `DRAW_MIN_DIST = 0.010` landmark units — a distance gate that prevents noise-generated points when the hand is roughly still.

A live preview line is built with a pre-allocated `Float32Array` and `DynamicDrawUsage` so Three.js knows to re-upload it to the GPU every frame without creating a new buffer:

```javascript
const attr = new THREE.BufferAttribute(buf, 3);
attr.setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', attr);
```

On release, the live line is removed and a compact committed line is built from just the sampled points. Lines can then be closed (start point appended to end) or extruded into a 3D wall mesh by building quad triangles between consecutive points.

---

## Technology Stack

| Technology | Version | Purpose |
|---|---|---|
| **Three.js** | r128 | 3D rendering engine — scene, meshes, lights, camera, raycasting |
| **MediaPipe Hands** | 0.4 | Real-time hand landmark detection (21 landmarks per hand) |
| **MediaPipe Drawing Utils** | 0.3 | Landmark drawing helpers (used for reference, custom drawing used instead) |
| **Web APIs** | — | `getUserMedia` (camera), `localStorage` (save), `Blob/URL` (export) |
| **Vanilla JS** | ES2020 | No framework, no build step, no bundler |
| **CSS** | — | Layer stack, glass panels, dwell ring, cursor styles |
| **Google Fonts** | — | Inter (UI text), JetBrains Mono (numbers, code labels) |

No npm. No webpack. No React. The entire application runs from three plain files.

---

## Browser Compatibility

| Browser | Support |
|---|---|
| Chrome 90+ | ✅ Full support |
| Edge 90+ | ✅ Full support |
| Firefox | ⚠️ Camera works, MediaPipe may be slower |
| Safari | ⚠️ Partial — WebGL works, `getUserMedia` requires HTTPS |

Chrome is recommended. MediaPipe's WASM runtime performs best in V8.

---

## Known Constraints

- **Lighting matters.** MediaPipe hand detection works poorly in dim light. A well-lit face and hands significantly improves tracking confidence.
- **Background complexity.** Busy or high-contrast backgrounds can confuse the detection model at edges. Plain or softly blurred backgrounds work better.
- **Hand occlusion.** When one hand is fully behind the other, MediaPipe can misidentify which is which. This is a model limitation, not a code issue.
- **File protocol.** Running `index.html` by double-clicking it will fail with a camera error. Must be served over HTTP or HTTPS.
- **`LineBasicMaterial.linewidth`** is limited to 1px on most GPUs due to a WebGL limitation. The lines render correctly but always appear 1px wide in the 3D scene.

---

## License

MIT License — free to use, modify, and distribute with attribution.

---

Made with ❤️ by **Mohammad Shakeel**
