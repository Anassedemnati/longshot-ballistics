import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { facingYaw } from '../../src/mission/layout';
import { SNIPER_BOUNDS_MARGIN, SNIPER_PARTS, sniperAimPoints, sniperHitSpheres, sniperWorldPoint } from '../../src/mission/sniperDims';
import { createSniper } from '../../src/scene/sniper';
import { SHOOTER_POS, terrainHeight } from '../../src/scene/terrainHeight';
import { bonesOf } from '../helpers/bones';
import { shootAtPoint } from '../helpers/shoot';

const EYE = { x: 0, y: 12, z: 0 };

function at(x: number, z: number, id = 'sniper-0') {
  const y = terrainHeight(x, z);
  return { pose: { x, y, z, yaw: facingYaw(x, z) }, sniper: createSniper({ x, y, z }, facingYaw(x, z), id) };
}

function glintOf(group: THREE.Group): THREE.Sprite {
  let found: THREE.Sprite | undefined;
  group.traverse((o) => {
    if (o instanceof THREE.Sprite) found = o;
  });
  if (!found) throw new Error('no glint sprite');
  return found;
}

describe('createSniper: shape', () => {
  it('puts the group at the position, turned by the yaw, with the id on the hit target', () => {
    const { sniper } = at(30, -500, 'sniper-2');
    expect(sniper.group.position.x).toBe(30);
    expect(sniper.group.position.z).toBe(-500);
    expect(sniper.group.rotation.y).toBeCloseTo(facingYaw(30, -500), 12);
    expect(sniper.hitTarget.id).toBe('sniper-2');
    expect(sniper.down).toBe(false);
  });

  it('builds the hit zones from the shared dimensions, in the world', () => {
    const { pose, sniper } = at(30, -500);
    const spheres = sniperHitSpheres();
    expect(sniper.hitTarget.zones).toHaveLength(spheres.length);
    spheres.forEach((s, i) => {
      const w = sniperWorldPoint(pose, s);
      const z = sniper.hitTarget.zones[i];
      expect(z.name).toBe(s.name);
      expect(z.radius).toBe(s.radius);
      expect(z.center.x).toBeCloseTo(w.x, 9);
      expect(z.center.y).toBeCloseTo(w.y, 9);
      expect(z.center.z).toBeCloseTo(w.z, 9);
    });
  });

  it('has a broad-phase sphere that encloses every zone with the 0.05 m margin', () => {
    const { sniper } = at(-40, -300);
    const b = sniper.hitTarget.bounds;
    expect(b).toBeDefined();
    if (!b) return;
    let farthest = 0;
    for (const z of sniper.hitTarget.zones) {
      const d = Math.hypot(z.center.x - b.center.x, z.center.y - b.center.y, z.center.z - b.center.z) + z.radius;
      expect(d).toBeLessThanOrEqual(b.radius - SNIPER_BOUNDS_MARGIN + 1e-9);
      farthest = Math.max(farthest, d);
    }
    expect(b.radius).toBeLessThanOrEqual(farthest + SNIPER_BOUNDS_MARGIN + 1e-9);
  });

  it('is cheap to draw: a body, a rifle and a glint', () => {
    const { sniper } = at(0, -400);
    let meshes = 0;
    let sprites = 0;
    sniper.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
      if (o instanceof THREE.Sprite) sprites++;
    });
    expect(meshes).toBe(2);
    expect(sprites).toBe(1);
  });

  it('shares geometry and material between snipers, but never the glint material', () => {
    const a = at(0, -400, 'sniper-0').sniper;
    const b = at(20, -420, 'sniper-1').sniper;
    const bodyOf = (g: THREE.Group): THREE.Mesh => g.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(bodyOf(a.group).geometry).toBe(bodyOf(b.group).geometry);
    expect(bodyOf(a.group).material).toBe(bodyOf(b.group).material);
    expect(glintOf(a.group).material).not.toBe(glintOf(b.group).material);
  });
});

