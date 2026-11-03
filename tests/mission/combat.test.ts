import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import { Encounter } from '../../src/game/encounter';
import type { Awareness } from '../../src/game/encounter';
import { Combat, incomingPoints } from '../../src/mission/combat';
import type { CombatSniper } from '../../src/mission/combat';
import type { TerrainField } from '../../src/scene/terrainField';
import { ThreatLine, threatText } from '../../src/ui/threat';
import type { ThreatView } from '../../src/ui/threat';

const SHOOTER: Vec3 = { x: 0, y: 12.4, z: 0 };
const FLAT = { height: () => 11 } as Pick<TerrainField, 'height'>;

class FakeSniper implements CombatSniper {
  down = false;
  scans: Array<{ time: number; awareness: Awareness; detected: boolean; covered: boolean }> = [];
  scan(time: number, awareness: Awareness, covered: boolean): void {
    this.scans.push({ time, awareness, detected: awareness === 'firing', covered });
  }
}

function fixture(snipers = 2, suppressed = false, line?: ThreatLine, camo = false) {
  const encounter = new Encounter({ camo });
  const sn = Array.from({ length: snipers }, () => new FakeSniper());
  const log = { text: '', covered: false, flashes: [] as number[], dust: [] as Vec3[], sounds: [] as number[], scopeDrops: 0 };
  const ui: ThreatView = {
    setText: (t) => (log.text = t),
    setCovered: (c) => (log.covered = c),
    flash: (i) => log.flashes.push(i),
    update: () => undefined,
  };
  const combat = new Combat({
    encounter,
    snipers: sn,
    ui,
    field: FLAT as TerrainField,
    shooter: SHOOTER,
    suppressed,
    yaw: () => 0,
    fx: { dust: (p) => log.dust.push(p), impactSound: (d) => log.sounds.push(d) },
    dropScope: () => log.scopeDrops++,
    line,
  });
  return { encounter, sn, log, combat };
}

function run(combat: Combat, seconds: number, paused = false): boolean {
  let failed = false;
  for (let i = 0; i < Math.round(seconds * 10); i++) failed = combat.update(0.1, paused);
  return failed;
}

describe('incomingPoints', () => {
  it('puts a sniper bullet 6 m in front of the player, beside him, alternating sides', () => {
    const a = incomingPoints('shot', 0, SHOOTER, 0, FLAT)[0];
    const b = incomingPoints('shot', 1, SHOOTER, 0, FLAT)[0];
    expect(a.z).toBeCloseTo(-6, 9); // downrange is -Z at yaw 0
    expect(a.x).toBeCloseTo(2, 9);
    expect(b.x).toBeCloseTo(-2, 9);
    expect(a.y).toBe(11);
  });

  it('turns with the view: looking toward +X puts the dust on +X', () => {
    const p = incomingPoints('shot', 0, SHOOTER, -Math.PI / 2, FLAT)[0];
    expect(p.x).toBeCloseTo(6, 9);
  });

  it('a bombardment throws up three puffs', () => {
    expect(incomingPoints('blast', 0, SHOOTER, 0, FLAT)).toHaveLength(3);
  });
});

