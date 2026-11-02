import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import { PART_CLASSES, TEXTURE_REPEAT_M, boxProjectUV, burntMaterial, classTint, patchShaderFor, propMaterial, resetPropMaterials, setTextureSource } from '../../src/scene/materials';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

afterEach(() => {
  setTextureSource(undefined);
  resetPropMaterials();
  vi.restoreAllMocks();
});

describe('boxProjectUV: world-scale UVs', () => {
  it('one texture repeat covers 2 m: a 6 m wall gets 3 repeats, a 1 m window 0.5', () => {
    expect(TEXTURE_REPEAT_M).toBe(2);
    // A 6 m wall along x, 3 m tall, facing +z.
    const left = boxProjectUV(-3, 0, 0.2, 0, 0, 1);
    const right = boxProjectUV(3, 3, 0.2, 0, 0, 1);
    expect(right.u - left.u).toBeCloseTo(3, 12);
    expect(right.v - left.v).toBeCloseTo(1.5, 12);
    const a = boxProjectUV(0, 1, 0, 0, 0, 1);
    const b = boxProjectUV(1, 1, 0, 0, 0, 1);
    expect(b.u - a.u).toBeCloseTo(0.5, 12);
  });

  it('metres map to the same UV length on every axis and every face (no stretching)', () => {
    const faces: Array<[number, number, number]> = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [nx, ny, nz] of faces) {
      const o = boxProjectUV(2, 3, 4, nx, ny, nz);
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]) {
        const p = boxProjectUV(2 + dx, 3 + dy, 4 + dz, nx, ny, nz);
        const along = Math.abs(dx * nx + dy * ny + dz * nz) > 0.5; // moving along the normal does not move over the face
        const len = Math.hypot(p.u - o.u, p.v - o.v);
        expect(len, `normal (${nx},${ny},${nz}) step (${dx},${dy},${dz})`).toBeCloseTo(along ? 0 : 1 / TEXTURE_REPEAT_M, 12);
      }
    }
  });

  it('is continuous across boxes: the same face plane position gives the same UV, wherever the box is', () => {
    // Two boxes touching on a wall plane z = 2 (a window frame on a wall): same in-plane point, same UV.
    const onWall = boxProjectUV(1.3, 1.1, 2.0, 0, 0, 1);
    const onFrame = boxProjectUV(1.3, 1.1, 2.028, 0, 0, 1);
    expect(onFrame).toEqual(onWall);
  });

  it('no face is mirrored: u grows to the right and v upwards as seen from outside', () => {
    // Seen from outside a +z face, +x is to the right; seen from a -z face, -x is; a +x face: -z; a -x face: +z.
    expect(boxProjectUV(1, 0, 0, 0, 0, 1).u).toBeGreaterThan(boxProjectUV(0, 0, 0, 0, 0, 1).u);
    expect(boxProjectUV(-1, 0, 0, 0, 0, -1).u).toBeGreaterThan(boxProjectUV(0, 0, 0, 0, 0, -1).u);
    expect(boxProjectUV(0, 0, -1, 1, 0, 0).u).toBeGreaterThan(boxProjectUV(0, 0, 0, 1, 0, 0).u);
    expect(boxProjectUV(0, 0, 1, -1, 0, 0).u).toBeGreaterThan(boxProjectUV(0, 0, 0, -1, 0, 0).u);
    for (const n of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      expect(boxProjectUV(0, 1, 0, n[0], n[1], n[2]).v).toBeGreaterThan(boxProjectUV(0, 0, 0, n[0], n[1], n[2]).v);
    }
  });

  it('a custom repeat length and an output object are honoured', () => {
    const out = { u: 0, v: 0 };
    const r = boxProjectUV(4, 0, 0, 0, 0, 1, 4, out);
    expect(r).toBe(out);
    expect(out.u).toBe(1);
  });
});

