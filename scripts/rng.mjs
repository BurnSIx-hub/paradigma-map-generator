/** Seeded RNG (mulberry32) so the same seed always produces the same map. */

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = String(seed);
    let a = hashString(this.seed);
    this._next = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** float [0, 1) */
  random() { return this._next(); }

  /** float [min, max) */
  float(min, max) { return min + (max - min) * this._next(); }

  /** int [min, max] inclusive */
  int(min, max) { return Math.floor(this.float(min, max + 1)); }

  /** true with probability p */
  chance(p) { return this._next() < p; }

  /** random element of array (or null) */
  pick(array) {
    if (!Array.isArray(array) || !array.length) return null;
    return array[Math.floor(this._next() * array.length)];
  }

  /** Fisher-Yates shuffle in place (seeded), returns the same array */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      const tmp = array[i]; array[i] = array[j]; array[j] = tmp;
    }
    return array;
  }

  /** rough bell-curve float around mid */
  gauss(min, max) {
    const t = (this._next() + this._next() + this._next()) / 3;
    return min + (max - min) * t;
  }
}

export function makeSeed() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
