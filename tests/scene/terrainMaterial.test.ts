import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import {
  TERRAIN_MATERIAL_LOOKS,
  applyTerrainTextures,
  createTerrainMaterial,
  loadTerrainTextures,
  patchTerrainShader,
  terrainTexturePaths,
} from '../../src/scene/terrainMaterial';
import type { TerrainMaterialState } from '../../src/scene/terrainMaterial';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const stateOf = (m: THREE.Material): TerrainMaterialState => m.userData.terrain as TerrainMaterialState;

/** What three would hand onBeforeCompile for a standard material (the real chunk-based sources). */
function standardShader(): { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string } {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
}

/** A loader that needs no image decoding. */
const fakeLoad = async (): Promise<THREE.Texture> => new THREE.Texture();

/** The texture files that exist under public/assets/textures (project-root paths). */
const EXISTING = new Set(Object.keys(import.meta.glob('/public/assets/textures/*.jpg')));

describe('terrain texture files', () => {
  for (const theme of THEMES) {
    it(`${theme}: every map exists under public/ (diffuse, normal and roughness for the ground, the rock${TERRAIN_MATERIAL_LOOKS[theme].cap ? ' and the snow cap' : ''})`, () => {
      const paths = terrainTexturePaths(theme);
      expect(Object.keys(paths)).toHaveLength(TERRAIN_MATERIAL_LOOKS[theme].cap ? 9 : 6);
      for (const path of Object.values(paths)) expect(EXISTING.has(`/public/${path}`), path).toBe(true);
    });
  }
});

describe('createTerrainMaterial', () => {
  it('starts in the fallback look: flat theme colour, procedural bump, vertex colours, no PBR define, no texture loaded', () => {
    for (const theme of THEMES) {
      const material = createTerrainMaterial(theme);
      expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(material.vertexColors).toBe(true);
      expect(material.bumpMap).not.toBeNull();
      expect(material.color.getHex()).toBe(TERRAIN_MATERIAL_LOOKS[theme].fallbackColor);
      expect(material.defines?.TERRAIN_PBR).toBeUndefined();
      expect(stateOf(material).pbr).toBe(false);
      for (const key of ['tGroundDiff', 'tRockDiff']) expect(stateOf(material).uniforms[key].value).toBeNull();
    }
  });

  it('snow caps are a define of arctic and valley only; only the valley has its own cap textures', () => {
    expect(createTerrainMaterial('desert').defines?.TERRAIN_SNOW).toBeUndefined();
    expect(createTerrainMaterial('arctic').defines?.TERRAIN_SNOW).toBeDefined();
    expect(createTerrainMaterial('valley').defines?.TERRAIN_SNOW).toBeDefined();
    expect(createTerrainMaterial('arctic').defines?.TERRAIN_CAPTEX).toBeUndefined();
    expect(createTerrainMaterial('valley').defines?.TERRAIN_CAPTEX).toBeDefined();
    expect(TERRAIN_MATERIAL_LOOKS.desert.snow).toBeNull();
    // Snow lies on high ground, not on the plain: the lines are well above the valley floor and the spur's foot.
    expect(TERRAIN_MATERIAL_LOOKS.arctic.snow!.line).toBeGreaterThanOrEqual(60);
    expect(TERRAIN_MATERIAL_LOOKS.valley.snow!.line).toBeGreaterThanOrEqual(60);
  });

  it('has one program per theme (cache key) and per-theme tints, so each still matches its theme', () => {
    const keys = THEMES.map((t) => createTerrainMaterial(t).customProgramCacheKey());
    expect(new Set(keys).size).toBe(3);
    const tints = THEMES.map((t) => TERRAIN_MATERIAL_LOOKS[t].groundTint.join());
    expect(new Set(tints).size).toBe(3);
  });

  it('patches the standard shader: uniforms, the bake attribute, triplanar rock, detail/macro scales and the baked lighting', () => {
    for (const theme of THEMES) {
      const material = createTerrainMaterial(theme);
      const shader = standardShader();
      material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
      for (const name of ['uSunShadow', 'uTile', 'uRockMask', 'uSnow', 'uGroundTint', 'uRockTint', 'uCapTint', 'tGroundDiff', 'tGroundNor', 'tGroundRough', 'tRockDiff', 'tRockNor', 'tRockRough']) {
        expect(shader.uniforms[name], name).toBeDefined();
      }
      expect(shader.uniforms.uTile.value.toArray()).toEqual([...TERRAIN_MATERIAL_LOOKS[theme].tileM]);
      expect(shader.vertexShader).toContain('attribute vec2 bake;');
      expect(shader.vertexShader).toContain('vBake = bake;');
      expect(shader.fragmentShader).toContain('#ifdef TERRAIN_PBR');
      expect(shader.fragmentShader).toContain('triSample(tRockDiff');
      expect(shader.fragmentShader).toContain('triNormal(tRockNor');
      expect(shader.fragmentShader).toContain('uTile.z'); // rock detail scale
      expect(shader.fragmentShader).toContain('uTile.w'); // rock macro scale
      expect(shader.fragmentShader).toContain('roughnessFactor = clamp(rough');
      expect(shader.fragmentShader).toContain('normal = transformDirection(shadeN, viewMatrix)');
      // Baked sun darkens the direct light, baked occlusion the indirect light.
      expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse *= bakedSun');
      expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse *= vBake.y');
      // The chunks are still there once patched (the standard shader's own includes survive).
      expect(shader.fragmentShader).toContain('#include <lights_fragment_end>');
    }
  });

  it('keeps the shared uniform objects: a texture set later reaches a shader compiled earlier', () => {
    const material = createTerrainMaterial('desert');
    const shader = standardShader();
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
    const texture = new THREE.Texture();
    stateOf(material).uniforms.tRockDiff.value = texture;
    expect(shader.uniforms.tRockDiff.value).toBe(texture);
  });

  it('fails loudly if a three.js chunk the patch hooks into is missing', () => {
    const material = createTerrainMaterial('desert');
    const shader = standardShader();
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', '');
    expect(() => patchTerrainShader(shader, stateOf(material))).toThrow(/aomap_fragment/);
  });
});

