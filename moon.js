/**
 * Hi-res 3D Moon
 * 1-finger orbit · 2-finger pan (2fs) · pinch zoom · Live/home reset
 *
 * Multi-touch via OrbitControls on #touch-plane (reliable on phone).
 * Moon mesh is glued to controls.target every frame so pan/orbit stay locked.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RADIUS = 1;
/** Home disk fill of the safe band above the bottom info area. */
const HOME_FILL = 0.9;
/** Close zoom — disk can fill / leave the full screen. */
const MIN_DIST = 1.02;
const MIN_POLAR = 0.15;
const MAX_POLAR = Math.PI - 0.15;
const MAX_PAN = RADIUS * 20;

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
const _camDir = new THREE.Vector3();

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

  // —— OrbitControls on the full-screen touch plane (phone multi-touch works here) ——
  const controls = new OrbitControls(camera, surface);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.enableRotate = true;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = false;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = homeDist;
  controls.minPolarAngle = MIN_POLAR;
  controls.maxPolarAngle = MAX_POLAR;
  controls.target.set(0, 0, 0);
  // 1 finger = orbit · 2 fingers = pan + pinch zoom (standard OC mapping)
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 1.2;

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
    const t = controls.target;
    key.position.set(lx, ly, lz).multiplyScalar(12).add(t);
    key.target.position.copy(t);
    key.intensity = LIGHTING.keyBase + frac * LIGHTING.keyFracGain;
    earthshine.position.set(0.04, 0.08, 10).add(t);
    updateViewLighting();

    const lib = A.Libration(time);
    const southern = orientLocked ? frozenSouthern : observerLat < 0;

    if (mesh) {
      mesh.rotation.order = "YXZ";
      mesh.rotation.y = NEAR_SIDE_Y + lib.elon * A.DEG2RAD;
      mesh.rotation.x = -lib.elat * A.DEG2RAD;
      mesh.rotation.z = 0;
    }
    const zRot = southern ? Math.PI : 0;
    moonGroup.rotation.set(0, 0, zRot);
    moonGroup.position.copy(t);
    const viewZ = new THREE.Vector3(0, 0, 1);
    key.position.sub(t).applyAxisAngle(viewZ, zRot).add(t);
    earthshine.position.sub(t).applyAxisAngle(viewZ, zRot).add(t);

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
    _camDir.copy(camera.position).sub(controls.target).normalize();
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

  /**
   * Home distance for full-window canvas: disk sized to the band above the
   * bottom info area. Zoom can still go closer and fill the whole screen.
   */
  function computeHomeDistance(w, h) {
    const pads = readHomePadsPx();
    const availH = Math.max(160, h - pads.top - pads.bottom);
    const availW = Math.max(160, w - 24);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fit = HOME_FILL;
    const distV = (RADIUS * h) / (fit * availH * Math.tan(vFov / 2));
    const distH = (RADIUS * w) / (fit * availW * Math.tan(hFov / 2));
    return Math.max(distV, distH, MIN_DIST + 0.2);
  }

  function applyHomeFraming() {
    controls.target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, homeDist);
    controls.minDistance = MIN_DIST;
    controls.maxDistance = homeDist;
    controls.update();
    moonGroup.position.set(0, 0, 0);
    key.target.position.set(0, 0, 0);
    applyEphemeris();
  }

  function camDist() {
    return camera.position.distanceTo(controls.target);
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height) return;

    const prevHome = homeDist;
    const dist = camDist();
    const atHome = dist >= prevHome * 0.97 && controls.target.lengthSq() < 1e-4;
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
    controls.maxDistance = homeDist;
    controls.minDistance = MIN_DIST;

    if (atHome) {
      applyHomeFraming();
    } else {
      // Keep relative zoom level
      const d = THREE.MathUtils.clamp(homeDist * zoomFrac, MIN_DIST, homeDist);
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 1e-10) offset.set(0, 0, 1);
      offset.setLength(d);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    }
  }

  function fitToHost() {
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

  /** Keep mesh on orbit pivot so 2fs pan moves the moon, not empty space. */
  function syncMoonToControls() {
    moonGroup.position.copy(controls.target);
    key.target.position.copy(controls.target);

    // Soft pan bound
    if (controls.target.length() > MAX_PAN) {
      controls.target.setLength(MAX_PAN);
    }

    // Full un-zoom → home (size + center)
    const dist = camDist();
    if (
      dist >= homeDist * 0.985 &&
      (controls.target.lengthSq() > 1e-4 ||
        Math.abs(camera.position.x) > 0.02 ||
        Math.abs(camera.position.y) > 0.02 ||
        Math.abs(dist - homeDist) > 0.03)
    ) {
      applyHomeFraming();
    }
  }

  // Calm phone pinch a bit
  const isTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches;
  controls.zoomSpeed = isTouch ? 0.75 : 1.0;
  controls.rotateSpeed = isTouch ? 0.65 : 0.5;
  controls.panSpeed = isTouch ? 1.35 : 1.1;

  surface.style.touchAction = "none";
  canvas.style.touchAction = "none";
  if (typeof document !== "undefined") {
    document.documentElement.style.touchAction = "none";
    document.body.style.touchAction = "none";
  }

  function animate() {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    controls.update();
    syncMoonToControls();
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