describe('prop materials', () => {
  it('are cached per theme and class, and differ between themes', () => {
    for (const theme of THEMES) {
      for (const cls of PART_CLASSES) expect(propMaterial(theme, cls)).toBe(propMaterial(theme, cls));
    }
    expect(propMaterial('desert', 'wall')).not.toBe(propMaterial('arctic', 'wall'));
    expect(propMaterial('desert', 'wall')).not.toBe(propMaterial('desert', 'roof'));
  });

  it('are physically based, with vertex colours for the per-part tones (the glass has one colour)', () => {
    for (const theme of THEMES) {
      for (const cls of PART_CLASSES) {
        const m = propMaterial(theme, cls);
        expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(m.vertexColors).toBe(cls !== 'glass');
        expect(m.metalness).toBeLessThanOrEqual(0.35); // no environment map yet in some builds: metal would render black
      }
      expect(propMaterial(theme, 'glass').roughness).toBeLessThan(0.2); // glossy: it reflects the sky
      expect(propMaterial(theme, 'plain').roughness).toBeGreaterThan(0.7); // rubber and dull metal
    }
  });

  it('the tint of a class is the material colour; classes without a tint are white', () => {
    for (const theme of THEMES) {
      for (const cls of PART_CLASSES) {
        const tint = classTint(theme, cls);
        const colour = propMaterial(theme, cls).color;
        if (tint) expect(colour.getHex()).toBe(tint.getHex());
        else expect(colour.getHex()).toBe(0xffffff);
      }
    }
  });

  it('without textures (no DOM, as here) they keep the flat tint: no maps, so the look falls back to plain colour', () => {
    for (const theme of THEMES) {
      for (const cls of PART_CLASSES) {
        const m = propMaterial(theme, cls);
        expect(m.map).toBeNull();
        expect(m.normalMap).toBeNull();
        expect(m.roughnessMap).toBeNull();
      }
    }
  });

  it('attach their texture set once it has loaded: diffuse in sRGB, normal and roughness linear, repeating, anisotropic', async () => {
    const loaded: string[] = [];
    setTextureSource((url) => {
      loaded.push(url);
      return Promise.resolve(new THREE.Texture());
    });
    const m = propMaterial('valley', 'wall'); // plaster_white
    expect(m.map).toBeNull(); // not yet
    await vi.waitFor(() => expect(m.map).not.toBeNull());
    expect(loaded.sort()).toEqual(['/assets/textures/plaster_white_diff.jpg', '/assets/textures/plaster_white_nor.jpg', '/assets/textures/plaster_white_rough.jpg']);
    expect(m.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.map?.wrapS).toBe(THREE.RepeatWrapping);
    expect(m.map?.anisotropy).toBeGreaterThan(1);
    expect(m.roughness).toBe(1); // the map holds the roughness
    // Textures are loaded once per file: another class using the same set does not load it again.
    const before = loaded.length;
    propMaterial('valley', 'wall');
    propMaterial('valley', 'roof'); // metal_paint, new files
    await vi.waitFor(() => expect(propMaterial('valley', 'roof').map).not.toBeNull());
    expect(loaded.length).toBe(before + 3);
    const paint = propMaterial('valley', 'paint'); // metal_paint again: shared, not reloaded
    await vi.waitFor(() => expect(paint.map).not.toBeNull());
    expect(loaded.length).toBe(before + 3);
    expect(paint.map).toBe(propMaterial('valley', 'roof').map);
  });

  it('keep their flat tint when a texture file fails to load (and say so once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTextureSource(() => Promise.reject(new Error('404')));
    const m = propMaterial('desert', 'wall');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(m.map).toBeNull();
    expect(m.normalMap).toBeNull();
    expect(m.roughnessMap).toBeNull();
    expect(m.roughness).toBeGreaterThan(0.5); // still the flat-colour roughness
  });

  it('use the textures that ship with the game', () => {
    const shipped = Object.keys(import.meta.glob('../../public/assets/textures/*.jpg')).map((f) => f.split('/').pop());
    for (const name of ['plaster_clay', 'plaster_white', 'planks', 'metal_paint', 'snow']) {
      for (const kind of ['diff', 'nor', 'rough']) expect(shipped, `${name}_${kind}.jpg`).toContain(`${name}_${kind}.jpg`);
    }
  });

  it('the shader patch applies to three\'s standard material shader (the includes it replaces exist) and declares what it uses', () => {
    const frag = THREE.ShaderLib.standard.fragmentShader;
    const vert = THREE.ShaderLib.standard.vertexShader;
    for (const inc of ['#include <common>', '#include <map_fragment>', '#include <color_fragment>']) expect(frag, inc).toContain(inc);
    for (const inc of ['#include <common>', '#include <begin_vertex>']) expect(vert, inc).toContain(inc);
    for (const theme of THEMES) {
      for (const cls of PART_CLASSES) {
        const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: vert, fragmentShader: frag };
        patchShaderFor(theme, cls, shader);
        expect(shader.fragmentShader).toContain('uMapMean');
        expect(shader.fragmentShader).toContain('uDirtColor');
        expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
        expect(shader.vertexShader).toContain('vPropY = position.y');
        for (const u of ['uMapMean', 'uContrast', 'uHueKeep', 'uDirtColor', 'uDirtAmount', 'uDirtHeight', 'uMacro']) expect(shader.uniforms[u], u).toBeDefined();
      }
    }
  });

  it('the dirt gets stronger toward the ground: dusty paint, no dirt on glass', () => {
    const s = (theme: ThemeId, cls: Parameters<typeof propMaterial>[1]): Record<string, THREE.IUniform> => {
      const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      patchShaderFor(theme, cls, shader);
      return shader.uniforms;
    };
    expect(s('desert', 'paint').uDirtAmount.value).toBeGreaterThan(0.3);
    expect(s('desert', 'glass').uDirtAmount.value).toBe(0);
    expect(s('desert', 'roof').uDirtAmount.value).toBe(0);
  });

  it('the charred bonnet is one shared dark material', () => {
    expect(burntMaterial()).toBe(burntMaterial());
    expect(burntMaterial().color.r).toBeLessThan(0.05);
  });
});