describe('loadTerrainTextures', () => {
  afterEach(() => vi.restoreAllMocks());

  it('switches to the PBR look once every map has loaded: define on, bump off, samplers set, colour spaces right', async () => {
    for (const theme of THEMES) {
      const material = createTerrainMaterial(theme);
      const urls: string[] = [];
      const ok = await loadTerrainTextures(material, {
        baseUrl: '/base/',
        maxAnisotropy: 16,
        load: async (url) => {
          urls.push(url);
          return new THREE.Texture();
        },
      });
      expect(ok).toBe(true);
      expect(urls.sort()).toEqual(Object.values(terrainTexturePaths(theme)).map((p) => `/base/${p}`).sort());
      expect(material.defines?.TERRAIN_PBR).toBeDefined();
      expect(material.bumpMap).toBeNull();
      expect(stateOf(material).pbr).toBe(true);
      const { uniforms } = stateOf(material);
      const rockDiff = uniforms.tRockDiff.value as THREE.Texture;
      const rockNor = uniforms.tRockNor.value as THREE.Texture;
      expect(rockDiff.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(rockNor.colorSpace).toBe(THREE.NoColorSpace);
      expect(rockDiff.wrapS).toBe(THREE.RepeatWrapping);
      expect(rockDiff.anisotropy).toBe(16);
      expect(rockDiff.generateMipmaps).toBe(true);
      expect((uniforms.tGroundRough.value as THREE.Texture).colorSpace).toBe(THREE.NoColorSpace);
      expect(Boolean(uniforms.tCapDiff.value)).toBe(theme === 'valley');
    }
  });

  it('keeps the fallback look (and warns) if any map fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const material = createTerrainMaterial('valley');
    const ok = await loadTerrainTextures(material, {
      load: async (url) => {
        if (url.includes('rock_nor')) throw new Error('404');
        return new THREE.Texture();
      },
    });
    expect(ok).toBe(false);
    expect(material.defines?.TERRAIN_PBR).toBeUndefined();
    expect(material.bumpMap).not.toBeNull();
    expect(material.color.getHex()).toBe(TERRAIN_MATERIAL_LOOKS.valley.fallbackColor);
    expect(stateOf(material).pbr).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('applyTerrainTextures refuses an incomplete set', () => {
    const material = createTerrainMaterial('desert');
    expect(() => applyTerrainTextures(material, { groundDiff: new THREE.Texture() })).toThrow(/missing texture/);
    expect(material.defines?.TERRAIN_PBR).toBeUndefined();
  });

  it('works with the default loader signature (no options needed beyond the material)', async () => {
    const material = createTerrainMaterial('arctic');
    const spy = vi.fn(fakeLoad);
    await loadTerrainTextures(material, { load: spy });
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
