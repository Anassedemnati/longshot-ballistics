import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FirstPersonRifle,
  breathingSway,
  buildRifleModel,
  type Sway,
} from '../../src/player/rifle';
import { buildEnvironmentScene } from '../../src/player/rifleEnvironment';
import {
  fabricColourPixels,
  fabricNormalPixels,
  metalPixels,
  pebblePixels,
  rifleTextures,
  stipplePixels,
} from '../../src/player/rifleTextures';

const IDS = ['308', '338'] as const;

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) found.push(o);
  });
  return found;
}

function named(root: THREE.Object3D, name: string): THREE.Mesh {
  const mesh = meshes(root).find((m) => m.name === name);
  if (!mesh) throw new Error(`no mesh '${name}'`);
  return mesh;
}

function triangles(mesh: THREE.Mesh): number {
  return mesh.geometry.attributes.position.count / 3;
}

/** Relative luminance of a linear colour. */
function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

describe('rifle finish: surfaces', () => {
  for (const id of IDS) {
    for (const suppressed of [false, true]) {
      describe(`.${id}${suppressed ? ' suppressed' : ''}`, () => {
        const { group } = buildRifleModel(id, suppressed);

        it('has one mesh per surface: stock, metal, rubber, glass, glove (+ bolt, + suppressor)', () => {
          const names = meshes(group).map((m) => m.name).sort();
          expect(names).toEqual(['glass', 'glove', 'metal', 'metal', ...(suppressed ? ['metal'] : []), 'rubber', 'stock'].sort());
        });

        it('keeps the draw calls to a handful (meshes, materials)', () => {
          const all = meshes(group);
          expect(all.length).toBeLessThanOrEqual(8);
          expect(new Set(all.map((m) => m.material)).size).toBeLessThanOrEqual(5);
        });

        it('has gloved hands and sleeves, with real geometry', () => {
          const glove = named(group, 'glove');
          expect(triangles(glove)).toBeGreaterThan(1500);
          const material = glove.material as THREE.MeshStandardMaterial;
          expect(material.map).toBeTruthy(); // the camo-tan cloth
          expect(material.normalMap).toBeTruthy(); // its weave
          // Both hands: the glove geometry reaches the grip (aft, low) and the fore-end (forward, low).
          const box = new THREE.Box3().setFromBufferAttribute(glove.geometry.attributes.position as THREE.BufferAttribute);
          expect(box.min.z).toBeLessThan(-0.3);
          expect(box.max.z).toBeGreaterThan(0.1);
        });

        it('has a coated glass lens at each end of the scope: curved, tinted, not black', () => {
          const glass = named(group, 'glass');
          const material = glass.material as THREE.MeshPhysicalMaterial;
          expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
          // A tinted, reflective, lacquered coating: not a flat black disc.
          expect(luminance(material.color)).toBeGreaterThan(0.03);
          expect(material.color.g).toBeGreaterThan(material.color.r);
          expect(material.metalness).toBeGreaterThan(0.3);
          expect(material.roughness).toBeLessThan(0.12);
          expect(material.clearcoat).toBeGreaterThan(0.5);
          expect(material.iridescence).toBeGreaterThan(0);
          expect(material.transmission).toBe(0); // no extra render pass
          // Both ends: normals toward the shooter (ocular) and toward the muzzle (objective), spread by the curvature.
          const normal = glass.geometry.attributes.normal;
          const position = glass.geometry.attributes.position;
          let rear = 0;
          let front = 0;
          let minZ = Infinity;
          let maxZ = -Infinity;
          let rearSpread = Infinity;
          for (let i = 0; i < normal.count; i++) {
            const nz = normal.getZ(i);
            if (nz > 0.9) rear++;
            if (nz < -0.9) front++;
            if (position.getZ(i) > 0) rearSpread = Math.min(rearSpread, nz);
            minZ = Math.min(minZ, position.getZ(i));
            maxZ = Math.max(maxZ, position.getZ(i));
          }
          expect(rear).toBeGreaterThan(20);
          expect(front).toBeGreaterThan(20);
          expect(rearSpread).toBeLessThan(0.97); // the dome's normals fan out: it is not planar
          expect(maxZ - minZ).toBeGreaterThan(0.4); // objective to ocular
        });

        it('paints edge wear and a texture projection into the parts', () => {
          const metal = named(group, 'metal');
          const colour = metal.geometry.attributes.color;
          expect(colour).toBeTruthy();
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < colour.count; i++) {
            const l = 0.2126 * colour.getX(i) + 0.7152 * colour.getY(i) + 0.0722 * colour.getZ(i);
            lo = Math.min(lo, l);
            hi = Math.max(hi, l);
          }
          expect(hi).toBeGreaterThan(lo * 3); // dark coat, brighter bare edges and parts
          const uv = metal.geometry.attributes.uv;
          expect(uv.count).toBe(metal.geometry.attributes.position.count);
          const stockMaterial = named(group, 'stock').material as THREE.MeshStandardMaterial;
          expect(stockMaterial.normalMap).toBeTruthy(); // polymer stipple
          const metalMaterial = metal.material as THREE.MeshStandardMaterial;
          expect(metalMaterial.roughnessMap).toBeTruthy();
          expect(metalMaterial.metalnessMap).toBeTruthy();
        });
      });
    }
  }

  it('hands can be left out', () => {
    const { group } = buildRifleModel('308', false, false);
    expect(meshes(group).some((m) => m.name === 'glove')).toBe(false);
  });

  it('keeps the whole first-person rifle (flash sprites included) within ten draw calls', () => {
    for (const id of IDS) {
      for (const suppressed of [false, true]) {
        const rifle = new FirstPersonRifle(id, suppressed);
        let calls = 0;
        rifle.scene.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) calls++;
        });
        expect(calls).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe('rifle finish: procedural textures', () => {
  const stats = (pixels: Uint8Array, channel: number) => {
    let sum = 0;
    let sumSq = 0;
    const n = pixels.length / 4;
    for (let i = 0; i < n; i++) {
      const v = pixels[i * 4 + channel] / 255;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
  };

  it('are seeded: the same pixels every time', () => {
    expect(metalPixels(64, 3)).toEqual(metalPixels(64, 3));
    expect(stipplePixels(64, 3)).toEqual(stipplePixels(64, 3));
    expect(metalPixels(64, 3)).not.toEqual(metalPixels(64, 4));
  });

  it('metal: roughness varies, the surface is mostly metallic, bare spots are shinier', () => {
    const pixels = metalPixels(128);
    const rough = stats(pixels, 1);
    const metal = stats(pixels, 2);
    expect(rough.sd).toBeGreaterThan(0.04);
    expect(rough.mean).toBeGreaterThan(0.25);
    expect(rough.mean).toBeLessThan(0.7);
    expect(metal.mean).toBeGreaterThan(0.6);
  });

  it('normal maps hold unit-ish tangent-space normals that tilt (stipple, pebble, weave)', () => {
    for (const pixels of [stipplePixels(128), pebblePixels(128), fabricNormalPixels(128)]) {
      let tilted = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const x = (pixels[i] / 255) * 2 - 1;
        const y = (pixels[i + 1] / 255) * 2 - 1;
        const z = (pixels[i + 2] / 255) * 2 - 1;
        expect(z).toBeGreaterThan(0);
        expect(Math.hypot(x, y, z)).toBeGreaterThan(0.95);
        expect(Math.hypot(x, y, z)).toBeLessThan(1.05);
        if (Math.hypot(x, y) > 0.1) tilted++;
      }
      expect(tilted).toBeGreaterThan(pixels.length / 4 / 8);
    }
  });

  it('fabric: a tan camo (red over green over blue) with visible blotches', () => {
    const pixels = fabricColourPixels(128);
    const r = stats(pixels, 0);
    const g = stats(pixels, 1);
    const b = stats(pixels, 2);
    expect(r.mean).toBeGreaterThan(g.mean);
    expect(g.mean).toBeGreaterThan(b.mean);
    expect(r.sd).toBeGreaterThan(0.05);
  });

  it('are power-of-two, repeating, mip-mapped textures shared between rifles', () => {
    const maps = rifleTextures();
    expect(rifleTextures()).toBe(maps);
    for (const texture of Object.values(maps)) {
      const { width, height } = texture.image as { width: number; height: number };
      expect(Math.log2(width) % 1).toBe(0);
      expect(width).toBe(height);
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.generateMipmaps).toBe(true);
    }
    expect(maps.fabric.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(maps.metal.colorSpace).toBe(THREE.NoColorSpace);
  });
});

describe('rifle finish: environment', () => {
  it('is a small scene of its own with a bright sun and a gradient dome', () => {
    const scene = buildEnvironmentScene();
    let brightest = 0;
    let domeLo = Infinity;
    let domeHi = -Infinity;
    for (const mesh of meshes(scene)) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      brightest = Math.max(brightest, material.color.r, material.color.g, material.color.b);
      const colours = mesh.geometry.attributes.color;
      if (!colours) continue;
      for (let i = 0; i < colours.count; i++) {
        domeLo = Math.min(domeLo, colours.getY(i));
        domeHi = Math.max(domeHi, colours.getY(i));
      }
    }
    expect(meshes(scene).length).toBeLessThanOrEqual(6);
    expect(brightest).toBeGreaterThan(5); // HDR: a sun that glints on the lens
    expect(domeHi - domeLo).toBeGreaterThan(0.2);
  });

  it('is only attached on the first render (no renderer, no environment)', () => {
    const rifle = new FirstPersonRifle('308');
    expect(rifle.scene.environment).toBeNull();
  });
});

describe('rifle finish: breathing sway', () => {
  it('is deterministic, writes into the object it is given, and is periodic', () => {
    const a: Sway = { x: 0, y: 0, pitch: 0, roll: 0 };
    const b: Sway = { x: 9, y: 9, pitch: 9, roll: 9 };
    expect(breathingSway(3.7, a)).toBe(a);
    breathingSway(3.7, b);
    expect(a).toEqual(b);
    const c = breathingSway(0, { x: 0, y: 0, pitch: 0, roll: 0 });
    expect(Number.isFinite(c.y)).toBe(true);
  });

  it('is tiny and bounded, and does move', () => {
    const s: Sway = { x: 0, y: 0, pitch: 0, roll: 0 };
    let minY = Infinity;
    let maxY = -Infinity;
    for (let t = 0; t < 120; t += 0.05) {
      breathingSway(t, s);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(0.002);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(0.004);
      expect(Math.abs(s.pitch)).toBeLessThanOrEqual(0.006);
      expect(Math.abs(s.roll)).toBeLessThanOrEqual(0.004);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
    expect(maxY - minY).toBeGreaterThan(0.002); // visible, if subtle
  });

  it('moves the held rifle without touching the recoil poses', () => {
    const rifle = new FirstPersonRifle('308');
    const holder = rifle.scene.getObjectByName('holder') as THREE.Object3D;
    expect(holder).toBeDefined();
    const restPose = rifle.model.position.clone();
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      rifle.update(1 / 60);
      seen.add(Math.round(holder.position.y * 1e6));
      expect(Math.abs(holder.position.y)).toBeLessThanOrEqual(0.004);
      expect(rifle.model.position.distanceTo(restPose)).toBe(0); // the model's own pose stays put when idle
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('rifle finish: where it sits on screen', () => {
  /** Normalised device coordinates of every vertex of the rifle's meshes (flash excluded). */
  function project(rifle: FirstPersonRifle): { minX: number; maxX: number; minY: number; maxY: number; box: number } {
    rifle.scene.updateMatrixWorld(true);
    rifle.camera.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const mesh of meshes(rifle.model)) {
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).project(rifle.camera);
        minX = Math.max(-1, Math.min(minX, v.x));
        maxX = Math.min(1, Math.max(maxX, v.x));
        minY = Math.max(-1, Math.min(minY, v.y));
        maxY = Math.min(1, Math.max(maxY, v.y));
      }
    }
    return { minX, maxX, minY, maxY, box: ((maxX - minX) * (maxY - minY)) / 4 };
  }

  it('the support arm does not sweep across the lower left: the glove mesh stays right of the muzzle and its sleeve leaves through the bottom', () => {
    for (const id of IDS) {
      const rifle = new FirstPersonRifle(id);
      rifle.resize(1280, 720);
      for (let i = 0; i < 10; i++) rifle.update(1 / 60);
      rifle.scene.updateMatrixWorld(true);
      rifle.camera.updateMatrixWorld(true);
      const glove = named(rifle.model, 'glove');
      const p = glove.geometry.attributes.position;
      const v = new THREE.Vector3();
      let minX = Infinity;
      let minY = Infinity;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(glove.matrixWorld).project(rifle.camera);
        if (v.z > 1) continue; // behind the camera
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
      }
      expect(minX, id).toBeGreaterThan(0.05); // the old long sleeve reached x = 0 and left of it
      expect(minY, id).toBeLessThan(-1); // and it runs off the bottom edge
    }
  });

  for (const id of IDS) {
    for (const suppressed of [false, true]) {
      for (const [w, h] of [
        [1280, 720],
        [1024, 768],
      ]) {
        it(`.${id}${suppressed ? ' suppressed' : ''} at ${w}x${h}: lower right, a quarter of the view, centre clear`, () => {
          const rifle = new FirstPersonRifle(id, suppressed);
          rifle.resize(w, h);
          for (let i = 0; i < 10; i++) rifle.update(1 / 60);
          const box = project(rifle);
          expect(box.box).toBeGreaterThan(0.15);
          expect(box.box).toBeLessThan(0.34);
          expect(box.maxY).toBeLessThan(0.2); // nothing above the middle of the view, apart from the scope's top
          expect((box.minX + box.maxX) / 2).toBeGreaterThan(0.25); // right of centre
          expect((box.minY + box.maxY) / 2).toBeLessThan(-0.15); // below centre
          // The crosshair is clear: a ray through the middle of the view hits none of the rifle.
          const caster = new THREE.Raycaster();
          caster.setFromCamera(new THREE.Vector2(0, 0), rifle.camera);
          expect(caster.intersectObject(rifle.model, true)).toEqual([]);
        });
      }
    }
  }
});
