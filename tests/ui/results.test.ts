import { describe, expect, it } from 'vitest';
import { newStats, recordImpact, recordShot, startClock } from '../../src/mission/stats';
import { missionTimeText, resultRows } from '../../src/ui/results';

describe('missionTimeText', () => {
  it('formats mm:ss', () => {
    expect(missionTimeText(0)).toBe('00:00');
    expect(missionTimeText(7_400)).toBe('00:07');
    expect(missionTimeText(187_000)).toBe('03:07');
    expect(missionTimeText(75 * 60_000 + 3_000)).toBe('75:03');
  });

  it('never shows a negative or broken time', () => {
    expect(missionTimeText(-5000)).toBe('00:00');
    expect(missionTimeText(NaN)).toBe('00:00');
  });
});

describe('resultRows', () => {
  it('lists shots, hits, accuracy, headshots, longest hit and time', () => {
    let s = newStats(1, 1000);
    for (let i = 0; i < 4; i++) s = recordShot(s);
    s = recordImpact(
      s,
      { bulletId: 1, kind: 'target', targetId: 'soldier-0', zone: 'head', point: { x: 0, y: 0, z: -700 }, time: 1 },
      true,
      734.4,
      66_000,
    );
    expect(resultRows(s)).toEqual([
      ['Shots fired', '4'],
      ['Hits', '1'],
      ['Accuracy', '25 %'],
      ['Headshots', '1'],
      ['Longest hit', '734 m'],
      ['Mission time', '01:05'],
    ]);
  });

  it('counts the mission time from the clock start (first lock or shot), not from loading', () => {
    let s = startClock(newStats(1), 30_000);
    s = recordShot(s);
    s = recordImpact(
      s,
      { bulletId: 1, kind: 'target', targetId: 'soldier-0', zone: 'upperTorso', point: { x: 0, y: 0, z: -300 }, time: 0.4 },
      true,
      300,
      30_000 + 187_000,
    );
    expect(resultRows(s)).toContainEqual(['Mission time', '03:07']);
  });

  it('copes with a mission that has no hit yet', () => {
    const rows = resultRows(newStats(1, 0));
    expect(rows).toContainEqual(['Accuracy', '0 %']);
    expect(rows).toContainEqual(['Longest hit', '—']);
    expect(rows).toContainEqual(['Mission time', '00:00']);
  });
});
