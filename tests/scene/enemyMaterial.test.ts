import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAMO_TONES, ENEMY_UV_TILE_M, SURFACES } from '../../src/mission/enemySurface';
import { DUMMY_KHAKI } from '../../src/mission/dummyDims';
import { SURFACE_ATTRIBUTE, enemyMaterial } from '../../src/scene/enemyMaterial';
import { ENEMY_TEXTURE_SIZE, camoPixels, clothNormalPixels, enemyTextures, meanLinear } from '../../src/scene/enemyTextures';
import { EnemyBuilder, bevelledBox, capsuleProfile } from '../../src/scene/enemyParts';

// The enemies share one MeshStandardMaterial, patched so each vertex picks its own surface. The patch is plain string
// replacement on three's shader source, so these tests pin down the chunks it relies on: a three.js upgrade that renames one
// fails here instead of silently drawing every soldier as flat plastic.

describe('enemy material', () => {
  const m = enemyMaterial();

  it('is one shared MeshStandardMaterial with the camo map, the cloth normal map and vertex colours', () => {
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(enemyMaterial()).toBe(m);
    expect(m.map).toBe(enemyTextures().camo);
    expect(m.normalMap).toBe(enemyTextures().clothNormal);
    expect(m.vertexColors).toBe(true);
    expect(m.transparent).toBe(false);
    expect(m.side).toBe(THREE.FrontSide);
  });

  it("patches three's own standard shader at chunks that exist in this version of three", () => {
    const vertex = THREE.ShaderLib.standard.vertexShader;
    const fragment = THREE.ShaderLib.standard.fragmentShader;
    for (const chunk of ['#include <common>', '#include <begin_vertex>']) expect(vertex, chunk).toContain(chunk);
    for (const chunk of ['#include <common>', '#include <map_fragment>', '#include <roughnessmap_fragment>', '#include <metalnessmap_fragment>', '#include <normal_fragment_maps>']) {
      expect(fragment, chunk).toContain(chunk);
    }
    // normal_fragment_begin defines the unperturbed normal the patch mixes back toward
    expect(THREE.ShaderChunk.normal_fragment_begin).toContain('vec3 nonPerturbedNormal = normal;');
  });

  it('reads the surface attribute in the vertex shader and the camo share, roughness, metalness and bump from it in the fragment shader', () => {
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain(`attribute vec4 ${SURFACE_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`vSurface = ${SURFACE_ATTRIBUTE};`);
    expect(shader.fragmentShader).toContain('varying vec4 vSurface;');
    expect(shader.fragmentShader).toContain('mix( vec3( 1.0 ), sampledDiffuseColor.rgb, vSurface.x )');
    expect(shader.fragmentShader).toContain('float roughnessFactor = vSurface.y;');
    expect(shader.fragmentShader).toContain('float metalnessFactor = vSurface.z;');
    expect(shader.fragmentShader).toContain('mix( nonPerturbedNormal, normal, vSurface.w )');
    // nothing is left unpatched: the stock chunks it replaced are gone
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.fragmentShader).not.toContain('#include <roughnessmap_fragment>');
  });

  it('has one program key (every enemy shares the one compiled program)', () => {
    expect(m.customProgramCacheKey()).toBe(m.customProgramCacheKey());
    expect(m.customProgramCacheKey()).toContain('enemy');
  });
});

describe('enemy surfaces', () => {
  it('are in the ranges the shader expects, cloth rough (0.85-0.95), steel shiny and metallic, skin and glass smooth', () => {
    for (const [key, s] of Object.entries(SURFACES)) {
      for (const v of [s.camo, s.roughness, s.metalness, s.bump]) {
        expect(v, key).toBeGreaterThanOrEqual(0);
        expect(v, key).toBeLessThanOrEqual(1);
      }
    }
    expect(SURFACES.camo.roughness).toBeGreaterThanOrEqual(0.85);
    expect(SURFACES.camo.roughness).toBeLessThanOrEqual(0.95);
    expect(SURFACES.cloth.roughness).toBeGreaterThanOrEqual(0.85);
    expect(SURFACES.camo.camo).toBe(1);
    expect(SURFACES.metal.metalness).toBeGreaterThan(0.7);
    expect(SURFACES.metal.roughness).toBeLessThan(0.6);
    expect(SURFACES.skin.bump).toBeLessThan(0.3);
    expect(SURFACES.glass.roughness).toBeLessThan(0.2);
  });
});

describe('enemy textures', () => {
  const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const camo = camoPixels();

  it('are power-of-two squares that tile and mip-map (the same size, linear-light colour map, data normal map)', () => {
    expect(ENEMY_TEXTURE_SIZE & (ENEMY_TEXTURE_SIZE - 1)).toBe(0);
    expect(camo.length).toBe(ENEMY_TEXTURE_SIZE ** 2 * 4);
    expect(clothNormalPixels().length).toBe(ENEMY_TEXTURE_SIZE ** 2 * 4);
    const { camo: colour, clothNormal } = enemyTextures();
    expect(colour.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(clothNormal.colorSpace).toBe(THREE.NoColorSpace);
    for (const t of [colour, clothNormal]) {
      expect(t.wrapS).toBe(THREE.RepeatWrapping);
      expect(t.generateMipmaps).toBe(true);
    }
  });

  it('are the same pixels every run (seeded)', () => {
    expect(Array.from(camoPixels(64)).slice(0, 200)).toEqual(Array.from(camoPixels(64)).slice(0, 200));
  });

  it('camo averages to the old khaki (so at range, where the blotches blur out, he is the tone he always was), in four tones with moderate contrast', () => {
    const mean = meanLinear(camo);
    const old = new THREE.Color(DUMMY_KHAKI);
    const oldLuminance = lum(old.r, old.g, old.b);
    expect(mean.luminance / oldLuminance).toBeGreaterThan(0.95);
    expect(mean.luminance / oldLuminance).toBeLessThan(1.1);
    // hue: the same khaki family (red > green > blue)
    expect(mean.r).toBeGreaterThan(mean.g);
    expect(mean.g).toBeGreaterThan(mean.b);
    // the pattern is real but low-contrast: the darkest and lightest tones of the print differ by a factor of 2-4 in linear light, no more
    const tone = (hex: number): number => {
      const c = new THREE.Color(hex);
      return lum(c.r, c.g, c.b);
    };
    const tones = Object.values(CAMO_TONES).map(tone);
    expect(Math.max(...tones) / Math.min(...tones)).toBeGreaterThan(1.5);
    expect(Math.max(...tones) / Math.min(...tones)).toBeLessThan(4);
    // and every one of the four tones shows up in the texture (a texel within 10 % of it in each channel)
    for (const hex of Object.values(CAMO_TONES)) {
      const [r, g, b] = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
      let found = 0;
      for (let i = 0; i < camo.length; i += 4) {
        if (Math.abs(camo[i] - r) < 14 && Math.abs(camo[i + 1] - g) < 14 && Math.abs(camo[i + 2] - b) < 14) found++;
      }
      expect(found, hex.toString(16)).toBeGreaterThan(ENEMY_TEXTURE_SIZE ** 2 * 0.02);
    }
  });

  it('camo tiles: the seam between the last and the first texel row and column is no rougher than the texture inside', () => {
    const n = ENEMY_TEXTURE_SIZE;
    const step = (x0: number, y0: number, x1: number, y1: number): number => {
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(camo[(y0 * n + x0) * 4 + c] - camo[(y1 * n + x1) * 4 + c]);
      return d / 3;
    };
    let seam = 0;
    let inside = 0;
    for (let i = 0; i < n; i++) {
      seam += step(n - 1, i, 0, i) + step(i, n - 1, i, 0);
      inside += step(n / 2 - 1, i, n / 2, i) + step(i, n / 2 - 1, i, n / 2);
    }
    expect(seam / inside).toBeLessThan(1.5);
  });

  it('cloth normal map holds unit tangent-space normals pointing out of the surface, with a weave that leans them a little', () => {
    const p = clothNormalPixels(64);
    let leaning = 0;
    for (let i = 0; i < p.length; i += 4) {
      const x = (p[i] / 255) * 2 - 1;
      const y = (p[i + 1] / 255) * 2 - 1;
      const z = (p[i + 2] / 255) * 2 - 1;
      expect(Math.hypot(x, y, z)).toBeGreaterThan(0.97);
      expect(Math.hypot(x, y, z)).toBeLessThan(1.03);
      expect(z).toBeGreaterThan(0.5);
      if (z < 0.995) leaning++;
    }
    expect(leaning).toBeGreaterThan(p.length / 4 / 3);
  });

  it('are mapped at one metre a tile', () => {
    expect(ENEMY_UV_TILE_M).toBe(1);
  });
});

describe('enemy geometry builder', () => {
  it('bevelledBox is a closed box of the right size with outward normals (44 triangles)', () => {
    const g = bevelledBox(0.2, 0.4, 0.6, 0.03);
    expect(g.getAttribute('position').count / 3).toBe(44);
    g.computeBoundingBox();
    const box = g.boundingBox as THREE.Box3;
    expect(box.max.x).toBeCloseTo(0.1, 6);
    expect(box.min.y).toBeCloseTo(-0.2, 6);
    expect(box.max.z).toBeCloseTo(0.3, 6);
    // every triangle faces away from the centre (winding agrees with the normals), and the volume is positive and a bit under w*h*d
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    let volume = 0;
    for (let i = 0; i < p.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i);
      const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
      volume += a.dot(b.clone().cross(c)) / 6;
      const face = b.clone().sub(a).cross(c.clone().sub(a));
      const mean = new THREE.Vector3(n.getX(i) + n.getX(i + 1) + n.getX(i + 2), n.getY(i) + n.getY(i + 1) + n.getY(i + 2), n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2));
      expect(face.dot(mean)).toBeGreaterThanOrEqual(0);
    }
    expect(volume).toBeGreaterThan(0.2 * 0.4 * 0.6 * 0.9);
    expect(volume).toBeLessThan(0.2 * 0.4 * 0.6);
  });

  it('capsuleProfile runs from the pole of one end to the pole of the other, widening to each end cap', () => {
    const profile = capsuleProfile(0.05, 0.03, 0.4, 2);
    expect(profile[0].x).toBeCloseTo(0, 9);
    expect(profile[0].y).toBeCloseTo(-0.05, 9);
    expect(profile[profile.length - 1].x).toBeCloseTo(0, 9);
    expect(profile[profile.length - 1].y).toBeCloseTo(0.43, 9);
    expect(Math.max(...profile.map((q) => q.x))).toBeCloseTo(0.05, 9);
    for (let i = 1; i < profile.length; i++) expect(profile[i].y).toBeGreaterThanOrEqual(profile[i - 1].y - 1e-9);
  });

  it('collects parts into one geometry: positions, normals, a linear colour, the surface and the texture coordinates', () => {
    const b = new EnemyBuilder();
    b.tube([0, 0, 0], [0, 1, 0], 0.1, 0.08, 'camo', 0xffffff);
    b.ellipsoid([0, 2, 0], [0.2, 0.1, 0.1], 'skin', 0x9a7556);
    b.box([1, 0, 0], [0.1, 0.1, 0.1], 0.01, 'metal', 0x26292b);
    b.strand([0, 0, 0], [0, 0.1, 0], 0.005, 0x808040);
    const g = b.build();
    const n = g.getAttribute('position').count;
    expect(n).toBe(b.triangles * 3);
    for (const name of ['normal', 'color', 'uv', SURFACE_ATTRIBUTE]) expect(g.getAttribute(name).count, name).toBe(n);
    // the first vertex is the tube's, with the camo surface
    expect(g.getAttribute(SURFACE_ATTRIBUTE).getX(0)).toBeCloseTo(SURFACES.camo.camo, 6);
    expect(g.getAttribute(SURFACE_ATTRIBUTE).getY(0)).toBeCloseTo(SURFACES.camo.roughness, 6);
    // the last triangles are the strand's, flat-shaded with unit normals
    const last = n - 1;
    expect(g.getAttribute(SURFACE_ATTRIBUTE).getX(last)).toBeCloseTo(SURFACES.strand.camo, 6);
    expect(Math.hypot(g.getAttribute('normal').getX(last), g.getAttribute('normal').getY(last), g.getAttribute('normal').getZ(last))).toBeCloseTo(1, 5);
    expect(b.triangles).toBeGreaterThan(100);
  });

  it('a strand is three triangles (a closed spike against the suit, nothing double-sided) from root to tip', () => {
    const b = new EnemyBuilder();
    b.strand([0, 0, 0], [0.05, 0.1, 0.02], 0.006, 0x808040);
    expect(b.triangles).toBe(3);
    const g = b.build();
    g.computeBoundingBox();
    const box = g.boundingBox as THREE.Box3;
    expect(box.max.y).toBeCloseTo(0.1, 6);
    expect(box.max.x).toBeGreaterThanOrEqual(0.05 - 1e-6);
  });
});
