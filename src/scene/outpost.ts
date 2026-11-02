import * as THREE from 'three';
import { terrainHeight } from './terrainHeight';

export function createOutpost(range: number, theme: 'outpost' | 'convoy') {
  const group = new THREE.Group();
  const obstacles: {x:number;z:number;w:number;d:number;top:number}[] = [];
  const plaster = new THREE.MeshStandardMaterial({color:0xa9977a,roughness:.98});
  const stone = new THREE.MeshStandardMaterial({color:0x766e5c,roughness:1});
  const dark = new THREE.MeshStandardMaterial({color:0x222b2c,roughness:.7});
  const paint = new THREE.MeshStandardMaterial({color:0x63644d,roughness:.7,metalness:.3});
  const glass = new THREE.MeshStandardMaterial({color:0x425b61,roughness:.22,metalness:.5});
  function box(w:number,h:number,d:number,x:number,y:number,z:number,mat:THREE.Material) {
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;group.add(m);return m;
  }
  for (const [x,z,w,h,d] of [[-19,-range-6,10,6,9],[22,-range-20,12,9,11],[-35,-range-35,9,4,8],[36,-range-60,18,5,12]]) {
    const ground=terrainHeight(x,z);
    box(w,h,d,x,ground+h/2,z,plaster);obstacles.push({x,z,w,d,top:ground+h});
    box(w+.5,.25,d+.5,x,ground+h,z,stone);
    for(const side of [-1,1]) box(.22,1,d, x+side*w/2,ground+h+.5,z,plaster);
    for(let i=0;i<3;i++) for(let floor=0;floor<Math.floor(h/3);floor++) {
      box(1.3,1.5,.04,x-w*.3+i*w*.3,ground+1.8+floor*3,z+d/2+.03,dark);
      box(1.55,.13,.25,x-w*.3+i*w*.3,ground+1+floor*3,z+d/2+.08,stone);
    }
    box(1.5,2.5,.05,x,ground+1.25,z+d/2+.04,dark);
    // Weathered seams and utility conduits break up blank plaster.
    for(let i=0;i<5;i++) box(w,.025,.03,x,ground+.4+i*h/5,z+d/2+.06,stone);
    box(.07,h,.09,x+w*.42,ground+h/2,z+d/2+.08,dark);
  }
  const vehicles = theme === 'convoy' ? [-10,7,16] : [10];
  for(const x of vehicles) {
    const z=-range+12+(x%3)*4, y=terrainHeight(x,z);
    box(2.1,.7,4.8,x,y+1,z,paint);box(2,1.25,2,x,y+1.9,z+.8,paint);
    box(1.8,.7,.035,x,y+2.05,z+1.82,glass);
    box(1.8,.15,.3,x,y+1.25,z+2.5,dark);
    box(2,.15,2.3,x,y+1.5,z-1.2,paint);
    for(const side of [-1,1]) for(const dz of [-1.5,1.5]) {
      const wheel=new THREE.Mesh(new THREE.CylinderGeometry(.5,.5,.3,20),dark);wheel.rotation.z=Math.PI/2;wheel.position.set(x+side*1.05,y+.55,z+dz);group.add(wheel);
      box(.3,.2,.04,x+side*.7,y+1.25,z+2.42,glass);
    }
    obstacles.push({x,z,w:2.3,d:5,top:y+2.6});
  }
  // Low defensive walls flank, rather than cover, the central target lane.
  for(const side of [-1,1]) for(let i=0;i<10;i++) {
    const x=side*(4+i*.8),z=-range+3,y=terrainHeight(x,z);
    box(.77,.6,.55,x,y+.3,z,stone);
  }
  return { group, height: (x:number,z:number) => {
    let y=terrainHeight(x,z);
    for(const b of obstacles) if(Math.abs(x-b.x)<b.w/2 && Math.abs(z-b.z)<b.d/2) y=Math.max(y,b.top);
    return y;
  }};
}
