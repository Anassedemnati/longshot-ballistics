import * as THREE from 'three';
import { terrainHeight } from './terrainHeight';

/** Repeating linear-data height map: fine grains and wind-shaped ripples. */
export function sandRelief(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  let seed = 33;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    const phase = y / size * Math.PI * 24 + Math.sin(x / size * Math.PI * 4) * .8;
    const height = 128 + Math.sin(phase) * 28 + (seed / 4294967296 - .5) * 40;
    const i = (y * size + x)*4;
    data[i] = data[i+1] = data[i+2] = height; data[i+3] = 255;
  }
  const texture = new THREE.DataTexture(data,size,size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Instanced ground debris away from the clear target lane. */
export function createGroundDetail(): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,1),
    new THREE.MeshStandardMaterial({color:0x8b7963,roughness:.96}), 900);
  let seed = 42;
  const random = () => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed/4294967296; };
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  for(let i=0;i<900;i++) {
    const x = (random() < .5 ? -1 : 1) * (4 + random()*180);
    const z = 45-random()*650;
    const size = .06+Math.pow(random(),3)*.6;
    transform.position.set(x,terrainHeight(x,z)+size*.12,z);
    transform.scale.set(size*1.5,size*.5,size);
    transform.rotation.set(random(),random()*6.28,random());
    transform.updateMatrix(); mesh.setMatrixAt(i,transform.matrix);
    color.setHSL(.09+random()*.025,.13+random()*.16,.28+random()*.18);
    mesh.setColorAt(i,color);
  }
  mesh.receiveShadow = true; mesh.castShadow = true;
  mesh.computeBoundingSphere(); group.add(mesh);
  return group;
}
