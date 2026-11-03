import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BloodSystem } from '../../src/fx/blood';
import { createRng } from '../../src/mission/random';

describe('BloodSystem', () => {
  const points = (b: BloodSystem): THREE.Points => b.group.children[0] as THREE.Points;

  it('draws nothing while idle, a wound while particles live, and is over within about a second, in a fixed buffer', () => {
    const blood = new BloodSystem(createRng(1));
    const size = points(blood).geometry.getAttribute('position').count;
    expect(points(blood).visible).toBe(false);
    blood.spawnEntry({ x: 0, y: 1.3, z: -100 }, { x: 0, y: 0, z: -1 });
    blood.spawnExit({ x: 0, y: 1.3, z: -100.3 }, { x: 0, y: 0, z: -1 });
    expect(points(blood).visible).toBe(true);
    expect(blood.count).toBeGreaterThan(30);
    for (let i = 0; i < 20; i++) blood.update(0.05);
    expect(blood.count).toBe(0); // every particle lives under a second
    expect(points(blood).visible).toBe(false);
    expect(points(blood).geometry.getAttribute('position').count).toBe(size);
  });

  it('sprays the exit along the bullet and the entry back toward the shooter, and the droplets fall', () => {
    const blood = new BloodSystem(createRng(2));
    const at = points(blood).geometry.getAttribute('position') as THREE.BufferAttribute;
    const dir = { x: 0, y: 0, z: -1 };
    blood.spawnExit({ x: 0, y: 2, z: -100 }, dir);
    blood.update(0.1);
    const zs: number[] = [];
    for (let i = 0; i < blood.count; i++) zs.push(at.getZ(i));
    expect(zs.filter((z) => z < -100).length).toBeGreaterThan(zs.length * 0.8); // beyond the exit point
    for (let i = 0; i < 6; i++) blood.update(0.1);
    const ys = Array.from({ length: at.count }, (_, i) => at.getY(i)).filter((y) => y !== 0);
    expect(Math.min(...ys)).toBeLessThan(1.9); // droplets have dropped
    const entry = new BloodSystem(createRng(3));
    entry.spawnEntry({ x: 0, y: 1, z: -100 }, dir);
    entry.update(0.1);
    const ez = points(entry).geometry.getAttribute('position') as THREE.BufferAttribute;
    const back = Array.from({ length: ez.count }, (_, i) => ez.getZ(i)).filter((z) => z !== 0 && z > -100);
    expect(back.length).toBeGreaterThan(5); // thrown back toward the shooter (+Z)
  });

  it('dispose is safe to repeat and spawning afterwards does nothing', () => {
    const blood = new BloodSystem();
    blood.dispose();
    blood.dispose();
    blood.spawnEntry({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    expect(blood.count).toBe(0);
  });
});