describe('createSniper: real shots', () => {
  // A sniper lying 400 m downrange, 6 m off the centreline, shot at from the shooter's own position.
  const parts: Array<[string, (typeof SNIPER_PARTS)[number]]> = SNIPER_PARTS.map((p, i) => [`${p.zone} #${i}`, p]);

  it('a shot at the head centre is a head hit on the sniper', () => {
    const { pose, sniper } = at(6, -400);
    const events = shootAtPoint(sniperAimPoints(pose).head, [sniper.hitTarget]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'target', targetId: 'sniper-0', zone: 'head' });
  });

  it('a shot at the upper-torso centre is an upper-torso hit on the sniper', () => {
    const { pose, sniper } = at(6, -400);
    const events = shootAtPoint(sniperAimPoints(pose).upperTorso, [sniper.hitTarget]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'target', targetId: 'sniper-0', zone: 'upperTorso' });
  });

  it.each(parts)('a shot at the middle of %s is a hit on the sniper', (_name, part) => {
    for (const [x, z] of [[6, -400], [-35, -700]] as const) {
      const { pose, sniper } = at(x, z);
      const centre = sniperWorldPoint(pose, { x: part.cx, y: part.cy, z: part.cz });
      const events = shootAtPoint(centre, [sniper.hitTarget]);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('target');
      if (events[0].kind === 'target') expect(events[0].targetId).toBe('sniper-0');
    }
  });

  it('a shot through the edge of the chest (0.2 m to the side) still hits', () => {
    const { pose, sniper } = at(6, -400);
    const torso = SNIPER_PARTS.find((p) => p.zone === 'upperTorso');
    if (!torso) throw new Error('no torso');
    for (const side of [-1, 1]) {
      const edge = sniperWorldPoint(pose, { x: side * 0.2, y: torso.cy, z: torso.cz });
      const events = shootAtPoint(edge, [sniper.hitTarget]);
      expect(events[0].kind).toBe('target');
    }
  });

  it('a shot 0.4 m over the head or 0.5 m to the side misses', () => {
    const { pose, sniper } = at(6, -400);
    const head = sniperAimPoints(pose).head;
    expect(shootAtPoint({ ...head, y: head.y + 0.4 }, [sniper.hitTarget])[0].kind).not.toBe('target');
    expect(shootAtPoint({ ...head, x: head.x + 0.5 }, [sniper.hitTarget])[0].kind).not.toBe('target');
  });

  it('is shot from where the player lies: the shooter position is the one the tests use', () => {
    expect(SHOOTER_POS.y).toBeGreaterThan(terrainHeight(0, 0));
  });
});

describe('createSniper: glint', () => {
  it('sweeps: visible while the scope looks at the player, hidden while it looks away', () => {
    const { sniper } = at(0, -400);
    const glint = glintOf(sniper.group);
    sniper.scan(0, 'unaware', false, EYE);
    expect(glint.visible).toBe(true); // sin(0) = 0: looking straight at the player
    sniper.scan(1.8, 'unaware', false, EYE);
    expect(glint.visible).toBe(false); // sin(1.53) ~ 1: looking away
    expect(sniper.glintVisible).toBe(false);
  });

  it('narrows the sweep and shows the glint more often once the snipers are searching', () => {
    const { sniper } = at(0, -400);
    const glint = glintOf(sniper.group);
    const rifleOf = (): THREE.Object3D => sniper.group.children.find((c) => c.type === 'Group' && c.children.some((k) => k === glint)) as THREE.Object3D;
    // Over a full sweep the glint is up for more of the time than it is while unaware.
    let unaware = 0;
    let searching = 0;
    let widestUnaware = 0;
    let widestSearching = 0;
    for (let i = 0; i < 400; i++) {
      const t = i * 0.05;
      sniper.scan(t, 'unaware', false, EYE);
      if (sniper.glintVisible) unaware++;
      widestUnaware = Math.max(widestUnaware, Math.abs(rifleOf().rotation.y));
      sniper.scan(t, 'searching', false, EYE);
      if (sniper.glintVisible) searching++;
      widestSearching = Math.max(widestSearching, Math.abs(rifleOf().rotation.y));
    }
    expect(searching).toBeGreaterThan(unaware * 1.5);
    expect(searching).toBeLessThan(400); // still a sweep, not steady
    expect(widestSearching).toBeLessThan(widestUnaware * 0.5);
    expect(widestSearching).toBeGreaterThan(0);
  });

  it('a searching sniper still looks away at the far end of his sweep (hidden at 1.8 s, as unaware)', () => {
    const { sniper } = at(0, -400);
    sniper.scan(1.8, 'searching', false, EYE);
    expect(sniper.glintVisible).toBe(false);
    sniper.scan(0, 'searching', false, EYE);
    expect(sniper.glintVisible).toBe(true);
  });

  it('is steady once the player is detected, and the rifle then points at him', () => {
    const { sniper } = at(0, -400);
    const glint = glintOf(sniper.group);
    sniper.scan(1.8, 'firing', false, EYE);
    expect(glint.visible).toBe(true);
    expect(glint.material.opacity).toBeCloseTo(0.95, 9);
    expect(sniper.glintVisible).toBe(true);
  });

  it('is hidden while the player is in cover', () => {
    const { sniper } = at(0, -400);
    sniper.scan(1.8, 'firing', true, EYE);
    expect(sniper.glintVisible).toBe(false);
  });

  it('grows with the distance so it stays a cue at a kilometre', () => {
    const near = at(0, -100).sniper;
    const far = at(0, -1000).sniper;
    near.scan(0, 'firing', false, EYE);
    far.scan(0, 'firing', false, EYE);
    expect(glintOf(near.group).scale.x).toBeCloseTo(0.8, 9);
    expect(glintOf(far.group).scale.x).toBeGreaterThan(3);
  });

  it('two snipers do not sweep in step', () => {
    const a = at(0, -400, 'sniper-0').sniper;
    const b = at(10, -400, 'sniper-1').sniper;
    a.scan(0, 'unaware', false, EYE);
    b.scan(0, 'unaware', false, EYE);
    expect(a.glintVisible).not.toBe(b.glintVisible);
  });
});

