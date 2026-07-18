/**
 * Hi-res 3D Moon — rotate / zoom / pan · double-tap reset.
 * Phase lighting from ephemeris + observer lat/lon.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RADIUS = 1;
/** How much of the host’s shorter side the disk fills at home ( <1 keeps clear of edges ). */
const HOME_FILL = 0.86;
const MIN_DIST = 1.12;
const TAP_SLOP = 14;
const DOUBLE_TAP_MS = 320;
/** Closer than this fraction of home distance → drag pans (explore); else rotate. */
const ZOOM_PAN_FRAC = 0.93;

/**
 * Three.js SphereGeometry puts equirect u=0.5 (map center / 0° lon) on +X.
 * Camera is on +Z looking at the origin (sees the +Z face).
 * Right-hand yaw: y = −π/2 takes +X → +Z, so near-side center faces Earth.
 * Do NOT use scale.y = -1 to “fix poles” — that turns the mesh inside-out
 * (upside-down + mirrored). North is already image-top with flipY + sphere UVs.
 */
const NEAR_SIDE_Y = -Math.PI / 2;

// Err toward detail/res on common phones (8K color + strong normals + dense mesh).
const LOD = {
  low: { map: "moon-2k.jpg", normal: "moon-normal-2k.jpg", segments: 128, normalScale: 1.55 },
  high: { map: "moon-8k.jpg", normal: "moon-normal-4k.jpg", segments: 224, normalScale: 2.25 },
};

const _toSun = new THREE.Vector3();
const _toEarth = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 0, 1);

function phaseName(phase01) {
  if (phase01 < 0.03 || phase01 > 0.97) return "New Moon";
  if (phase01 < 0.22) return "Waxing Crescent";
  if (phase01 < 0.28) return "First Quarter";
  if (phase01 < 0.47) return "Waxing Gibbous";
  if (phase01 < 0.53) return "Full Moon";
  if (phase01 < 0.72) return "Waning Gibbous";
  if (phase01 < 0.78) return "Last Quarter";
  return "Waning Crescent";
}

/** Parallactic angle (rad): disk roll as seen from lat/lon at `date`. */
function skyRollRad(latDeg, lonDeg, date) {
  const A = globalThis.Astronomy;
  if (!A) return 0;
  try {
    const time = A.MakeTime(date);
    const obs = new A.Observer(latDeg, lonDeg, 0);
    const eq = A.Equator(A.Body.Moon, time, obs, true, true);
    const gst = A.SiderealTime(time);
    let haHours = gst + lonDeg / 15 - eq.ra;
    while (haHours < -12) haHours += 24;
    while (haHours > 12) haHours -= 24;
    const ha = haHours * A.HOUR2RAD;
    const lat = latDeg * A.DEG2RAD;
    const dec = eq.dec * A.DEG2RAD;
    return Math.atan2(
      Math.sin(ha),
      Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha)
    );
  } catch (_) {
    return 0;
  }
}

