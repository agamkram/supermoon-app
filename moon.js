/**
 * Hi-res 3D Moon
 * 1-finger orbit (pole stop, footprint) · pinch zoom · 2-finger pan · Live/home reset
 */
import * as THREE from "three";

const RADIUS = 1;
/** Home disk fill of the moon host (light padding). */
const HOME_FILL = 0.9;
/** Close zoom — disk can leave the frame. */
const MIN_DIST = 1.02;
const MIN_POLAR = 0.15;
const MAX_POLAR = Math.PI - 0.15;
/** Pinch strength per frame (frame-to-frame span only). */
const PINCH_POWER = 0.38;
const PINCH_EPS = 0.006;
const WHEEL_DOLLY = 0.0012;
const MAX_PAN = RADIUS * 24;

/**
 * Three.js SphereGeometry: equirect u=0.5 on +X.
 * Camera on +Z; NEAR_SIDE_Y puts map center on +Z (Earth view).
 */
const NEAR_SIDE_Y = -Math.PI / 2;

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
  const surface =
    (typeof document !== "undefined" && document.getElementById("touch-plane")) ||
    canvas;

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
  renderer.toneMappingExposure = 1.0;

  // moonGroup at orbit target (always); mesh = near-side + libration
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

  const LIGHTING = {
    dualMode: true,
    keyBase: 2.0,
    keyFracGain: 0.85,
    earth: {
      ambient: 0.04,
      earthshineBase: 0.1,
      earthshineNewGain: 0.36,
      emissive: 0.04,
    },
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

  const earthshine = new THREE.DirectionalLight(0x9eb4d4, LIGHTING.orbit.earthshineBase);
  earthshine.position.set(0, 0.1, 10);
  scene.add(earthshine);

  const ambient = new THREE.AmbientLight(0x141820, LIGHTING.orbit.ambient);
  scene.add(ambient);

  let lastFrac = 0.5;
  const _camDir = new THREE.Vector3();

  // —— Camera: orbit around `target`; moon sits on `target` (no swing) ——
  const target = new THREE.Vector3(0, 0, 0);
  const spherical = new THREE.Spherical();
  const _offset = new THREE.Vector3();
  const _panRight = new THREE.Vector3();
  const _panUp = new THREE.Vector3();

  /** @type {null | { id: number, x: number, y: number }} */
  let orbitDrag = null;
  /** @type {null | { span: number, midX: number, midY: number }} */
  let twoBase = null;

  let observerLat = 0;
  let observerLon = 0;
  let when = new Date();
  let lastPhaseInfo = null;
  let orientLocked = false;
  let frozenRoll = 0;
  let frozenSouthern = false;

  function configureColor(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
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

    _zAxis.copy(_toEarth);
    _xAxis.crossVectors(_worldUp, _zAxis);
    if (_xAxis.lengthSq() < 1e-10) _xAxis.set(1, 0, 0);
    _xAxis.normalize();
    _yAxis.crossVectors(_zAxis, _xAxis).normalize();

    const lx = _toSun.dot(_xAxis);
    const ly = _toSun.dot(_yAxis);
    const lz = _toSun.dot(_zAxis);

    lastFrac = frac;
    key.position.set(lx, ly, lz).multiplyScalar(12).add(target);
    key.target.position.copy(target);
    key.intensity = LIGHTING.keyBase + frac * LIGHTING.keyFracGain;
    earthshine.position.set(0.04, 0.08, 10).add(target);
    updateViewLighting();

    const lib = A.Libration(time);
    const southern = orientLocked ? frozenSouthern : observerLat < 0;
    const roll = 0;

    if (mesh) {
      mesh.rotation.order = "YXZ";
      mesh.rotation.y = NEAR_SIDE_Y + lib.elon * A.DEG2RAD;
      mesh.rotation.x = -lib.elat * A.DEG2RAD;
      mesh.rotation.z = 0;
    }
    const zRot = southern ? Math.PI : 0;
    moonGroup.rotation.set(0, 0, zRot);
    moonGroup.position.copy(target);
    const viewZ = new THREE.Vector3(0, 0, 1);
    key.position.sub(target).applyAxisAngle(viewZ, zRot).add(target);
    earthshine.position.sub(target).applyAxisAngle(viewZ, zRot).add(target);

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
    if (orientLocked) captureSkyPose(new Date());
    applyEphemeris();
    return getPhaseInfo();
  }

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

  function earthViewAmount() {
    _camDir.copy(camera.position).sub(target).normalize();
    return THREE.MathUtils.smoothstep(0.38, 0.88, _camDir.z);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updateViewLighting() {
    const frac = lastFrac;
    const e = LIGHTING.earth;
    const o = LIGHTING.orbit;
    const t = LIGHTING.dualMode ? earthViewAmount() : 0;
    ambient.intensity = lerp(o.ambient, e.ambient, t);
    earthshine.intensity =
      lerp(o.earthshineBase, e.earthshineBase, t) +
      (1 - frac) * lerp(o.earthshineNewGain, e.earthshineNewGain, t);
    if (material) {
      material.emissiveIntensity = lerp(o.emissive, e.emissive, t);
    }
    key.intensity = LIGHTING.keyBase + frac * LIGHTING.keyFracGain;
  }

  // —— Camera helpers ——

  function readSpherical() {
    _offset.copy(camera.position).sub(target);
    if (_offset.lengthSq() < 1e-12) _offset.set(0, 0, homeDist || 3);
    spherical.setFromVector3(_offset);
  }

  function writeCamera() {
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius,
      MIN_DIST,
      Math.max(homeDist, MIN_DIST + 0.2)
    );
    spherical.makeSafe();
    _offset.setFromSpherical(spherical);
    camera.position.copy(target).add(_offset);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncMoonToTarget() {
    moonGroup.position.copy(target);
    key.target.position.copy(target);
  }

  /**
   * Home size: fill the area above the bottom info reserve (light padding).
   * Canvas is full-window so zoom can grow to the entire screen; only *home*
   * distance is computed against the smaller “safe” band.
   */
  function readHomePadsPx() {
    let top = 48;
    let bottom = 248;
    if (typeof document !== "undefined") {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;pointer-events:none;width:0";
      document.body.appendChild(probe);
      probe.style.height = "calc(2rem + env(safe-area-inset-top, 0px))";
      top = probe.offsetHeight || top;
      probe.style.height = "calc(15.5rem + env(safe-area-inset-bottom, 0px))";
      bottom = probe.offsetHeight || bottom;
      probe.remove();
    }
    return { top, bottom };
  }

  function computeHomeDistance(w, h) {
    const pads = readHomePadsPx();
    const availH = Math.max(160, h - pads.top - pads.bottom);
    const availW = Math.max(160, w - 24);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fit = HOME_FILL;
    // diameter_px ≈ R * viewport / (d * tan(fov/2)); want diameter = fit * avail
    const distV = (RADIUS * h) / (fit * availH * Math.tan(vFov / 2));
    const distH = (RADIUS * w) / (fit * availW * Math.tan(hFov / 2));
    return Math.max(distV, distH, MIN_DIST + 0.2);
  }

  /** Starting place + size + face-on. */
  function applyHomeFraming() {
    target.set(0, 0, 0);
    syncMoonToTarget();
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, homeDist);
    readSpherical();
    writeCamera();
    applyEphemeris();
  }

  /**
   * Zoom. Pinch/spread uses frame deltas only.
   * Reaching max distance from a closer view → full home.
   */
  function setCamDist(dist) {
    const prev = camDist();
    const maxD = Math.max(homeDist, MIN_DIST + 0.2);
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, maxD);
    if (dist >= homeDist - 1e-4 && prev < homeDist * 0.99) {
      applyHomeFraming();
      return;
    }
    readSpherical();
    spherical.radius = dist;
    writeCamera();
  }

  /** 2fs: move moon + camera + look-at together. */
  function panCamera(dxPx, dyPx) {
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return;
    const dist = Math.max(camDist(), MIN_DIST);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const worldPerPx = (2 * dist * Math.tan(vFov / 2)) / Math.max(height, 1);
    _panRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _panUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const sx = -dxPx * worldPerPx;
    const sy = dyPx * worldPerPx;
    target.addScaledVector(_panRight, sx);
    target.addScaledVector(_panUp, sy);
    camera.position.addScaledVector(_panRight, sx);
    camera.position.addScaledVector(_panUp, sy);

    const horiz = Math.hypot(target.x, target.z);
    if (horiz > MAX_PAN) {
      const s = MAX_PAN / horiz;
      const nx = target.x * s;
      const nz = target.z * s;
      camera.position.x += nx - target.x;
      camera.position.z += nz - target.z;
      target.x = nx;
      target.z = nz;
    }
    if (Math.abs(target.y) > MAX_PAN) {
      const ny = Math.sign(target.y) * MAX_PAN;
      camera.position.y += ny - target.y;
      target.y = ny;
    }
    syncMoonToTarget();
    readSpherical();
  }

  function rotateSpeed() {
    const dist = camDist();
    const t = THREE.MathUtils.clamp(
      (dist - MIN_DIST) / Math.max(homeDist - MIN_DIST, 0.01),
      0,
      1
    );
    const z = t * t;
    return THREE.MathUtils.lerp(0.28, 0.55, z);
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height) return;

    const prevHome = homeDist;
    const dist = camDist();
    const atHome = dist >= prevHome * 0.97 && target.lengthSq() < 1e-4;
    const zoomFrac = prevHome > 0 ? dist / prevHome : 1;

    width = w;
    height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
    renderer.setSize(w, h, false);

    homeDist = computeHomeDistance(w, h);
    if (atHome) applyHomeFraming();
    else setCamDist(homeDist * zoomFrac);
  }

  function fitToHost() {
    // Full window — not the old inset host box
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    resize(w, h);
  }

  function resetView() {
    camera.fov = 40;
    camera.near = 0.05;
    camera.far = 80;
    camera.updateProjectionMatrix();
    homeDist = computeHomeDistance(
      width || window.innerWidth,
      height || window.innerHeight
    );
    applyHomeFraming();
  }

  // —— Phone gestures: window capture so 2fs is never lost to other layers ——
  // 1 finger = orbit · 2fs (slide) = pan · pinch = zoom

  function isFormControl(el) {
    if (!el || !el.closest) return false;
    return !!el.closest("input, button, select, textarea, a, label");
  }

  function midSpanFromTouches(touchList) {
    if (!touchList || touchList.length < 2) return null;
    const a = touchList[0];
    const b = touchList[1];
    return {
      span: Math.max(
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        1
      ),
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
    };
  }

  function onTouchStart(e) {
    // Let slider / Live / inputs work
    if (e.touches.length === 1 && isFormControl(e.target)) return;

    e.preventDefault();
    if (e.touches.length >= 2) {
      twoBase = midSpanFromTouches(e.touches);
      orbitDrag = null;
    } else if (e.touches.length === 1) {
      twoBase = null;
      const t = e.touches[0];
      orbitDrag = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 0) return;
    // If single finger on a form control, ignore
    if (e.touches.length === 1 && isFormControl(e.target) && !orbitDrag) return;

    e.preventDefault();

    // —— Two fingers: 2fs pan + pinch zoom ——
    if (e.touches.length >= 2) {
      const now = midSpanFromTouches(e.touches);
      if (!now) return;
      if (!twoBase) {
        twoBase = now;
        return;
      }

      const dMidX = now.midX - twoBase.midX;
      const dMidY = now.midY - twoBase.midY;
      const spanRatio = now.span / Math.max(twoBase.span, 1);
      const spanChange = Math.abs(Math.log(Math.max(spanRatio, 1e-6)));

      // 2fs — pan by midpoint (always)
      panCamera(dMidX, dMidY);

      // Pinch — frame-to-frame zoom
      if (spanChange > PINCH_EPS) {
        setCamDist(
          camDist() / Math.pow(Math.max(spanRatio, 0.05), PINCH_POWER)
        );
      }

      twoBase = now;
      return;
    }

    // —— One finger: orbit ——
    if (orbitDrag && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - orbitDrag.x;
      const dy = t.clientY - orbitDrag.y;
      const h = Math.max(height, 1);
      const speed = rotateSpeed();
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * speed) / h;
      spherical.phi -= (2 * Math.PI * dy * speed) / h;
      writeCamera();
      orbitDrag.x = t.clientX;
      orbitDrag.y = t.clientY;
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length >= 2) {
      twoBase = midSpanFromTouches(e.touches);
      orbitDrag = null;
    } else if (e.touches.length === 1) {
      twoBase = null;
      const t = e.touches[0];
      orbitDrag = { id: t.identifier, x: t.clientX, y: t.clientY };
    } else {
      twoBase = null;
      orbitDrag = null;
    }
  }

  // Desktop: left orbit · right/shift-left pan · wheel zoom
  let mouseMode = null;
  let mouseLast = null;

  function onMouseDown(e) {
    if (isFormControl(e.target)) return;
    if (e.button === 0 && e.shiftKey) mouseMode = "pan";
    else if (e.button === 0) mouseMode = "orbit";
    else if (e.button === 2) {
      mouseMode = "pan";
      e.preventDefault();
    } else return;
    mouseLast = { x: e.clientX, y: e.clientY };
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!mouseLast || !mouseMode) return;
    e.preventDefault();
    const dx = e.clientX - mouseLast.x;
    const dy = e.clientY - mouseLast.y;
    mouseLast = { x: e.clientX, y: e.clientY };
    if (mouseMode === "orbit") {
      const h = Math.max(height, 1);
      const speed = rotateSpeed();
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * speed) / h;
      spherical.phi -= (2 * Math.PI * dy * speed) / h;
      writeCamera();
    } else {
      panCamera(dx, dy);
    }
  }

  function onMouseUp() {
    mouseMode = null;
    mouseLast = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  function onWheel(e) {
    if (isFormControl(e.target)) return;
    e.preventDefault();
    setCamDist(camDist() * Math.exp(e.deltaY * WHEEL_DOLLY));
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  // Capture on window = 2nd finger always seen on iOS, regardless of hit target
  const touchOpts = { passive: false, capture: true };
  window.addEventListener("touchstart", onTouchStart, touchOpts);
  window.addEventListener("touchmove", onTouchMove, touchOpts);
  window.addEventListener("touchend", onTouchEnd, { capture: true });
  window.addEventListener("touchcancel", onTouchEnd, { capture: true });
  surface.addEventListener("mousedown", onMouseDown);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("contextmenu", onContextMenu);
  document.documentElement.style.touchAction = "none";
  document.body.style.touchAction = "none";
  surface.style.touchAction = "none";
  canvas.style.touchAction = "none";

  function animate() {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    updateViewLighting();
    renderer.render(scene, camera);
  }

  applyEphemeris();
  loadLow();
  fitToHost();
  applyHomeFraming();
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
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchEnd, true);
      surface.removeEventListener("mousedown", onMouseDown);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
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
