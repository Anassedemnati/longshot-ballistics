import { describe, expect, it } from 'vitest';
import { markAssistsUsed, newStats, recordFailure, recordImpact, recordShot, startClock } from '../../src/mission/stats';
import { failedSummary, missionTimeText, resultRows, resultTitle } from '../../src/ui/results';

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

  it('says "Assists used" only when an aim assist was on', () => {
    expect(resultRows(newStats(1, 0)).map(([label]) => label)).not.toContain('Assists used');
    const rows = resultRows(markAssistsUsed(newStats(1, 0)));
    expect(rows).toContainEqual(['Assists used', 'Yes']);
    expect(rows[rows.length - 1][0]).toBe('Assists used'); // after the score lines
  });
});

describe('resultTitle', () => {
  it('says Mission complete for a won mission and Mission failed for a lost one', () => {
    let won = startClock(newStats(1), 0);
    won = recordImpact(
      won,
      { bulletId: 1, kind: 'target', targetId: 'sniper-0', zone: 'head', point: { x: 0, y: 0, z: -400 }, time: 0.5 },
      true,
      400,
      9000,
    );
    expect(resultTitle(won)).toBe('Mission complete');
    expect(resultTitle(recordFailure(startClock(newStats(3), 0), 9000))).toBe('Mission failed');
    expect(resultTitle(newStats(3))).toBe('Mission complete'); // only reached when the mission ended: nothing else to say
  });
});

describe('the failed variant', () => {
  it('still lists the stats, with the time stopped at the moment of failure', () => {
    let s = startClock(newStats(4), 10_000);
    for (let i = 0; i < 3; i++) s = recordShot(s);
    s = recordImpact(
      s,
      { bulletId: 1, kind: 'target', targetId: 'soldier-0', zone: 'upperTorso', point: { x: 0, y: 0, z: -600 }, time: 0.7 },
      true,
      600,
      20_000,
    );
    const failed = recordFailure(s, 75_000);
    expect(resultRows(failed)).toEqual([
      ['Shots fired', '3'],
      ['Hits', '1'],
      ['Accuracy', '33 %'],
      ['Headshots', '0'],
      ['Longest hit', '600 m'],
      ['Mission time', '01:05'],
    ]);
  });

  it('summarises how many targets were down', () => {
    let s = newStats(4, 0);
    s = recordImpact(
      s,
      { bulletId: 1, kind: 'target', targetId: 'soldier-0', zone: 'head', point: { x: 0, y: 0, z: -500 }, time: 0.7 },
      true,
      500,
      1000,
    );
    expect(failedSummary(recordFailure(s, 5000))).toBe('1 of 4 targets down');
    expect(failedSummary(recordFailure(newStats(1, 0), 5000))).toBe('0 of 1 target down');
  });
});
