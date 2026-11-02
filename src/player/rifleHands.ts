import * as THREE from 'three';
import type { MaterialKey, PartSet, PartStyle } from './rifleParts';

// The shooter's gloved hands and sleeves, sculpted from capsules and ellipsoids (camo-tan cloth, rubber cuffs):
// the right hand round the pistol grip with the index finger on the trigger, the left hand cradling the fore-end.
// Everything is in the rifle model's space (camera looks down -z, +x right) and baked into the glove/rubber meshes.

/** The pistol grip's frame in model space: its centre and its lean (the grip box is turned about x). */
const GRIP_CENTER = new THREE.Vector3(0, -0.12, 0.02);
const GRIP_LEAN_RAD = -0.25;

/** The sleeve tint over the glove's camo cloth: darker, greyer. */
const SLEEVE: PartStyle = { color: 0xb4ae98 };
const GLOVE: PartStyle = {};

interface Segment {
  /** Joint-to-joint length, m. */
  length: number;
  /** Radius of the capsule, m. */
  radius: number;
  /** Turn about the chain's bend axis at the start of this segment, rad. */
  bend: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const UNIT = new THREE.Vector3(1, 1, 1);

/**
 * A jointed digit: capsules laid end to end from `start` along `direction`, each turned `bend` about `axis` from the
 * one before it (a curl is a run of same-signed bends). A glove finger or thumb.
 */
function digit(
  parts: PartSet,
  start: THREE.Vector3,
  direction: THREE.Vector3,
  axis: THREE.Vector3,
  segments: readonly Segment[],
  style: PartStyle = GLOVE,
): void {
  const at = start.clone();
  const heading = direction.clone().normalize();
  const rotation = new THREE.Quaternion();
  const centre = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  for (const segment of segments) {
    heading.applyAxisAngle(axis, segment.bend);
    centre.copy(at).addScaledVector(heading, segment.length / 2);
    rotation.setFromUnitVectors(UP, heading);
    matrix.compose(centre, rotation, UNIT);
    parts.place('glove', new THREE.CapsuleGeometry(segment.radius, segment.length, 3, 10), matrix, style);
    at.addScaledVector(heading, segment.length);
  }
}

/** A tapered tube from `from` (radius `rFrom`) to `to` (`rTo`): a cuff or a sleeve. */
function sleeve(parts: PartSet, material: MaterialKey, from: THREE.Vector3, to: THREE.Vector3, rFrom: number, rTo: number, style: PartStyle): void {
  const heading = to.clone().sub(from);
  const length = heading.length();
  const rotation = new THREE.Quaternion().setFromUnitVectors(UP, heading.normalize());
  const matrix = new THREE.Matrix4().compose(from.clone().add(to).multiplyScalar(0.5), rotation, UNIT);
  // The cylinder's +y end carries `radiusTop`: that is the `to` end.
  parts.place(material, new THREE.CylinderGeometry(rTo, rFrom, length, 24, 1), matrix, style);
}

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

/** The right hand on the pistol grip, built in the grip's own frame, and its sleeve. */
function rightHand(parts: PartSet): void {
  const frame = new THREE.Matrix4().compose(GRIP_CENTER, new THREE.Quaternion().setFromEuler(new THREE.Euler(GRIP_LEAN_RAD, 0, 0)), UNIT);
  parts.setFrame(frame);

  // Palm: the heel on the back strap, the pad up the right side, the web over the top of the grip, the back of the hand.
  parts.ellipsoid('glove', 0.04, 0.038, 0.024, 0.006, -0.012, 0.062);
  parts.ellipsoid('glove', 0.026, 0.032, 0.022, -0.012, 0.034, 0.064); // the thumb's base on the left of the back strap
  parts.ellipsoid('glove', 0.02, 0.05, 0.04, 0.048, 0.022, 0.03);
  parts.ellipsoid('glove', 0.03, 0.02, 0.022, 0.014, 0.06, 0.058);
  parts.ellipsoid('glove', 0.014, 0.05, 0.044, 0.062, 0.028, 0.026);

  // Index finger out along the trigger guard onto the trigger; the other three wrap the front of the grip.
  const left = v(0, 1, 0);
  digit(parts, v(0.05, 0.068, 0.012), v(-0.45, 0, -0.9), left, [
    { length: 0.038, radius: 0.0105, bend: 0 },
    { length: 0.026, radius: 0.0095, bend: 0.18 },
    { length: 0.02, radius: 0.0085, bend: 0.2 },
  ]);
  const wraps = [
    { y: 0.04, scale: 1 },
    { y: 0.0185, scale: 0.96 },
    { y: -0.0035, scale: 0.84 },
  ];
  for (const { y, scale } of wraps) {
    digit(parts, v(0.0465, y, 0.02), v(0, 0, -1), left, [
      { length: 0.07 * scale, radius: 0.0105 * scale, bend: 0 },
      { length: 0.044 * scale, radius: 0.0095 * scale, bend: 1.5 },
      { length: 0.032 * scale, radius: 0.0085 * scale, bend: 0.12 },
    ]);
  }
  for (const y of [0.068, 0.04, 0.0185, -0.0035]) parts.ellipsoid('rubber', 0.006, 0.01, 0.011, 0.0715, y, 0.015); // knuckle guards
  // Thumb across the back of the grip and forward along its left side.
  digit(parts, v(0.012, 0.052, 0.064), v(-0.85, 0.1, -0.5), left, [
    { length: 0.046, radius: 0.0138, bend: 0 },
    { length: 0.04, radius: 0.0122, bend: 0.5 },
  ]);
  parts.setFrame(null);

  // Wrist cuff and the sleeve running back, to the right and down, out of the picture.
  const wrist = v(0.06, -0.109, 0.105);
  const cuffEnd = v(0.095, -0.138, 0.172);
  const elbow = v(0.3, -0.33, 0.62);
  sleeve(parts, 'glove', wrist, cuffEnd, 0.03, 0.036, GLOVE);
  parts.place('rubber', new THREE.TorusGeometry(0.0375, 0.0045, 8, 24), ringMatrix(cuffEnd, cuffEnd.clone().sub(wrist)));
  sleeve(parts, 'glove', cuffEnd, elbow, 0.05, 0.07, SLEEVE);
}

/** A matrix that puts a torus (lying in xy, axis z) round `axis` at `at`. */
function ringMatrix(at: THREE.Vector3, axis: THREE.Vector3): THREE.Matrix4 {
  const rotation = new THREE.Quaternion().setFromUnitVectors(v(0, 0, 1), axis.clone().normalize());
  return new THREE.Matrix4().compose(at, rotation, UNIT);
}

/** The left hand cupping the underside of the fore-end, thumb along its left side, and its sleeve. */
function leftHand(parts: PartSet): void {
  parts.ellipsoid('glove', 0.04, 0.017, 0.052, 0, -0.06, -0.335);
  parts.ellipsoid('glove', 0.016, 0.02, 0.034, -0.036, -0.058, -0.3);
  parts.ellipsoid('rubber', 0.026, 0.006, 0.03, -0.004, -0.076, -0.335); // palm pad

  // Four fingers across under the fore-end and up its right side.
  const curl = v(0, 0, 1);
  const zs = [-0.296, -0.318, -0.34, -0.362];
  zs.forEach((z, i) => {
    const s = i === 3 ? 0.86 : 1;
    digit(parts, v(0.012, -0.054, z), v(1, 0, 0), curl, [
      { length: 0.032 * s, radius: 0.0105 * s, bend: 0 },
      { length: 0.03 * s, radius: 0.0095 * s, bend: 1.5 },
      { length: 0.022 * s, radius: 0.0085 * s, bend: 0.3 },
    ]);
  });
  // Thumb forward along the left side.
  digit(parts, v(-0.047, -0.054, -0.285), v(0, 0.25, -1), v(1, 0, 0), [
    { length: 0.04, radius: 0.0118, bend: 0 },
    { length: 0.03, radius: 0.0105, bend: -0.1 },
  ]);

  // The forearm drops away under the fore-end, back towards the shooter's body: from the game camera it is a short
  // foreshortened cuff that leaves the picture at the bottom, not a long diagonal sleeve across the lower left.
  const wrist = v(-0.012, -0.068, -0.262);
  const away = v(0.0, -0.6, 0.8).normalize();
  const cuffEnd = wrist.clone().addScaledVector(away, 0.075);
  const elbow = wrist.clone().addScaledVector(away, 0.3);
  sleeve(parts, 'glove', wrist, cuffEnd, 0.029, 0.035, GLOVE);
  parts.place('rubber', new THREE.TorusGeometry(0.0365, 0.0045, 8, 24), ringMatrix(cuffEnd, cuffEnd.clone().sub(wrist)));
  sleeve(parts, 'glove', cuffEnd, elbow, 0.049, 0.069, SLEEVE);
}

/** Add both gloved hands and their sleeves to `parts` (the glove and rubber meshes of the rifle). */
export function addHands(parts: PartSet): void {
  rightHand(parts);
  leftHand(parts);
}
