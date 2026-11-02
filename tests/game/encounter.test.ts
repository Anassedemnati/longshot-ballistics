import { expect, it } from 'vitest';
import { Encounter } from '../../src/game/encounter';
it('suppressed shots reveal less and cover lowers detection',()=>{const a=new Encounter(),b=new Encounter();a.shot(false);b.shot(true);expect(b.detection).toBeLessThan(a.detection);a.update(1,3,true);expect(a.detection).toBe(26);});
it('warns before bombardment and cover reduces damage',()=>{const a=new Encounter();a.detection=100;a.mortarClock=11.9;a.update(.1,3,false);expect(a.warning).toBe(4);a.update(4,3,true);expect(a.health).toBe(95);});
it('ends on defeat or clearing enemies and does no further damage',()=>{const a=new Encounter();a.update(1,0,false);expect(a.ended).toBe(true);a.update(99,3,false);expect(a.health).toBe(100);const b=new Encounter();b.health=0;b.update(1,3,false);expect(b.ended).toBe(true);});
