import glvec3 from "gl-vec3";
import { makeProfileHook } from "./util";

import {
  AmbientLight,
  BufferGeometry,
  Color,
  ColorManagement,
  DirectionalLight,
  DoubleSide,
  LinearSRGBColorSpace,
  Group,
  Line,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

import type { Engine } from "../index";

// profiling flag
var PROFILE = 0;

var defaults = {
  showFPS: false,
  antiAlias: true,
  clearColor: [0.8, 0.9, 1],
  ambientColor: [0.5, 0.5, 0.5],
  lightDiffuse: [1, 1, 1],
  lightSpecular: [1, 1, 1],
  lightVector: [1, -1, 0.5],
  useAO: true,
  AOmultipliers: [0.93, 0.8, 0.5],
  reverseAOmultiplier: 1.0,
  preserveDrawingBuffer: true,
  octreeBlockSize: 2,
  renderOnResize: true,
};

/*
 *    Coordinate conventions
 *
 *  Game logic runs in noa's left-handed voxel coordinates (heading 0
 *  faces +z). three.js is right-handed, so the renderer negates z at
 *  the game/render boundary:
 *
 *    render position = (x, y, -z)
 *    camera holder rotation (order YXZ): y = -heading, x = -pitch
 *
 *  This is the standard LH->RH conversion: applied consistently to the
 *  world data and the camera, it produces the same image Babylon did
 *  (not a mirrored one). Meshes parented into the scene are authored
 *  directly in three.js conventions (characters face local +z, MC-style).
 */

/**
 * `noa.rendering` -
 * Manages all rendering, and the three.js scene, materials, etc.
 *
 * This module uses the following default options (from the options
 * object passed to the {@link Engine}):
 * ```js
 * {
 *     showFPS: false,
 *     antiAlias: true,
 *     clearColor: [0.8, 0.9, 1],
 *     ambientColor: [0.5, 0.5, 0.5],
 *     lightDiffuse: [1, 1, 1],
 *     lightSpecular: [1, 1, 1],
 *     lightVector: [1, -1, 0.5],
 *     useAO: true,
 *     AOmultipliers: [0.93, 0.8, 0.5],
 *     reverseAOmultiplier: 1.0,
 *     preserveDrawingBuffer: true,
 *     renderOnResize: true,
 * }
 * ```
 */

export class Rendering {
  /** @internal */
  noa: Engine;

  /** Whether to redraw the screen when the game is resized while paused */
  renderOnResize: boolean;

  /** @internal */
  useAO: boolean;
  /** @internal */
  aoVals: number[];
  /** @internal */
  revAoVal: number;
  /** @internal */
  meshingCutoffTime: number;

  /** the three.js WebGLRenderer for the scene */
  engine!: WebGLRenderer;
  /** the three.js Scene object for the world */
  scene!: Scene;
  /** a three.js DirectionalLight that is added to the scene */
  light!: DirectionalLight;
  /** ambient light for the scene */
  ambientLight!: AmbientLight;
  /** the scene ambient color (from engine options) */
  ambientColor!: Color;
  /** the three.js PerspectiveCamera that renders the scene */
  camera!: PerspectiveCamera;

  /** @internal */
  _canvas!: HTMLCanvasElement;
  /** @internal */
  _cameraHolder!: Group;
  /** @internal */
  _camScreen!: Mesh;
  /** @internal */
  _camScreenMat!: MeshBasicMaterial;
  /** @internal */
  _camLocBlock!: number;
  /** @internal */
  _highlightMesh: Mesh | undefined;

  /**
   * @internal
   */
  constructor(noa: Engine, opts: any, canvas: HTMLCanvasElement) {
    opts = Object.assign({}, defaults, opts);
    this.noa = noa;

    // settings
    this.renderOnResize = !!opts.renderOnResize;

    // internals
    this.useAO = !!opts.useAO;
    this.aoVals = opts.AOmultipliers;
    this.revAoVal = opts.reverseAOmultiplier;
    this.meshingCutoffTime = 6; // ms

    // sets up the three.js scene, lights, etc
    this._initScene(canvas, opts);

    // for debugging
    if (opts.showFPS) setUpFPS();
  }

  /**
   * Constructor helper - set up the three.js scene and basic components
   * @internal
   */
  _initScene(canvas: HTMLCanvasElement, opts: any) {
    this._canvas = canvas;
    // Babylon's legacy pipeline lights in gamma space with no sRGB
    // decode/encode; disable three's color management to match, so the
    // textures and shading reproduce the original look
    ColorManagement.enabled = false;
    this.engine = new WebGLRenderer({
      canvas,
      antialias: !!opts.antiAlias,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    this.engine.outputColorSpace = LinearSRGBColorSpace;
    this.engine.setClearColor(new Color(...(opts.clearColor as [number, number, number])), 1);

    var scene = new Scene();
    this.scene = scene;

    // camera, and a node to hold it and accumulate rotations.
    // Babylon applied .rotation as yaw->pitch->roll, i.e. three's 'YXZ'
    this._cameraHolder = new Group();
    this._cameraHolder.name = "camHolder";
    this._cameraHolder.rotation.order = "YXZ";
    (this._cameraHolder as any).userData.noaSkipRebase = true;
    scene.add(this._cameraHolder);

    var w = canvas.clientWidth || canvas.width || 1;
    var h = canvas.clientHeight || canvas.height || 1;
    this.engine.setSize(w, h, false);
    // Babylon's default vertical FOV is 0.8 radians; three wants degrees
    this.camera = new PerspectiveCamera(0.8 * (180 / Math.PI), w / h, 0.01, 10000);
    this._cameraHolder.add(this.camera);

    // expose a Babylon-style forward ray accessor, returning the view
    // direction in GAME coordinates (z un-negated); game code and the
    // test harnesses rely on this shape
    var fwd = new Vector3();
    var cam = this.camera;
    (this.camera as any).getForwardRay = () => {
      cam.getWorldDirection(fwd);
      return { direction: { x: fwd.x, y: fwd.y, z: -fwd.z } };
    };

    // plane obscuring the camera - for overlaying an effect on the whole view.
    // the three camera looks down -z, so "in front" is negative z
    // unlit overlay: Babylon tinted with ambientColor * scene ambient, so
    // the equivalent here is a flat (basic) material at half the mat color
    this._camScreen = new Mesh(
      new PlaneGeometry(10, 10),
      new MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    this._camScreen.name = "camScreen";
    this._camScreenMat = this._camScreen.material as MeshBasicMaterial;
    this._camScreen.position.z = -0.1;
    this._camScreen.frustumCulled = false;
    this._camScreen.visible = false;
    this.camera.add(this._camScreen);
    this._camLocBlock = 0;

    // lighting: scene ambient + one directional light, calibrated against
    // the Babylon build by sampling its rendered pixels:
    //   babylon pixel = texture * clamp(ambient + N.L, 0, 1) * vertexColor
    // in gamma space. three's Lambert BRDF divides irradiance by PI, so
    // light intensities carry a PI factor; the directional intensity is
    // scaled so fully lit faces land at 1.0 - the value Babylon's clamp
    // produced - instead of overshooting (its N.L peak is 1/1.5).
    this.ambientColor = new Color(...(opts.ambientColor as [number, number, number]));
    this.ambientLight = new AmbientLight(this.ambientColor, Math.PI);
    scene.add(this.ambientLight);

    var lv = opts.lightVector;
    this.light = new DirectionalLight(
      new Color(...(opts.lightDiffuse as [number, number, number])),
      0.75 * Math.PI,
    );
    this.light.position.set(-lv[0], -lv[1], lv[2]);
    this.light.target.position.set(0, 0, 0);
    (this.light as any).userData.noaSkipRebase = true;
    scene.add(this.light);
  }

  /*
   *   PUBLIC API
   */

  /** The three.js `Scene` object representing the game world. */
  getScene() {
    return this.scene;
  }

  // per-tick listener for rendering-related stuff
  /** @internal */
  tick(_dt: number) {
    // nothing here at the moment
  }

  /** @internal */
  render() {
    profile_hook("start");
    updateCameraForRender(this);
    profile_hook("updateCamera");
    this.engine.render(this.scene, this.camera);
    profile_hook("render");
    fps_hook();
    profile_hook("end");
  }

  /** @internal */
  postRender() {
    // nothing currently
  }

  /** @internal */
  resize() {
    var w = this._canvas.clientWidth || this._canvas.width || 1;
    var h = this._canvas.clientHeight || this._canvas.height || 1;
    this.engine.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.noa._paused && this.renderOnResize) {
      this.engine.render(this.scene, this.camera);
    }
  }

  /** @internal */
  highlightBlockFace(show: boolean, posArr?: number[], normArr?: number[]) {
    var m = getHighlightMesh(this);
    if (show) {
      // floored local coords for highlight mesh
      this.noa.globalToLocal(posArr!, null, hlpos);
      // offset to avoid z-fighting, bigger when camera is far away
      var dist = glvec3.dist(this.noa.camera._localGetPosition(), hlpos);
      var slop = 0.001 + 0.001 * dist;
      for (var i = 0; i < 3; i++) {
        if (normArr![i] === 0) {
          hlpos[i] += 0.5;
        } else {
          hlpos[i] += normArr![i] > 0 ? 1 + slop : -slop;
        }
      }
      m.position.set(hlpos[0], hlpos[1], -hlpos[2]);
      m.rotation.x = normArr![1] ? Math.PI / 2 : 0;
      m.rotation.y = normArr![0] ? Math.PI / 2 : 0;
    }
    m.visible = show;
  }

  /**
   * Adds a mesh to the engine's scene so that it renders.
   *
   * Replaces the Babylon octree bookkeeping; three.js does per-object
   * frustum culling on its own, so this just parents the mesh into the
   * scene and positions unparented meshes in local (render) coords.
   *
   * @param mesh the mesh (or object tree) to add to the scene
   * @param isStatic pass in true if mesh never moves (i.e. never changes chunks)
   * @param pos (optional) global position where the mesh should be
   * @param containingChunk (optional) chunk to which the mesh is statically bound
   */
  addMeshToScene(
    mesh: Object3D,
    isStatic: boolean = false,
    pos: number[] | null = null,
    containingChunk: any = null,
  ) {
    void containingChunk;

    // if mesh is already added, just make sure it's visible
    if (mesh.userData[addedToSceneFlag]) {
      mesh.visible = true;
      return;
    }

    // find local position for mesh and move it there (unless it's parented)
    if (!mesh.parent) {
      if (!pos) pos = [mesh.position.x, mesh.position.y, -mesh.position.z];
      var lpos = this.noa.globalToLocal(pos, null, []);
      mesh.position.set(lpos[0], lpos[1], -lpos[2]);
      this.scene.add(mesh);
      mesh.userData[addedToSceneFlag] = true;
      if (isStatic) {
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      }
    } else {
      // parented meshes live wherever their parent is; just flag them
      mesh.userData[addedToSceneFlag] = true;
    }
  }

  /**
   * Use this to toggle the visibility of a mesh without disposing it or
   * removing it from the scene.
   */
  setMeshVisibility(mesh: Object3D, visible: boolean = false) {
    if (mesh.userData[addedToSceneFlag]) {
      mesh.visible = visible;
    } else {
      if (visible) this.addMeshToScene(mesh);
    }
  }

  /**
   * Create a default material: flat, nonspecular, fully reflects
   * diffuse and ambient light. (Kept under its Babylon-era name.)
   */
  makeStandardMaterial(name: string): MeshLambertMaterial {
    var mat = new MeshLambertMaterial();
    mat.name = name;
    return mat;
  }

  /*
   *
   *   INTERNALS
   *
   */

  /*
   *
   *
   *   ACCESSORS FOR CHUNK ADD/REMOVAL/MESHING
   *
   *
   */
  /** @internal */
  prepareChunkForRendering(_chunk: any) {
    // currently no logic needed here, but I may need it again...
  }

  /** @internal */
  disposeChunkForRendering(_chunk: any) {
    // nothing currently
  }

  // change world origin offset, and rebase everything with a position
  /** @internal */
  _rebaseOrigin(delta: number[]) {
    // game-coord delta, so the render-space z displacement is negated
    var dx = delta[0];
    var dy = delta[1];
    var dz = -delta[2];

    this.scene.children.forEach((obj) => {
      if (obj.userData.noaSkipRebase) return;
      obj.position.x -= dx;
      obj.position.y -= dy;
      obj.position.z -= dz;
      if (obj.matrixAutoUpdate === false) obj.updateMatrix();
    });
  }

  /** @internal */
  debug_SceneCheck() {
    var meshCount = 0;
    var noMat = 0;
    this.scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) {
        meshCount++;
        if (!(obj as Mesh).material) noMat++;
      }
    });
    console.log("meshes in scene:", meshCount, "  without material:", noMat);
    return "done.";
  }

  /** @internal */
  debug_MeshCount() {
    var ct: { [key: string]: number } = {};
    this.scene.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      var n = obj.name || "";
      n = n.replace(/-\d+.*/, "#");
      n = n.replace(/\d+.*/, "#");
      n = n.replace(/(rotHolder|camHolder|camScreen)/, "rendering use");
      n = n.replace(/atlas sprite .*/, "atlas sprites");
      ct[n] = ct[n] || 0;
      ct[n]++;
    });
    for (var s in ct) console.log("   " + (ct[s] + "       ").substr(0, 7) + s);
  }
}

