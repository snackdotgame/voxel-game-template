import { NearestFilter, TextureLoader } from "three";
import type { Material, MeshLambertMaterial } from "three";

import type { Engine as NoaEngine } from "../index";

/**
 *
 *
 *      This module creates and manages Materials for terrain meshes.
 *      It tells the terrain mesher which block face materials can share
 *      the same material (and should thus be joined into a single mesh),
 *      and also creates the materials when needed.
 *
 * @internal
 */

export class TerrainMatManager {
  _defaultMat: Material;
  allMaterials: Material[];
  noa: NoaEngine;
  _idCounter: number;
  _blockMatIDtoTerrainID: { [blockMatID: number]: number };
  _terrainIDtoMatObject: { [terrainID: number]: Material };
  _texURLtoTerrainID: { [texURL: string]: number };
  _renderMatToTerrainID: Map<any, number>;

  constructor(noa: NoaEngine) {
    // make a baseline default material for untextured terrain with no alpha
    this._defaultMat = makeTerrainMaterial(noa, "base-terrain");

    this.allMaterials = [this._defaultMat];

    // internals
    this.noa = noa;
    this._idCounter = 1000;
    this._blockMatIDtoTerrainID = {};
    this._terrainIDtoMatObject = {};
    this._texURLtoTerrainID = {};
    this._renderMatToTerrainID = new Map();
  }

  /**
   * Maps a given `matID` (from noa.registry) to a unique ID of which
   * terrain material can be used for that block material.
   * This lets the terrain mesher map which blocks can be merged into
   * the same meshes.
   * Internally, this accessor also creates the material for each
   * terrainMatID as they are first encountered.
   */

  getTerrainMatId(blockMatID: number) {
    // fast case where matID has been seen before
    if (blockMatID in this._blockMatIDtoTerrainID) {
      return this._blockMatIDtoTerrainID[blockMatID];
    }
    // decide a unique terrainID for this block material
    var terrID = decideTerrainMatID(this, blockMatID);
    // create a mat object for it, if needed
    if (!(terrID in this._terrainIDtoMatObject)) {
      var mat = createTerrainMat(this, blockMatID);
      this.allMaterials.push(mat);
      this._terrainIDtoMatObject[terrID] = mat;
    }
    // cache results and done
    this._blockMatIDtoTerrainID[blockMatID] = terrID;
    return terrID;
  }

  /**
   * Get a three.js Material object, given a terrainMatID (gotten from this module)
   */
  getMaterial(terrainMatID = 1) {
    return this._terrainIDtoMatObject[terrainMatID];
  }
}

/**
 *
 *
 *      Implementations of creating/disambiguating terrain Materials
 *
 *
 */

/**
 * Decide a unique terrainID, based on block material ID properties
 */
function decideTerrainMatID(self: TerrainMatManager, blockMatID = 0): number {
  var matInfo = self.noa.registry.getMaterialData(blockMatID);

  // custom render materials get one unique terrainID per material
  if (matInfo.renderMat) {
    var mat = matInfo.renderMat;
    if (!self._renderMatToTerrainID.has(mat)) {
      self._renderMatToTerrainID.set(mat, self._idCounter++);
    }
    return self._renderMatToTerrainID.get(mat)!;
  }

  // ditto for textures, unique URL
  if (matInfo.texture) {
    var url = matInfo.texture;
    if (!(url in self._texURLtoTerrainID)) {
      self._texURLtoTerrainID[url] = self._idCounter++;
    }
    return self._texURLtoTerrainID[url];
  }

  // plain color materials with an alpha value are unique by alpha
  var alpha = matInfo.alpha;
  if (alpha > 0 && alpha < 1) return 10 + Math.round(alpha * 100);

  // the only remaining case is the baseline, which always reuses one fixed ID
  return 1;
}

/**
 * Create (choose) a material for a given set of block material properties
 */
function createTerrainMat(self: TerrainMatManager, blockMatID = 0): Material {
  var matInfo = self.noa.registry.getMaterialData(blockMatID);

  // custom render mats are just reused
  if (matInfo.renderMat) return matInfo.renderMat;

  // if no texture: use a basic flat material, possibly with alpha
  if (!matInfo.texture) {
    var needsAlpha = matInfo.alpha > 0 && matInfo.alpha < 1;
    if (!needsAlpha) return self._defaultMat;
    var matName = "terrain-alpha-" + blockMatID;
    var plainMat = makeTerrainMaterial(self.noa, matName);
    plainMat.transparent = true;
    plainMat.opacity = matInfo.alpha;
    plainMat.depthWrite = false;
    return plainMat;
  }

  // the original (Babylon) engine also supported texture-atlas materials
  // via a custom 2D-texture-array shader plugin; nothing in this game
  // registers an atlas, so that path is intentionally not ported
  if (matInfo.atlasIndex >= 0) {
    throw new Error("Texture-atlas terrain materials are not supported by the three.js renderer");
  }

  // remaining case is a new material with a diffuse texture
  var mat = makeTerrainMaterial(self.noa, "terrain-textured-" + blockMatID);
  var texURL = matInfo.texture;
  var tex = new TextureLoader().load(texURL);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  if (matInfo.texHasAlpha) mat.alphaTest = 0.5;
  mat.map = tex;

  return mat;
}

/**
 * Baseline terrain material: lit by ambient + directional light, tinted
 * by the per-vertex colors the mesher bakes in (block color and AO).
 */
function makeTerrainMaterial(noa: NoaEngine, name: string): MeshLambertMaterial {
  var mat = noa.rendering.makeStandardMaterial(name);
  mat.vertexColors = true;
  mat.userData.shared = true;
  return mat;
}
