// --- SandustryMP deterministic simulation RNG ---
(() => {
  "use strict";
  const CLOCK_KEY = "sandustrymp.clock.v1";
  const nativeRandom = Math.random.bind(Math);
  let clock = null;
  let workerIndex = 0;
  let activeTick = -1;
  let rngState = 0;

  const mix32 = (value) => {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
  };

  self.addEventListener("message", (event) => {
    const data = event.data;
    if (!Array.isArray(data)) return;
    if (data[0] === 1 && data[4] && Number.isInteger(data[4].startingIndex)) {
      workerIndex = data[4].startingIndex >>> 0;
    } else if (data[0] === 58 && data[1] === CLOCK_KEY && data[2]) {
      clock = new Uint32Array(data[2]);
      activeTick = -1;
    }
  }, true);

  Math.random = () => {
    if (!clock) return nativeRandom();
    const tick = Atomics.load(clock, 0) >>> 0;
    if (tick !== activeTick) {
      activeTick = tick;
      const tickSeed = Atomics.load(clock, 1) >>> 0;
      rngState = mix32(tickSeed ^ Math.imul(workerIndex + 1, 0x9e3779b9));
      if (!rngState) rngState = 0x6d2b79f5;
    }
    let value = rngState;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    rngState = value >>> 0;
    return rngState / 0x100000000;
  };
})();
// --- /SandustryMP deterministic simulation RNG ---