/**
 * Removes an object tree from the scene and disposes its geometries.
 * Materials flagged `userData.shared` are left alone (terrain materials
 * and other caches are reused across meshes); everything else is
 * disposed along with any textures it owns.
 * @internal
 */
export function disposeObject3D(obj: Object3D) {
  obj.removeFromParent();
  obj.traverse((node) => {
    var mesh = node as Mesh;
    if (!mesh.isMesh && !(node as Line).isLine) return;
    var geom = (node as Mesh).geometry as BufferGeometry | undefined;
    if (geom) geom.dispose();
    var mat = (node as Mesh).material as Material | Material[] | undefined;
    if (!mat) return;
    var mats = Array.isArray(mat) ? mat : [mat];
    mats.forEach((m) => {
      if (m.userData.shared) return;
      var map = (m as MeshLambertMaterial).map;
      if (map) map.dispose();
      m.dispose();
    });
  });
}

var hlpos: number[] = [];

var addedToSceneFlag = "noa_added_to_scene";

// updates camera position/rotation to match settings from noa.camera

function updateCameraForRender(self: Rendering) {
  var cam = self.noa.camera;
  var tgtLoc = cam._localGetTargetPosition();
  self._cameraHolder.position.set(tgtLoc[0], tgtLoc[1], -tgtLoc[2]);
  // game heading/pitch -> render rotations (see coordinate notes up top)
  self._cameraHolder.rotation.x = -cam.pitch;
  self._cameraHolder.rotation.y = -cam.heading;
  // the camera looks down its local -z, so "behind" the target is +z
  self.camera.position.z = cam.currentZoom;

  // applies screen effect when camera is inside a transparent voxel
  var cloc = cam._localGetPosition();
  var off = self.noa.worldOriginOffset;
  var cx = Math.floor(cloc[0] + off[0]);
  var cy = Math.floor(cloc[1] + off[1]);
  var cz = Math.floor(cloc[2] + off[2]);
  var id = self.noa.getBlock(cx, cy, cz);
  checkCameraEffect(self, id);
}

