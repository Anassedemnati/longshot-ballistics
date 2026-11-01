import type { Rifle } from './types';

export const RIFLES: Record<'308' | '338', Rifle> = {
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
};