export function createMoonGlobe(canvas, options = {}) {
  const { onReady = null, onQuality = null, onPhase = null } = options;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
  camera.position.set(0, 0, 3.2);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  renderer.setClearColor(0x020308, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Keep contrast so phase terminator stays crisp
  renderer.toneMappingExposure = 1.0;

  const moonGroup = new THREE.Group();
  scene.add(moonGroup);

  const loader = new THREE.TextureLoader();
  let mesh = null;
  let material = null;
  let ready = false;
  let hqStarted = false;
  let disposed = false;
  let animId = 0;
  let width = 0;
  let height = 0;
  let homeDist = 3.2;
  let controlMode = "orbit"; // "orbit" | "explore"

  /**
   * Lighting profiles — dualMode blends earth ↔ orbit by camera angle.
   * REVERT: set dualMode: false (uses `orbit` numbers only, previous “readable dark”).
   */
  const LIGHTING = {
    dualMode: true, // false = always use `orbit` (easy revert)
    keyBase: 2.0,
    keyFracGain: 0.85,
    // Face-on Earth view: punchy crescent / terminator
    earth: {
      ambient: 0.04,
      earthshineBase: 0.1,
      earthshineNewGain: 0.36,
      emissive: 0.04,
    },
    // Orbiting / night side: readable craters
    orbit: {
      ambient: 0.09,
      earthshineBase: 0.18,
      earthshineNewGain: 0.48,
      emissive: 0.12,
    },
  };

  const key = new THREE.DirectionalLight(0xfff2e6, LIGHTING.keyBase + LIGHTING.keyFracGain);
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0, 0, 0);

  // Earthshine only from Earth (+Z) — lights the night *near side*, not a global wash
  const earthshine = new THREE.DirectionalLight(0x9eb4d4, LIGHTING.orbit.earthshineBase);
  earthshine.position.set(0, 0.1, 10);
  scene.add(earthshine);

  const ambient = new THREE.AmbientLight(0x141820, LIGHTING.orbit.ambient);
  scene.add(ambient);

  let lastFrac = 0.5;
  const _camDir = new THREE.Vector3();

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.enableZoom = true;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = homeDist;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 5.2;
  controls.panSpeed = 0.85;
  controls.target.set(0, 0, 0);
  controls.minPolarAngle = 0.01;
  controls.maxPolarAngle = Math.PI - 0.01;
  // Home: rotate. Zoomed-in explore: one-finger pan so the moon can be moved on screen.
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

  let pointerDown = null;
  let lastTapAt = 0;

  let observerLat = 0;
  let observerLon = 0;
  let when = new Date();
  let lastPhaseInfo = null;

  // Compromise while scrubbing: freeze sky *roll* (location/time of day),
  // but still let libration follow the phase date (moon rocks a little).
  let orientLocked = false;
  let frozenRoll = 0;
  let frozenSouthern = false;

  function configureColor(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    // Equirect maps: keep north at image top aligned with SphereGeometry north (+Y)
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  function configureNormal(tex) {
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }

  function buildMesh(map, normal, cfg) {
    if (mesh) {
      moonGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (material) {
      material.dispose();
      material = null;
    }

    material = new THREE.MeshStandardMaterial({
      map,
      normalMap: normal || null,
      normalScale: new THREE.Vector2(cfg.normalScale, cfg.normalScale),
      roughness: 0.9,
      metalness: 0.0,
      // Very low self-glow so orbited night terrain has a whisper of albedo —
      // not enough to flatten phase contrast from the Earth view.
      emissiveMap: map,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: LIGHTING.orbit.emissive,
    });
    material.color.setRGB(1.04, 1.02, 1.0);

    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments),
      material
    );
    moonGroup.add(mesh);
    applyEphemeris();
  }

  function loadLow() {
    const cfg = LOD.low;
    const map = loader.load(cfg.map, (tex) => {
      configureColor(tex);
      ready = true;
      if (typeof onReady === "function") onReady();
      if (typeof onQuality === "function") onQuality("2k");
      if (!hqStarted) {
        hqStarted = true;
        setTimeout(() => upgradeHigh(), 400);
      }
    });
    const normal = loader.load(cfg.normal, configureNormal);
    configureColor(map);
    configureNormal(normal);
    buildMesh(map, normal, cfg);
  }

  function upgradeHigh() {
    if (disposed) return;
    const cfg = LOD.high;
    let mapDone = null;
    let normalDone = null;

    const tryApply = () => {
      if (disposed || !material || !mapDone) return;
      const oldMap = material.map;
      const oldNormal = material.normalMap;
      material.map = mapDone;
      material.emissiveMap = mapDone;
      if (normalDone) material.normalMap = normalDone;
      material.normalScale.set(cfg.normalScale, cfg.normalScale);
      material.needsUpdate = true;
      if (oldMap && oldMap !== mapDone) oldMap.dispose();
      if (normalDone && oldNormal && oldNormal !== normalDone) oldNormal.dispose();

      if (mesh && mesh.geometry.parameters.widthSegments < cfg.segments) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments);
      }
      if (typeof onQuality === "function") onQuality("8k");
    };

    loader.load(cfg.map, (tex) => {
      if (disposed) return;
      configureColor(tex);
      mapDone = tex;
      tryApply();
    });
    loader.load(cfg.normal, (tex) => {
      if (disposed) return;
      configureNormal(tex);
      normalDone = tex;
      tryApply();
    });
  }

  function captureSkyPose(date = new Date()) {
    frozenSouthern = observerLat < 0;
    frozenRoll = skyRollRad(observerLat, observerLon, date);
  }

  /**
   * Lighting always follows `when` (phase).
   * Sky roll: live for location, or frozen while scrubbing (keeps calm).
   * Libration: always follows `when` — the real small rock over a month.
   */
  function applyEphemeris() {
    const A = globalThis.Astronomy;
    if (!A) return;

    const time = A.MakeTime(when);
    const moon = A.GeoVector(A.Body.Moon, time, false);
    const sun = A.GeoVector(A.Body.Sun, time, false);
    const illum = A.Illumination(A.Body.Moon, time);
    const phase01 = (((A.MoonPhase(when) % 360) + 360) % 360) / 360;
    const frac = illum.phase_fraction;

    _toSun.set(sun.x - moon.x, sun.y - moon.y, sun.z - moon.z).normalize();
    _toEarth.set(-moon.x, -moon.y, -moon.z).normalize();

    // Basis: Z → Earth (camera), Y ≈ north, X ≈ east
    _zAxis.copy(_toEarth);
    _xAxis.crossVectors(_worldUp, _zAxis);
    if (_xAxis.lengthSq() < 1e-10) _xAxis.set(1, 0, 0);
    _xAxis.normalize();
    _yAxis.crossVectors(_zAxis, _xAxis).normalize();

    const lx = _toSun.dot(_xAxis);
    const ly = _toSun.dot(_yAxis);
    const lz = _toSun.dot(_zAxis);

    lastFrac = frac;
    // Sun key dominates — this is the phase terminator (same in both modes)
    key.position.set(lx, ly, lz).multiplyScalar(12);
    key.intensity = LIGHTING.keyBase + frac * LIGHTING.keyFracGain;
    // Earthshine from Earth only; strength set in updateViewLighting
    earthshine.position.set(0.04, 0.08, 10);
    updateViewLighting();

    // Libration always tracks the phase date (subtle face rock)
    const lib = A.Libration(time);
    const southern = orientLocked ? frozenSouthern : observerLat < 0;

    // Live Earth view = north-up chart orientation (familiar face).
    // Parallactic “sky tilt” was rolling the disk so poles looked wrong and
    // needed a clockwise drag to “fix” — disable for default/Live.
    // (Can return later as an optional sky-pose mode.)
    const roll = 0;

    if (mesh) {
      // YXZ: yaw near-side to camera, tip for lat libration (north-up)
      mesh.rotation.order = "YXZ";
      mesh.rotation.y = NEAR_SIDE_Y + lib.elon * A.DEG2RAD;
      mesh.rotation.x = -lib.elat * A.DEG2RAD;
      mesh.rotation.z = 0;
    }
    // Southern hemisphere: 180° around the view axis (classic N/S flip)
    const zRot = southern ? Math.PI : 0;
    moonGroup.rotation.set(0, 0, zRot);
    const viewZ = new THREE.Vector3(0, 0, 1);
    key.position.applyAxisAngle(viewZ, zRot);
    earthshine.position.applyAxisAngle(viewZ, zRot);

    lastPhaseInfo = {
      phase01,
      fraction: frac,
      name: phaseName(phase01),
      lat: observerLat,
      lon: observerLon,
      when: new Date(when.getTime()),
      elon: lib.elon,
      elat: lib.elat,
      southern,
      orientLocked,
    };
    if (typeof onPhase === "function") onPhase(lastPhaseInfo);
  }

  function setObserver(lat, lon) {
    let la = Number(lat);
    let lo = Number(lon);
    if (!Number.isFinite(la)) la = 0;
    if (!Number.isFinite(lo)) lo = 0;
    observerLat = THREE.MathUtils.clamp(la, -90, 90);
    while (lo > 180) lo -= 360;
    while (lo < -180) lo += 360;
    observerLon = lo;
    // New place: refresh frozen sky pose from *now* so location still matters mid-scrub
    if (orientLocked) captureSkyPose(new Date());
    applyEphemeris();
    return getPhaseInfo();
  }

  /**
   * @param {Date|number|string} [date]
   * @param {{ lockOrient?: boolean, orientDate?: Date }} [opts]
   *   lockOrient true  → freeze sky pose (first time) for calm phase scrubbing
   *   lockOrient false → live sky pose for location + time
   */
  function setTime(date = new Date(), opts = {}) {
    when = date instanceof Date ? date : new Date(date);
    if (opts.lockOrient === false) {
      orientLocked = false;
    } else if (opts.lockOrient === true && !orientLocked) {
      captureSkyPose(opts.orientDate || new Date());
      orientLocked = true;
    }
    applyEphemeris();
    return getPhaseInfo();
  }

  function getPhaseInfo() {
    return lastPhaseInfo;
  }

  function getObserver() {
    return { lat: observerLat, lon: observerLon };
  }

  /** 1 = face-on Earth view (crescent contrast), 0 = orbiting / night side (readable). */
  function earthViewAmount() {
    _camDir.copy(camera.position).sub(controls.target).normalize();
    // Near side faces +Z; face-on when looking along +Z
    return THREE.MathUtils.smoothstep(0.38, 0.88, _camDir.z);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updateViewLighting() {
    const frac = lastFrac;
    const e = LIGHTING.earth;
    const o = LIGHTING.orbit;
    // dualMode off → always orbit profile (previous single-look)
    const t = LIGHTING.dualMode ? earthViewAmount() : 0;
    // t=1 earth (high contrast), t=0 orbit (lifted dark)
    ambient.intensity = lerp(o.ambient, e.ambient, t);
    earthshine.intensity =
      lerp(o.earthshineBase, e.earthshineBase, t) +
      (1 - frac) * lerp(o.earthshineNewGain, e.earthshineNewGain, t);
    if (material) {
      material.emissiveIntensity = lerp(o.emissive, e.emissive, t);
    }
    key.intensity = LIGHTING.keyBase + frac * LIGHTING.keyFracGain;
  }

  /** Camera distance so a unit sphere fills HOME_FILL of the shorter viewport side. */
  function computeHomeDistance(w, h) {
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // Distance so radius RADIUS subtends half the fitted size
    const fit = HOME_FILL;
    const distV = RADIUS / (fit * Math.tan(vFov / 2));
    const distH = RADIUS / (fit * Math.tan(hFov / 2));
    return Math.max(distV, distH, MIN_DIST + 0.2);
  }

  function applyHomeFraming(force = false) {
    const wasHome =
      !force &&
      controls.target.lengthSq() < 1e-6 &&
      Math.abs(camera.position.distanceTo(controls.target) - homeDist) < 0.04;
    controls.target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, homeDist);
    controls.minDistance = MIN_DIST;
    controls.maxDistance = homeDist;
    controls.update();
    setControlMode("orbit");
    return wasHome;
  }

  function setControlMode(mode) {
    if (mode === controlMode) return;
    controlMode = mode;
    if (mode === "explore") {
      // Drag moves the moon on screen; pinch zooms; two-finger can still orbit a bit
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.panSpeed = 1.15;
    } else {
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.panSpeed = 0.85;
    }
  }

  function updateZoomInteraction() {
    const dist = camera.position.distanceTo(controls.target);
    // Fully zoomed out → snap home (size + centered at top host)
    if (dist >= homeDist * 0.985) {
      if (
        controls.target.lengthSq() > 1e-5 ||
        Math.abs(dist - homeDist) > 0.02 ||
        Math.abs(camera.position.x) > 0.02 ||
        Math.abs(camera.position.y) > 0.02
      ) {
        applyHomeFraming(true);
      } else {
        setControlMode("orbit");
      }
      return;
    }
    // Zoomed in: pan to explore; keep target from flying too far from the moon
    setControlMode(dist < homeDist * ZOOM_PAN_FRAC ? "explore" : "orbit");
    const maxPan = RADIUS * 1.15;
    if (controls.target.length() > maxPan) {
      controls.target.setLength(maxPan);
    }
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height) return;
    const prevHome = homeDist;
    const dist = camera.position.distanceTo(controls.target);
    const atHome = dist >= prevHome * 0.97 && controls.target.lengthSq() < 1e-4;
    width = w;
    height = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    homeDist = computeHomeDistance(w, h);
    controls.maxDistance = homeDist;
    if (atHome) applyHomeFraming(true);
  }

  function fitToHost() {
    const host = canvas.parentElement || canvas;
    const rect = host.getBoundingClientRect();
    resize(rect.width || window.innerWidth, rect.height || window.innerHeight);
  }

  function resetView() {
    camera.fov = 40;
    camera.near = 0.05;
    camera.far = 80;
    camera.updateProjectionMatrix();
    applyHomeFraming(true);
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function onPointerUp(e) {
    if (!pointerDown) return;
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    const dt = performance.now() - pointerDown.t;
    pointerDown = null;
    if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) return;
    if (dt > 500) return;

    const now = performance.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0;
      resetView();
      return;
    }
    lastTapAt = now;
  }

  function onPointerCancel() {
    pointerDown = null;
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);

  function animate() {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    controls.update();
    updateZoomInteraction();
    updateViewLighting();
    renderer.render(scene, camera);
  }

  // Initial ephemeris (geocentric default lat 0 until app sets location)
  applyEphemeris();
  loadLow();
  fitToHost();
  applyHomeFraming(true);
  animate();

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setTime,
    getPhaseInfo,
    getObserver,
    isReady: () => ready,
    dispose() {
      disposed = true;
      cancelAnimationFrame(animId);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      controls.dispose();
      if (mesh) {
        mesh.geometry.dispose();
        material?.map?.dispose();
        material?.normalMap?.dispose();
        material?.dispose();
      }
      renderer.dispose();
    },
  };
}
