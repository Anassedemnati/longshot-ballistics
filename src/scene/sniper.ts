import * as THREE from 'three';
import type { TargetDummy } from './target';
import type { HitZone } from '../game/hit';
import { terrainHeight } from './terrainHeight';

export function sniperPositions(range: number) {
  return [
    {name:'West rooftop',x:-19,y:terrainHeight(-19,-range-6)+6.125,z:-range-1.8},
    {name:'East rooftop',x:22,y:terrainHeight(22,-range-20)+9.125,z:-range-14.8},
    {name:'Valley overlook',x:65,y:terrainHeight(65,-range-55),z:-range-55},
  ];
}

export interface Sniper extends TargetDummy { scan(time:number, detected:boolean, covered:boolean, eye:THREE.Vector3):void; }

/** Prone mesh and hit spheres share local coordinates, then rotate toward the shooter. */
export function createSniper(site: ReturnType<typeof sniperPositions>[number], index:number): Sniper {
  const group=new THREE.Group();group.name=site.name;group.position.set(site.x,site.y,site.z);
  group.rotation.y=Math.atan2(-site.x,-site.z);
  const cloth=new THREE.MeshStandardMaterial({color:0x646449,roughness:.95});
  const vest=new THREE.MeshStandardMaterial({color:0x454b36,roughness:.9});
  const metal=new THREE.MeshStandardMaterial({color:0x313738,roughness:.4,metalness:.25});
  const zones:HitZone[]=[];
  function body(name:HitZone['name'],x:number,y:number,z:number,rx:number,ry:number,rz:number,mat:THREE.Material) {
    const mesh=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),mat);
    mesh.position.set(x,y,z);mesh.scale.set(rx,ry,rz);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);
    // A chain of spheres approximates each elongated prone body part.
    const radius=Math.min(rx,ry);
    for(let dz=-rz+radius;dz<=rz-radius+.001;dz+=radius) {
      const center=new THREE.Vector3(x,y,z+dz).applyEuler(group.rotation).add(group.position);
      zones.push({name,radius,center:{x:center.x,y:center.y,z:center.z}});
    }
  }
  body('upperTorso',0,.23,-.35,.23,.18,.35,vest);
  body('lowerTorso',0,.20,-.78,.19,.15,.2,cloth);
  for(const side of [-1,1]) {
    body('limbs',side*.14,.13,-1.24,.095,.1,.37,cloth);
    body('limbs',side*.25,.16,-.03,.075,.08,.29,cloth);
  }
  body('head',0,.37,.13,.12,.12,.12,new THREE.MeshStandardMaterial({color:0x9c8768,roughness:.9}));
  const helmet=new THREE.Mesh(new THREE.SphereGeometry(.14,20,12,0,Math.PI*2,0,Math.PI*.6),cloth);helmet.position.set(0,.42,.13);group.add(helmet);
  const rifle=new THREE.Group();rifle.position.set(.12,.24,.23);group.add(rifle);
  function tube(radius:number,length:number,y:number,z:number) {
    const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,16),metal);
    mesh.rotation.x=Math.PI/2;mesh.position.set(0,y,z);rifle.add(mesh);
  }
  tube(.025,.85,0,.1);tube(.035,.24,.16,.1);
  for(const side of [-1,1]) {const leg=new THREE.Mesh(new THREE.CylinderGeometry(.008,.008,.24,8),metal);leg.position.set(side*.07,-.1,.35);leg.rotation.z=side*.3;rifle.add(leg);}
  const size=64,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dx=(x-31.5)/32,dy=(y-31.5)/32,r=Math.hypot(dx,dy);
    const glow=Math.pow(Math.max(0,1-r),3);
    const cross=Math.exp(-Math.min(dx*dx,dy*dy)*650)*Math.pow(Math.max(0,1-r),2)*.45;
    const i=(y*size+x)*4;data[i]=255;data[i+1]=235;data[i+2]=180;data[i+3]=Math.min(255,(glow+cross)*255);
  }
  const texture=new THREE.DataTexture(data,size,size);texture.needsUpdate=true;texture.magFilter=THREE.LinearFilter;
  const material=new THREE.SpriteMaterial({map:texture,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:true,toneMapped:false});
  const glint=new THREE.Sprite(material);glint.position.set(0,.16,.3);rifle.add(glint);
  let down=false,fall=0;
  return {group,hitTarget:{id:`sniper-${index}`,zones},get down(){return down;},
    knockDown(){
      down=true;
      glint.visible=false;
      material.opacity=0;
      // Remove the optical cue from rendering for the entire defeated lifetime.
      glint.removeFromParent();
    },
    reset(){
      down=false;fall=0;group.rotation.z=0;
      glint.visible=false;material.opacity=0;
      rifle.add(glint); // Only an explicit respawn can restore the cue.
    },
    update(dt){if(down){fall=Math.min(1,fall+dt*3);group.rotation.z=fall*.25;}},
    scan(time,detected,covered,eye){
      if(down){glint.visible=false;return;}
      const sweep=Math.sin(time*.85+index*2.1);
      const lookingAtPlayer=detected || Math.abs(sweep)<.38;
      rifle.rotation.y=detected ? 0 : sweep*.3;
      glint.visible=lookingAtPlayer && !covered;
      material.opacity=detected ? .95 : Math.max(.15,1-Math.abs(sweep)/.38);
      // A readable optical cue at long range, still occluded by geometry.
      glint.scale.setScalar(Math.max(.8,eye.distanceTo(group.position)*.0035));
    },
  };
}
