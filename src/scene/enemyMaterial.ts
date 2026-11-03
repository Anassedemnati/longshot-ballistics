import * as THREE from 'three';
import { enemyTextures } from './enemyTextures';

// The one material of the enemy models: a MeshStandardMaterial (sun and sky light shape it like the rest of the
// scene) with the camo map and the cloth normal map, patched so each VERTEX picks what it needs from a `surface`
// attribute (x: camo share, y: roughness, z: metalness, w: normal-map strength). That is how a soldier's skin, gear,
// steel and camo cloth are one mesh and one draw call, with nothing to batch or sort.

/** Name of the per-vertex surface attribute: (camo, roughness, metalness, bump). */
export const SURFACE_ATTRIBUTE = 'surface';
/** Key of the patched program: every enemy shares it. */
const PROGRAM_KEY = 'enemy-surface-v1';

let material: THREE.MeshStandardMaterial | null = null;

/** The shared enemy material (built on first use; nothing changes it afterwards, so every enemy draws with it). */
export function enemyMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const { camo, clothNormal } = enemyTextures();
  const m = new THREE.MeshStandardMaterial({
    map: camo,
    normalMap: clothNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    vertexColors: true,
    roughness: 0.92, // the patch reads the roughness and metalness from the vertex; these are the cloth's, for the record
    metalness: 0,
  });
  m.name = 'enemy';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 ${SURFACE_ATTRIBUTE};\nvarying vec4 vSurface;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSurface = ${SURFACE_ATTRIBUTE};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vSurface;')
      // The camo texture multiplies the vertex colour only where the surface asks for it.
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          diffuseColor.rgb *= mix( vec3( 1.0 ), sampledDiffuseColor.rgb, vSurface.x );
        #endif`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.z;')
      // The cloth weave shows on cloth and fades out on skin and steel.
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize( mix( nonPerturbedNormal, normal, vSurface.w ) );`,
      );
  };
  m.customProgramCacheKey = () => PROGRAM_KEY;
  material = m;
  return m;
}
