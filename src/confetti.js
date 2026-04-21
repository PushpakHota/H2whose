// H2Whose? — lightweight canvas confetti. Self-contained, no dependencies.
// fireConfetti() creates a fullscreen canvas, animates particles, then removes itself.

export function fireConfetti() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;";
  document.body.appendChild(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Pulled from the app's palette so it feels part of the world, not pasted in.
  const colors = ["#F26E57", "#F5C04A", "#BEE3D4", "#1C5555", "#D65132", "#8DC7B1"];

  const particles = [];
  const originX = window.innerWidth / 2;
  const originY = window.innerHeight / 2.6;
  const count = 140;

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const speed = 6 + Math.random() * 12;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 6,
      g: 0.35 + Math.random() * 0.18,
      color: colors[i % colors.length],
      size: 6 + Math.random() * 8,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.35,
      life: 1,
      shape: Math.random() < 0.5 ? "rect" : "circle",
    });
  }

  let last = performance.now();
  let running = true;

  const frame = (now) => {
    if (!running) return;
    const dt = Math.min((now - last) / 16.67, 2);
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = 0;
    for (const p of particles) {
      p.vy += p.g * dt;
      p.vx *= 0.995;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= 0.007 * dt;

      if (p.life > 0 && p.y < window.innerHeight + 60) {
        alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 1.5);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    if (alive > 0) requestAnimationFrame(frame);
    else cleanup();
  };

  const cleanup = () => {
    running = false;
    canvas.remove();
  };

  requestAnimationFrame(frame);

  // Safety timer in case the tab is backgrounded.
  setTimeout(cleanup, 6000);
}
