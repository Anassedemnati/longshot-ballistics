import { expect,it } from 'vitest';
import { Vector3, Sprite } from 'three';
import { createSniper,sniperPositions } from '../../src/scene/sniper';
import { createOutpost } from '../../src/scene/outpost';
it('places prone hit zones above the rooftops and terrain',()=>{
 const sites=sniperPositions(150),outpost=createOutpost(150,'outpost');
 sites.forEach((site,index)=>{
  const sniper=createSniper(site,index);
  expect(sniper.hitTarget.zones.length).toBeGreaterThan(10);
  expect(sniper.hitTarget.zones.every(zone=>zone.center.y>outpost.height(zone.center.x,zone.center.z))).toBe(true);
  expect(Math.max(...sniper.hitTarget.zones.map(z=>z.center.y))-site.y).toBeLessThan(.6);
 });
});
it('glints sweep, lock on, respect cover, and vanish on defeat',()=>{
 const sniper=createSniper(sniperPositions(150)[0],0);let glint:Sprite|undefined;
 sniper.group.traverse(o=>{if(o instanceof Sprite)glint=o;});
 const eye=new Vector3(0,12,0);
 sniper.scan(0,false,false,eye);expect(glint!.visible).toBe(true);
 sniper.scan(1.8,false,false,eye);expect(glint!.visible).toBe(false);
 sniper.scan(1.8,true,false,eye);expect(glint!.visible).toBe(true);
 sniper.scan(1.8,true,true,eye);expect(glint!.visible).toBe(false);
 sniper.knockDown();sniper.scan(0,true,false,eye);expect(glint!.visible).toBe(false);
});

it('defeated sniper removes its scope light and never restores it during later scans',()=>{
 const sniper=createSniper(sniperPositions(150)[0],0);
 let glint:Sprite|undefined;
 sniper.group.traverse(o=>{if(o instanceof Sprite)glint=o;});
 const eye=new Vector3(0,12,0);
 sniper.scan(0,true,false,eye);
 sniper.knockDown();
 expect(glint!.parent).toBeNull();
 expect(glint!.material.opacity).toBe(0);
 for(let i=0;i<300;i++) { sniper.update(.1);sniper.scan(i*.1,true,false,eye); }
 expect(glint!.visible).toBe(false);
 expect(glint!.parent).toBeNull();
 expect(sniper.down).toBe(true);
 sniper.reset();sniper.scan(0,true,false,eye);
 expect(glint!.parent).not.toBeNull();
 expect(glint!.visible).toBe(true);
});