describe('Combat: detection and fire', () => {
  it('a shot raises the detection by 35, or 9 with a suppressor', () => {
    const a = fixture(1, false);
    a.combat.onShot();
    expect(a.encounter.detection).toBe(35);
    const b = fixture(1, true);
    b.combat.onShot();
    expect(b.encounter.detection).toBe(9);
  });

  it('a shot in a ghillie suit raises the detection by 28, or 7.2 with a suppressor too', () => {
    const a = fixture(1, false, undefined, true);
    a.combat.onShot();
    expect(a.encounter.detection).toBeCloseTo(28, 9);
    const b = fixture(1, true, undefined, true);
    b.combat.onShot();
    expect(b.encounter.detection).toBeCloseTo(7.2, 9);
  });

  it('the crack and dust of a bullet that ended near a sniper raise the detection, suppressor or not', () => {
    for (const suppressed of [false, true]) {
      const f = fixture(1, suppressed);
      f.combat.onBulletEnd(5);
      expect(f.encounter.detection).toBe(25);
      f.combat.onBulletEnd(32.5);
      expect(f.encounter.detection).toBeCloseTo(25 + 12.5, 9);
    }
  });

  it('a bullet that came near no sniper (undefined, Infinity or far) changes nothing', () => {
    const f = fixture(1);
    f.combat.onBulletEnd(undefined);
    f.combat.onBulletEnd(Infinity);
    f.combat.onBulletEnd(300);
    expect(f.encounter.detection).toBe(0);
    expect(f.encounter.awareness).toBe('unaware');
  });

  it('sniper fire hurts, throws dust near the player, sounds and flashes the screen', () => {
    const f = fixture();
    f.encounter.setDetection(100);
    run(f.combat, 4.1);
    expect(f.encounter.health).toBe(82);
    expect(f.log.dust).toHaveLength(1);
    expect(f.log.sounds).toEqual([5]);
    expect(f.log.flashes).toHaveLength(1);
    expect(f.log.flashes[0]).toBeGreaterThan(0.3);
    expect(f.log.text).toContain('Health 82');
    expect(f.log.text).toMatch(/SNIPER FIRING IN \d\.\d s/);
  });

  it('a bombardment is announced, then lands with three puffs and a heavy flash', () => {
    const f = fixture();
    f.encounter.setDetection(100);
    f.encounter.mortarClock = 11.95;
    f.encounter.sniperClock = -100; // keep the snipers quiet
    run(f.combat, 0.2);
    expect(f.log.text).toMatch(/INCOMING BOMBARDMENT \d\.\d s — C: COVER/);
    run(f.combat, 4.1);
    expect(f.encounter.health).toBe(55);
    expect(f.log.dust).toHaveLength(3);
    expect(f.log.sounds).toEqual([1]);
    expect(Math.max(...f.log.flashes)).toBeGreaterThan(0.5);
  });

  it('a shot at a player in cover does no damage and no flash, but still raises dust', () => {
    const f = fixture();
    f.combat.toggleCover(false);
    for (let i = 0; i < 45; i++) {
      f.encounter.setDetection(100);
      f.combat.update(0.1, false);
    }
    expect(f.encounter.health).toBe(100);
    expect(f.log.dust.length).toBeGreaterThanOrEqual(1);
    expect(f.log.flashes).toEqual([]);
  });

  it('paused changes nothing: no fire, no clock, the snipers do not sweep on', () => {
    const f = fixture();
    f.encounter.setDetection(100);
    run(f.combat, 1, false);
    const scansBefore = f.sn[0].scans.at(-1)?.time ?? 0;
    expect(scansBefore).toBeCloseTo(1, 9);
    run(f.combat, 30, true);
    expect(f.encounter.health).toBe(100);
    expect(f.log.dust).toHaveLength(0);
    expect(f.sn[0].scans.at(-1)?.time).toBeCloseTo(1, 9);
    expect(f.log.text).toContain('PAUSED');
  });

  it('feeds every sniper the scan: detected once the detection is high, covered while ducked', () => {
    const f = fixture(3);
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.detected === false)).toBe(true);
    f.encounter.setDetection(80);
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.detected === true)).toBe(true);
    f.combat.toggleCover(false);
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.covered === true)).toBe(true);
  });

  it('feeds every sniper the awareness: unaware, then searching after a shot, then firing', () => {
    const f = fixture(2, true);
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.awareness === 'unaware')).toBe(true);
    f.combat.onShot(); // a suppressed shot: 9 %, below the fire threshold
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.awareness === 'searching')).toBe(true);
    f.encounter.setDetection(80);
    f.combat.update(0.1, false);
    expect(f.sn.every((s) => s.scans.at(-1)?.awareness === 'firing')).toBe(true);
  });

  it('the threat line follows the awareness, and tells of the ghillie suit while unaware', () => {
    const plain = fixture(1);
    plain.combat.update(0.1, false);
    expect(plain.log.text).toMatch(/Enemy unaware$/);
    plain.combat.onShot();
    plain.combat.update(0.1, false);
    expect(plain.log.text).toMatch(/Enemy searching for you · C: cover$/);

    const suit = fixture(1, false, undefined, true);
    suit.combat.update(0.1, false);
    expect(suit.log.text).toMatch(/Enemy unaware · ghillie suit$/);
    suit.combat.onShot();
    suit.combat.update(0.1, false);
    expect(suit.log.text).toMatch(/Enemy searching for you · C: cover$/);
  });

  it('reports the death of the player, and the mission stays failed', () => {
    const f = fixture();
    f.encounter.setDetection(100);
    f.encounter.health = 10;
    expect(run(f.combat, 5)).toBe(true);
    expect(f.log.text).toBe('MISSION FAILED · you were killed');
    expect(f.combat.update(0.1, false)).toBe(true);
  });
});

describe('Combat: snipers left and the end of the fight', () => {
  it('counts the snipers that are still up', () => {
    const f = fixture(3);
    expect(f.combat.snipersLeft).toBe(3);
    f.sn[1].down = true;
    expect(f.combat.snipersLeft).toBe(2);
  });

  it('ends the threat when the last sniper is down: no more fire, the panel says so', () => {
    const f = fixture(2);
    f.encounter.setDetection(100);
    for (const s of f.sn) s.down = true;
    run(f.combat, 30);
    expect(f.encounter.ended).toBe(true);
    expect(f.encounter.health).toBe(100);
    expect(f.log.dust).toHaveLength(0);
    expect(f.log.text).toContain('ALL SNIPERS DOWN');
  });
});

