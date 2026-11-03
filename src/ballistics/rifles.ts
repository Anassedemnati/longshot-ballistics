import type { Rifle, RifleId } from './types';

// The rifles by calibre, each with the load a military sniper would carry. Where a maker publishes a G7 BC it is used as is; where
// only a G1 figure or nothing is published the G7 is an estimate, and says so. The first two are the original pair and must not change
// (tests/ballistics/validation.test.ts checks them against js-ballistics).
export const RIFLES: Record<RifleId, Rifle> = {
  '308': {
    id: '308',
    name: '.308 Win',
    bcG7: 0.243,
    muzzleVelocity: 790,
    sightHeight: 0.04,
    zeroRange: 100,
    magazine: 5,
  },
  '338': {
    id: '338',
    name: '.338 Lapua Magnum',
    bcG7: 0.322,
    muzzleVelocity: 900,
    sightHeight: 0.04,
    zeroRange: 100,
    magazine: 5,
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
  },
};