//  If camera's current location block id has alpha color (e.g. water), apply/remove an effect

function checkCameraEffect(self: Rendering, id: number) {
  if (id === self._camLocBlock) return;
  if (id === 0) {
    self._camScreen.visible = false;
  } else {
    var matId = self.noa.registry.getBlockFaceMaterial(id, 0);
    if (matId) {
      var matData = self.noa.registry.getMaterialData(matId);
      var col = matData.color;
      var alpha = matData.alpha;
      if (col && alpha && alpha < 1) {
        // matches the Babylon look: ambientColor (col) * scene ambient (0.5)
        self._camScreenMat.color.setRGB(col[0] * 0.5, col[1] * 0.5, col[2] * 0.5);
        self._camScreenMat.opacity = alpha;
        self._camScreen.visible = true;
      }
    }
  }
  self._camLocBlock = id;
}

// make or get a mesh for highlighting active voxel
function getHighlightMesh(rendering: Rendering): Mesh {
  var mesh = rendering._highlightMesh;
  if (!mesh) {
    var hlm = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.2,
      side: DoubleSide,
      depthWrite: false,
    });
    mesh = new Mesh(new PlaneGeometry(1, 1), hlm);
    mesh.name = "highlight";

    // outline
    var s = 0.5;
    var pts = [
      new Vector3(s, s, 0),
      new Vector3(s, -s, 0),
      new Vector3(-s, -s, 0),
      new Vector3(-s, s, 0),
      new Vector3(s, s, 0),
    ];
    var lines = new Line(
      new BufferGeometry().setFromPoints(pts),
      new LineBasicMaterial({ color: 0xffffff }),
    );
    lines.name = "highlightLines";
    mesh.add(lines);

    rendering.addMeshToScene(mesh);
    rendering._highlightMesh = mesh;
  }
  return mesh;
}

var profile_hook: (state: string) => void = PROFILE
  ? makeProfileHook(200, "render internals")
  : () => {};

var fps_hook = function () {};

function setUpFPS() {
  var div = document.createElement("div");
  div.id = "noa_fps";
  div.style.position = "absolute";
  div.style.top = "0";
  div.style.right = "0";
  div.style.zIndex = "0";
  div.style.color = "white";
  div.style.backgroundColor = "rgba(0,0,0,0.5)";
  div.style.font = "14px monospace";
  div.style.textAlign = "center";
  div.style.minWidth = "2em";
  div.style.margin = "4px";
  document.body.appendChild(div);
  var every = 1000;
  var ct = 0;
  var longest = 0;
  var start = performance.now();
  var last = start;
  fps_hook = function () {
    ct++;
    var nt = performance.now();
    if (nt - last > longest) longest = nt - last;
    last = nt;
    if (nt - start < every) return;
    var fps = Math.round((ct / (nt - start)) * 1000);
    var min = Math.round((1 / longest) * 1000);
    div.innerHTML = fps + "<br>" + min;
    ct = 0;
    longest = 0;
    start = nt;
  };
}