describe('createSniper: knocked down', () => {
  it('loses its glint for good, whatever the scan says afterwards', () => {
    const { sniper } = at(0, -400);
    const glint = glintOf(sniper.group);
    sniper.scan(0, 'firing', false, EYE);
    sniper.knockDown();
    expect(sniper.down).toBe(true);
    expect(glint.parent).toBeNull();
    expect(glint.material.opacity).toBe(0);
    for (let i = 0; i < 300; i++) {
      sniper.update(0.1);
      sniper.scan(i * 0.1, 'firing', false, EYE);
    }
    expect(sniper.glintVisible).toBe(false);
    expect(glint.parent).toBeNull();
    expect(sniper.down).toBe(true);
  });

  it('slumps: the head drops, the arms go limp, and he comes to rest and stays there', () => {
    const { sniper } = at(0, -400);
    const bones = () => bonesOf(sniper.group).map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
    const rest = bones();
    sniper.update(0.5);
    bones().forEach((b, i) => expect(b.p.distanceTo(rest[i].p)).toBe(0)); // up: no change
    sniper.knockDown({ point: { x: 0, y: 0.37, z: -400.2 }, velocity: { x: 0, y: 0, z: 800 }, zone: 'head' });
    sniper.update(0.15);
    const early = bones();
    expect(early[2].q.angleTo(rest[2].q)).toBeGreaterThan(0.05); // the head bone has turned: it is dropping
    for (let i = 0; i < 40; i++) sniper.update(0.1);
    const settled = bones();
    expect(settled[2].q.angleTo(rest[2].q)).toBeGreaterThan(0.2); // head down on the ground
    for (const bone of bonesOf(sniper.group)) expect(bone.position.y).toBeGreaterThan(-0.05); // not sunk into the ground
    sniper.update(5);
    bones().forEach((b, i) => expect(b.p.distanceTo(settled[i].p)).toBe(0)); // asleep: nothing moves any more
    expect(sniper.group.rotation.z).toBe(0); // posed bone by bone, no rigid roll
  });

  it('can be stood up again by an explicit reset, glint included', () => {
    const { sniper } = at(0, -400);
    sniper.knockDown();
    sniper.reset();
    sniper.scan(0, 'firing', false, EYE);
    expect(sniper.down).toBe(false);
    expect(bonesOf(sniper.group)[2].quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9); // back in the bind pose
    expect(sniper.glintVisible).toBe(true);
  });

  it('dispose releases the glint material and nothing shared', () => {
    const { sniper } = at(0, -400);
    const glint = glintOf(sniper.group);
    let disposed = 0;
    glint.material.addEventListener('dispose', () => disposed++);
    const body = sniper.group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh) as THREE.Mesh;
    let geometryDisposed = 0;
    body.geometry.addEventListener('dispose', () => geometryDisposed++);
    sniper.dispose();
    expect(disposed).toBe(1);
    expect(geometryDisposed).toBe(0);
  });
});