describe('Combat: the last target is a sniper', () => {
  // Killing the last target completes the mission in the same tick: the loop then pauses the fight for good, before
  // the encounter has seen that no sniper is left. The panel above the results must still say the threat is over.
  it('says ALL SNIPERS DOWN, not PAUSED, when the mission completes with the encounter paused', () => {
    const f = fixture(1);
    f.encounter.setDetection(80);
    f.combat.update(0.1, false);
    f.sn[0].down = true;
    f.combat.update(0.1, true);
    expect(f.log.text).toContain('ALL SNIPERS DOWN');
    expect(f.log.text).not.toContain('PAUSED');
    expect(f.log.text).not.toContain('SNIPER FIRING IN');
    expect(f.encounter.health).toBe(100);
  });

  it('shows no countdown frozen over the results, a pending bombardment included', () => {
    const f = fixture(2);
    f.encounter.setDetection(100);
    f.encounter.mortarClock = 11.95;
    f.combat.update(0.1, false);
    expect(f.log.text).toContain('INCOMING BOMBARDMENT');
    for (const s of f.sn) s.down = true;
    f.combat.update(0.1, true);
    expect(f.log.text).not.toContain('INCOMING BOMBARDMENT');
    expect(f.log.text).toContain('ALL SNIPERS DOWN');
  });

  it('brings a ducked player back up even when the fight is paused', () => {
    const f = fixture(1);
    f.combat.toggleCover(false);
    f.sn[0].down = true;
    f.combat.update(0.1, true);
    expect(f.combat.covered).toBe(false);
    expect(f.log.covered).toBe(false);
  });

  it('still says PAUSED while a sniper is up', () => {
    const f = fixture(2);
    f.sn[0].down = true;
    f.combat.update(0.1, true);
    expect(f.log.text).toContain('PAUSED');
    expect(f.log.text).toContain('1 sniper left');
  });

  it('a dead player is never "cleared", paused or not', () => {
    const f = fixture(1);
    f.encounter.setDetection(100);
    f.encounter.health = 10;
    run(f.combat, 5);
    f.sn[0].down = true;
    f.combat.update(0.1, true);
    expect(f.log.text).toBe('MISSION FAILED · you were killed');
  });
});

describe('Combat: cover', () => {
  it('C ducks (mask on, scope dropped), C again comes back up', () => {
    const f = fixture();
    f.combat.toggleCover(false);
    expect(f.combat.covered).toBe(true);
    expect(f.log.covered).toBe(true);
    expect(f.log.scopeDrops).toBe(1);
    f.combat.toggleCover(false);
    expect(f.combat.covered).toBe(false);
    expect(f.log.covered).toBe(false);
    expect(f.log.scopeDrops).toBe(1); // coming up does not touch the scope
  });

  it('is shown as IN COVER on the threat line', () => {
    const f = fixture();
    f.combat.toggleCover(false);
    f.combat.update(0.1, false);
    expect(f.log.text.startsWith('IN COVER')).toBe(true);
  });

  it('cover bleeds the detection 9 per second', () => {
    const f = fixture();
    f.encounter.setDetection(50);
    f.combat.toggleCover(false);
    run(f.combat, 2);
    expect(f.encounter.detection).toBeCloseTo(32, 6);
  });

  it('does nothing when the mission is over', () => {
    const f = fixture();
    f.combat.toggleCover(true);
    expect(f.combat.covered).toBe(false);
    f.combat.toggleCover(false);
    f.combat.toggleCover(true); // over: coming up is refused as well, the screen is final
    expect(f.combat.covered).toBe(true);
  });

  it('cannot duck once the snipers are cleared', () => {
    const f = fixture(1);
    f.sn[0].down = true;
    f.combat.update(0.1, false);
    f.combat.toggleCover(false);
    expect(f.combat.covered).toBe(false);
  });

  it('comes back up by itself when the last sniper falls while the player is ducked (no soft lock)', () => {
    const f = fixture(1);
    f.combat.toggleCover(false);
    f.sn[0].down = true; // the bullet fired before ducking lands now
    f.combat.update(0.1, false);
    expect(f.combat.covered).toBe(false);
    expect(f.log.covered).toBe(false);
  });

  it('may always come up, even while paused or when the encounter has ended', () => {
    const f = fixture(1);
    f.combat.toggleCover(false);
    f.combat.update(0.1, true);
    f.combat.toggleCover(false);
    expect(f.combat.covered).toBe(false);
  });
});

describe('Combat: the threat line is not rebuilt every frame', () => {
  it('builds its text only when something it shows changes', () => {
    const log = { built: 0 };
    const f = fixture(
      2,
      false,
      new ThreatLine((s) => {
        log.built++;
        return threatText(s);
      }),
    );
    for (let i = 0; i < 60; i++) f.combat.update(0.1, true); // paused: nothing moves
    expect(log.built).toBe(1);
    expect(f.log.text).toContain('PAUSED');
    f.encounter.setDetection(20);
    for (let i = 0; i < 30; i++) f.combat.update(0, true); // a frame of no time: still the same line
    expect(log.built).toBe(2); // the detection moved once, and the line followed it once
    f.combat.update(1, false); // unpaused, and the detection rises to 24 %: both change the line, in one rebuild
    expect(log.built).toBe(3);
  });
});
