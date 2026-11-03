import type { Rifle, RifleId } from './types';

// The rifles by calibre, each with the load a military sniper would carry. Where a maker publishes a G7 BC it is used as is; where
// only a G1 figure or nothing is published the G7 is an estimate, and says so. The first two are the original pair and their ballistics must not
// change (tests/ballistics/validation.test.ts checks them against js-ballistics). The game fields (mass, action, timings, recoil) are the
// player-facing side: the heavier the rifle, the slower the bolt, the longer the reload and the harder the kick.
export const RIFLES: Record<RifleId, Rifle> = {
  '308': {
    id: '308',
    name: '.308 Win',
    bcG7: 0.243,
    muzzleVelocity: 790,
    sightHeight: 0.04,
    zeroRange: 100,
    magazine: 5,
    bulletMassG: 11.34, // 175 gr
    action: 'bolt',
    boltTimeS: 1.2,
    reloadTimeS: 1.5,
    recoil: 1,
    integralSuppressor: false,
    antiMateriel: false,
    maxRangeM: 1500,
  },
  '338': {
    id: '338',
    name: '.338 Lapua Magnum',
    bcG7: 0.322,
    muzzleVelocity: 900,
    sightHeight: 0.04,
    zeroRange: 100,
    magazine: 5,
    bulletMassG: 16.2, // 250 gr
    action: 'bolt',
    boltTimeS: 1.3, // a longer action and a heavier bolt throw than the .308's
    reloadTimeS: 1.6,
    recoil: 1.35,
    integralSuppressor: false,
    antiMateriel: false,
    maxRangeM: 1500,
  },
  // MK 248 MOD 1: the 220 gr Sierra MatchKing at a nominal 869 m/s (2,850 ft/s). G7 0.31 is close to the published 0.319 of a
  // 220 gr match bullet of the same shape (Barnes); Sierra publishes no G7 for it.
  '300': {
    id: '300',
    name: '.300 Win Mag',
    bcG7: 0.31,
    muzzleVelocity: 869,
    sightHeight: 0.045,
    zeroRange: 100,
    magazine: 5,
    bulletMassG: 14.26, // 220 gr
    action: 'bolt',
    boltTimeS: 1.25,
    reloadTimeS: 1.6,
    recoil: 1.25,
    integralSuppressor: false,
    antiMateriel: false,
    maxRangeM: 1500,
  },
  // 419 gr solid at 2,850 ft/s (CheyTac's listing). Only a G1 BC is published (0.949); G7 0.47 is an estimate from it (a long,
  // low-drag solid's G7 runs at about half its G1).
  '408': {
    id: '408',
    name: '.408 CheyTac',
    bcG7: 0.47,
    muzzleVelocity: 869,
    sightHeight: 0.05,
    zeroRange: 100,
    magazine: 7,
    bulletMassG: 27.15, // 419 gr
    action: 'bolt',
    boltTimeS: 1.45, // a long, heavy bolt
    reloadTimeS: 1.9,
    recoil: 1.8,
    integralSuppressor: false,
    antiMateriel: true,
    maxRangeM: 1500,
  },
  // Hornady's 750 gr A-MAX match load: 2,820 ft/s, G7 0.51-0.524 depending on the listing. A heavy semi-automatic anti-materiel rifle.
  '50': {
    id: '50',
    name: '.50 BMG',
    bcG7: 0.51,
    muzzleVelocity: 860,
    sightHeight: 0.06,
    zeroRange: 100,
    magazine: 10,
    bulletMassG: 48.6, // 750 gr
    action: 'semi',
    boltTimeS: 0.35, // the recoiling action cycles itself: only the time to bring the sight back on
    reloadTimeS: 2.4, // a 10-round box of 12 cm cartridges
    recoil: 2.6,
    integralSuppressor: false,
    antiMateriel: true,
    maxRangeM: 1500,
  },
  // 7N34 sniper load: a 59 g steel-tipped bullet at 770-800 m/s. No BC is published; G7 0.42 is an estimate for a heavy boat-tail
  // of that weight.
  '127': {
    id: '127',
    name: '12.7x108 mm',
    bcG7: 0.42,
    muzzleVelocity: 785,
    sightHeight: 0.06,
    zeroRange: 100,
    magazine: 5,
    bulletMassG: 59,
    action: 'bolt',
    boltTimeS: 1.55, // the heaviest bolt throw of the lot
    reloadTimeS: 2.3,
    recoil: 2.5,
    integralSuppressor: false,
    antiMateriel: true,
    maxRangeM: 1500,
  },
  // STs-130 subsonic: a 59 g bullet at 295 m/s, below the speed of sound, so it never cracks: with a suppressor it is all but silent.
  // No BC is published; G7 0.3 is an estimate. The drop is huge (over a metre at 200 m): a close-range rifle.
  '127s': {
    id: '127s',
    name: '12.7x55 mm subsonic',
    bcG7: 0.3,
    muzzleVelocity: 295,
    sightHeight: 0.05,
    zeroRange: 100,
    magazine: 5,
    bulletMassG: 59,
    action: 'bolt',
    boltTimeS: 1.4,
    reloadTimeS: 2,
    recoil: 1.7, // a 59 g bullet, but slow, and the can soaks up part of the kick
    integralSuppressor: true,
    antiMateriel: false, // heavy but slow: it does not hold its speed through a vehicle's skin
    // 250 m keeps the farthest target inside the mil reticle's 10-mil hash ladder: the hold there is 8.7-8.9 mil in all three
    // themes (10.2-10.5 mil at 275 m, off the ladder). See tests/ballistics/rifles.test.ts.
    maxRangeM: 250,
  },
};
