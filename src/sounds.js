// H2Whose? — procedural sound effects via Web Audio API.
// No mp3 files, no dependencies, no network loads — every sound is synthesised on the fly.

let ctx = null;

// Lazily create the AudioContext and keep resuming it.
// Browsers require the first creation/resume to happen inside a user gesture,
// which is always the case for us because sounds fire from click handlers.
const getCtx = () => {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    // Fire and forget — resume() returns a promise we don't need to await.
    ctx.resume().catch(() => {});
  }
  return ctx;
};

// A plain tone with an attack/decay envelope.
const playTone = (c, freq, { dur = 0.15, type = "sine", vol = 0.18, attack = 0.005 } = {}) => {
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
};

// UI click — soft, short.
export const click = () => {
  const c = getCtx();
  if (!c) return;
  playTone(c, 720, { dur: 0.06, type: "sine", vol: 0.07 });
};

// Spin tick — short, slightly random pitch so the spin sounds mechanical.
export const tick = () => {
  const c = getCtx();
  if (!c) return;
  const freq = 1100 + Math.random() * 300;
  playTone(c, freq, { dur: 0.035, type: "triangle", vol: 0.06 });
};

// Add-buddy pop — quick rising sweep.
export const addPop = () => {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(320, t0);
  osc.frequency.exponentialRampToValueAtTime(960, t0 + 0.1);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.14, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.16);
};

// Winner fanfare — C major triad followed by a rising flourish.
export const winFanfare = () => {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;

  // C5, E5, G5 stacked triangle waves.
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.09, t0 + 0.02 + i * 0.01);
    gain.gain.linearRampToValueAtTime(0.07, t0 + 0.28);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.55);
  });

  // Rising sparkle 280ms later.
  setTimeout(() => {
    const ctx2 = getCtx();
    if (!ctx2) return;
    const t1 = ctx2.currentTime;
    const osc = ctx2.createOscillator();
    const gain = ctx2.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(783.99, t1);
    osc.frequency.exponentialRampToValueAtTime(1567.98, t1 + 0.18);
    gain.gain.setValueAtTime(0, t1);
    gain.gain.linearRampToValueAtTime(0.1, t1 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.22);
    osc.connect(gain).connect(ctx2.destination);
    osc.start(t1);
    osc.stop(t1 + 0.28);
  }, 280);
};

// Water splash — filtered noise burst. Used when a new round starts.
export const splash = () => {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;

  // Build a short buffer of decaying white noise.
  const bufSize = Math.floor(c.sampleRate * 0.45);
  const buffer = c.createBuffer(1, bufSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufSize; i++) {
    const pct = i / bufSize;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - pct, 1.8);
  }

  const noise = c.createBufferSource();
  noise.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 2.2;
  filter.frequency.setValueAtTime(1000, t0);
  filter.frequency.exponentialRampToValueAtTime(180, t0 + 0.45);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.35, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);

  noise.connect(filter).connect(gain).connect(c.destination);
  noise.start(t0);
  noise.stop(t0 + 0.5);
};

// "Aww, you dodged it" descending tone. Used when resetting/clearing.
export const whoosh = () => {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, t0);
  osc.frequency.exponentialRampToValueAtTime(200, t0 + 0.22);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.1, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.28);
};
