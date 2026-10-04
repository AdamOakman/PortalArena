export const CFG = {
  G: 24, 
  R: 0.34, 
  H: 1.7,
  CROUCH_H: 1.0,
  GMAX: 12.0, 
  WALK: 6.0, 
  AIRCAP: 35,
  AACC: 12, 
  GACC: 80, 
  FR: 7.5, 
  SLOPE_FR: 1.2, // slope friction: gives downhill slides a terminal speed (G*sin/SLOPE_FR)
  JUMPV: 8.6,
  COYOTE: 0.09, 
  BUFFER: 0.11,
};
export const TICK_RATE = 128;
export const WARMUP_TIME = 60;  // seconds, max warmup before round starts
export const ROUND_TIME = 300;  // seconds, active duel length

export const PORT = { hw: 1.4375, hh: 2.0, recursion: 3 }; // mouth half-extents -> 2.88 x 4.0 m (original 23:32 ratio)
