import glvec3 from "gl-vec3";
import { makeProfileHook } from "./util";

import { SceneOctreeManager } from "./sceneOctreeManager";

import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine as BabylonEngine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";

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

/**
 * `noa.rendering` -
 * Manages all rendering, and the BABYLON scene, materials, etc.
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
 *     octreeBlockSize: 2,
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

  /** the Babylon.js Engine object for the scene */
  engine!: BabylonEngine;
  /** the Babylon.js Scene object for the world */
  scene!: Scene;
  /** a Babylon.js DirectionalLight that is added to the scene */
  light!: DirectionalLight;
  /** the Babylon.js FreeCamera that renders the scene */
  camera!: FreeCamera;

  /** @internal */
  _octreeManager!: SceneOctreeManager;
  /** @internal */
  _cameraHolder!: TransformNode;
  /** @internal */
  _camScreen!: Mesh;
  /** @internal */
  _camScreenMat!: StandardMaterial;
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

    // the Babylon.js Engine, Scene, DirectionalLight, and FreeCamera
    // are all declared above, and assigned in _initScene below

    // sets up babylon scene, lights, etc
    this._initScene(canvas, opts);

    // for debugging
    if (opts.showFPS) setUpFPS();
  }

  /**
   * Constructor helper - set up the Babylon.js scene and basic components
   * @internal
   */
  _initScene(canvas: HTMLCanvasElement, opts: any) {
    // init internal properties
    this.engine = new BabylonEngine(canvas, opts.antiAlias, {
      preserveDrawingBuffer: opts.preserveDrawingBuffer,
    });
    var scene = new Scene(this.engine);
    this.scene = scene;
    // remove built-in listeners
    scene.detachControl();

    // this disables a few babylon features that noa doesn't use
    scene.performancePriority = ScenePerformancePriority.Intermediate;
    scene.autoClear = true;

    // octree manager class
    var blockSize = Math.round(opts.octreeBlockSize);
    this._octreeManager = new SceneOctreeManager(this, blockSize);

    // camera, and a node to hold it and accumulate rotations
    this._cameraHolder = new TransformNode("camHolder", scene);
    this.camera = new FreeCamera("camera", new Vector3(0, 0, 0), scene);
    this.camera.parent = this._cameraHolder;
    this.camera.minZ = 0.01;

    // plane obscuring the camera - for overlaying an effect on the whole view
    this._camScreen = CreatePlane("camScreen", { size: 10 }, scene);
    this.addMeshToScene(this._camScreen);
    this._camScreen.position.z = 0.1;
    this._camScreen.parent = this.camera;
    this._camScreenMat = this.makeStandardMaterial("camera_screen_mat");
    this._camScreen.material = this._camScreenMat;
    this._camScreen.setEnabled(false);
    this._camScreenMat.freeze();
    this._camLocBlock = 0;

    // apply some defaults
    scene.clearColor = Color4.FromArray(opts.clearColor);
    scene.ambientColor = Color3.FromArray(opts.ambientColor);

    var lightVec = Vector3.FromArray(opts.lightVector);
    this.light = new DirectionalLight("light", lightVec, scene);
    this.light.diffuse = Color3.FromArray(opts.lightDiffuse);
    this.light.specular = Color3.FromArray(opts.lightSpecular);

    // scene options
    scene.skipPointerMovePicking = true;
  }

  /*
   *   PUBLIC API
   */

  /** The Babylon `scene` object representing the game world. */
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
    this.engine.beginFrame();
    profile_hook("beginFrame");
    this.scene.render();
    profile_hook("render");
    fps_hook();
    this.engine.endFrame();
    profile_hook("endFrame");
    profile_hook("end");
  }

  /** @internal */
  postRender() {
    // nothing currently
  }

  /** @internal */
  resize() {
    this.engine.resize();
    if (this.noa._paused && this.renderOnResize) {
      this.scene.render();
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
      m.position.copyFromFloats(hlpos[0], hlpos[1], hlpos[2]);
      m.rotation.x = normArr![1] ? Math.PI / 2 : 0;
      m.rotation.y = normArr![0] ? Math.PI / 2 : 0;
    }
    m.setEnabled(show);
  }

  /**
   * Adds a mesh to the engine's selection/octree logic so that it renders.
   *
   * @param mesh the mesh to add to the scene
   * @param isStatic pass in true if mesh never moves (i.e. never changes chunks)
   * @param pos (optional) global position where the mesh should be
   * @param containingChunk (optional) chunk to which the mesh is statically bound
   */
  addMeshToScene(
    mesh: AbstractMesh,
    isStatic: boolean = false,
    pos: number[] | null = null,
    containingChunk: any = null,
  ) {
    if (!mesh.metadata) mesh.metadata = {};

    // if mesh is already added, just make sure it's visisble
    if (mesh.metadata[addedToSceneFlag]) {
      this._octreeManager.setMeshVisibility(mesh, true);
      return;
    }
    mesh.metadata[addedToSceneFlag] = true;

    // find local position for mesh and move it there (unless it's parented)
    if (!mesh.parent) {
      if (!pos) pos = mesh.position.asArray();
      var lpos = this.noa.globalToLocal(pos, null, []);
      mesh.position.fromArray(lpos);
    }

    // add to the octree, and remove again on disposal
    this._octreeManager.addMesh(mesh, isStatic, pos as number[], containingChunk);
    mesh.onDisposeObservable.add(() => {
      this._octreeManager.removeMesh(mesh);
      mesh.metadata[addedToSceneFlag] = false;
    });
  }

  /**
   * Use this to toggle the visibility of a mesh without disposing it or
   * removing it from the scene.
   */
  setMeshVisibility(mesh: AbstractMesh, visible: boolean = false) {
    if (!mesh.metadata) mesh.metadata = {};
    if (mesh.metadata[addedToSceneFlag]) {
      this._octreeManager.setMeshVisibility(mesh, visible);
    } else {
      if (visible) this.addMeshToScene(mesh);
    }
  }

  /**
   * Create a default standardMaterial:
   * flat, nonspecular, fully reflects diffuse and ambient light
   */
  makeStandardMaterial(name: string): StandardMaterial {
    var mat = new StandardMaterial(name, this.scene);
    mat.specularColor.copyFromFloats(0, 0, 0);
    mat.ambientColor.copyFromFloats(1, 1, 1);
    mat.diffuseColor.copyFromFloats(1, 1, 1);
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
    var dvec = new Vector3(delta[0], delta[1], delta[2]);

    this.scene.meshes.forEach((mesh) => {
      // parented meshes don't live in the world coord system
      if (mesh.parent) return;

      // move each mesh by delta (even though most are managed by components)
      mesh.position.subtractInPlace(dvec);

      if (mesh.isWorldMatrixFrozen) {
        // paradoxically this unfreezes, then re-freezes the matrix
        mesh.freezeWorldMatrix();
      }
    });

    // updates position of all octree blocks
    this._octreeManager.rebase(dvec);
  }

  /*
   *
   *      sanity checks:
   *
   */
  /** @internal */
  debug_SceneCheck() {
    var meshes = this.scene.meshes;
    var octree = (this.scene as any)._selectionOctree;
    var dyns = octree.dynamicContent;
    var octs: any[] = [];
    var numOcts = 0;
    var numSubs = 0;
    var mats = this.scene.materials;
    var allmats: any[] = [];
    mats.forEach((mat) => {
      // @ts-ignore
      if (mat.subMaterials) mat.subMaterials.forEach((mat) => allmats.push(mat));
      else allmats.push(mat);
    });
    octree.blocks.forEach(function (block: any) {
      numOcts++;
      block.entries.forEach((m: any) => octs.push(m));
    });
    meshes.forEach(function (m) {
      if (m.isDisposed()) warn(m, "disposed mesh in scene");
      if (empty(m)) return;
      if (missing(m, dyns, octs)) warn(m, "non-empty mesh missing from octree");
      if (!m.material) {
        warn(m, "non-empty scene mesh with no material");
        return;
      }
      numSubs += m.subMeshes ? m.subMeshes.length : 1;
      // @ts-ignore
      var mats = m.material.subMaterials || [m.material];
      mats.forEach(function (mat: any) {
        if (missing(mat, mats)) warn(mat, "mesh material not in scene");
      });
    });
    var unusedMats: any[] = [];
    allmats.forEach((mat) => {
      var used = false;
      meshes.forEach((mesh) => {
        if (mesh.material === mat) used = true;
        if (!mesh.material) return;
        // @ts-ignore
        var mats = mesh.material.subMaterials || [mesh.material];
        if (mats.includes(mat)) used = true;
      });
      if (!used) unusedMats.push(mat.name);
    });
    if (unusedMats.length) {
      console.warn("Materials unused by any mesh: ", unusedMats.join(", "));
    }
    dyns.forEach(function (m: any) {
      if (missing(m, meshes)) warn(m, "octree/dynamic mesh not in scene");
    });
    octs.forEach(function (m) {
      if (missing(m, meshes)) warn(m, "octree block mesh not in scene");
    });
    var avgPerOct = Math.round((10 * octs.length) / numOcts) / 10;
    console.log(
      "meshes - octree:",
      octs.length,
      "  dynamic:",
      dyns.length,
      "   subMeshes:",
      numSubs,
      "   avg meshes/octreeBlock:",
      avgPerOct,
    );

    function warn(obj: any, msg: string) {
      console.warn(obj.name + " --- " + msg);
    }

    function empty(mesh: any) {
      return mesh.getIndices().length === 0;
    }

    function missing(obj: any, list1: any, list2?: any) {
      if (!obj) return false;
      if (list1.includes(obj)) return false;
      if (list2 && list2.includes(obj)) return false;
      return true;
    }
    return "done.";
  }

  /** @internal */
  debug_MeshCount() {
    var ct: { [key: string]: number } = {};
    this.scene.meshes.forEach((m) => {
      var n = m.name || "";
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

var hlpos: number[] = [];

var addedToSceneFlag = "noa_added_to_scene";

// updates camera position/rotation to match settings from noa.camera

function updateCameraForRender(self: Rendering) {
  var cam = self.noa.camera;
  var tgtLoc = cam._localGetTargetPosition();
  self._cameraHolder.position.copyFromFloats(tgtLoc[0], tgtLoc[1], tgtLoc[2]);
  self._cameraHolder.rotation.x = cam.pitch;
  self._cameraHolder.rotation.y = cam.heading;
  self.camera.position.z = -cam.currentZoom;

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
    self._camScreen.setEnabled(false);
  } else {
    var matId = self.noa.registry.getBlockFaceMaterial(id, 0);
    if (matId) {
      var matData = self.noa.registry.getMaterialData(matId);
      var col = matData.color;
      var alpha = matData.alpha;
      if (col && alpha && alpha < 1) {
        self._camScreenMat.diffuseColor.set(0, 0, 0);
        self._camScreenMat.ambientColor.set(col[0], col[1], col[2]);
        self._camScreenMat.alpha = alpha;
        self._camScreen.setEnabled(true);
      }
    }
  }
  self._camLocBlock = id;
}

// make or get a mesh for highlighting active voxel
function getHighlightMesh(rendering: Rendering): Mesh {
  var mesh = rendering._highlightMesh;
  if (!mesh) {
    mesh = CreatePlane("highlight", { size: 1.0 }, rendering.scene);
    var hlm = rendering.makeStandardMaterial("block_highlight_mat");
    hlm.backFaceCulling = false;
    hlm.emissiveColor = new Color3(1, 1, 1);
    hlm.alpha = 0.2;
    hlm.freeze();
    mesh.material = hlm;

    // outline
    var s = 0.5;
    var lines = CreateLines(
      "hightlightLines",
      {
        points: [
          new Vector3(s, s, 0),
          new Vector3(s, -s, 0),
          new Vector3(-s, -s, 0),
          new Vector3(-s, s, 0),
          new Vector3(s, s, 0),
        ],
      },
      rendering.scene,
    );
    lines.color = new Color3(1, 1, 1);
    lines.parent = mesh;

    rendering.addMeshToScene(mesh);
    rendering.addMeshToScene(lines);
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
