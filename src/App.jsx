import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Plus,
  RotateCcw,
  X,
  ChevronDown,
  Eraser,
  Volume2,
  VolumeX,
} from "lucide-react";
import * as sfx from "./sounds.js";
import { fireConfetti } from "./confetti.js";

// ─── Room handling (via URL hash, e.g. #finance, #team-a) ─────────
const getRoom = () => {
  if (typeof window === "undefined") return "default";
  const h = window.location.hash
    .replace("#", "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
  return h || "default";
};

// ─── localStorage fallback (per-room, with migration from old keys) ──
const lsKey = (room) => `h2w:state:${room}`;
const emptyState = () => ({
  names: [],
  currentRound: [],
  history: [],
  roundNumber: 1,
  updatedAt: 0,
});

const lsRead = (room) => {
  try {
    const raw = localStorage.getItem(lsKey(room));
    if (raw) return JSON.parse(raw);
    // Migrate legacy un-roomed keys → default room.
    if (room === "default") {
      const names = JSON.parse(localStorage.getItem("h2w:names") || "null");
      const currentRound = JSON.parse(localStorage.getItem("h2w:round") || "null");
      const history = JSON.parse(localStorage.getItem("h2w:log") || "null");
      const roundNumber = JSON.parse(localStorage.getItem("h2w:roundnum") || "null");
      if (names || currentRound || history || roundNumber) {
        return {
          names: names || [],
          currentRound: currentRound || [],
          history: history || [],
          roundNumber: roundNumber || 1,
          updatedAt: 0,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
};

const lsWrite = (room, state) => {
  try {
    localStorage.setItem(lsKey(room), JSON.stringify(state));
  } catch {}
};

const MUTE_KEY = "h2w:muted";

export default function App() {
  const room = useMemo(getRoom, []);
  const apiUrl = `/api/state?room=${encodeURIComponent(room)}`;

  // ─── Shared state (mirrored to Redis + localStorage) ──────────
  const [names, setNames] = useState([]);
  const [currentRound, setCurrentRound] = useState([]);
  const [history, setHistory] = useState([]);
  const [roundNumber, setRoundNumber] = useState(1);
  const [updatedAt, setUpdatedAt] = useState(0);

  // ─── UI-only state ────────────────────────────────────────────
  const [newName, setNewName] = useState("");
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinDisplay, setSpinDisplay] = useState("");
  const [pickedName, setPickedName] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [justCompletedRound, setJustCompletedRound] = useState(false);
  const [revealKey, setRevealKey] = useState(0);
  const [confirmClearLog, setConfirmClearLog] = useState(false);
  const [syncStatus, setSyncStatus] = useState("loading"); // loading | online | offline
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const spinTimeoutRef = useRef(null);
  const updatedAtRef = useRef(0);

  // Keep a ref in sync so the polling loop sees the latest updatedAt
  // without re-creating its interval on every change.
  useEffect(() => {
    updatedAtRef.current = updatedAt;
  }, [updatedAt]);

  // ─── Sound wrapper respects the mute toggle ────────────────────
  const play = useCallback(
    (fn) => {
      if (muted) return;
      try {
        fn();
      } catch {}
    },
    [muted]
  );

  // ─── Apply a state snapshot to React state ─────────────────────
  const applyState = useCallback((s) => {
    if (!s) return;
    setNames(s.names || []);
    setCurrentRound(s.currentRound || []);
    setHistory(s.history || []);
    setRoundNumber(s.roundNumber || 1);
    setUpdatedAt(s.updatedAt || 0);
  }, []);

  // ─── Persist: save locally first (instant), then push to server ─
  const persist = useCallback(
    async (partial) => {
      const next = {
        names: partial.names ?? names,
        currentRound: partial.currentRound ?? currentRound,
        history: partial.history ?? history,
        roundNumber: partial.roundNumber ?? roundNumber,
        updatedAt: Date.now(),
      };
      setUpdatedAt(next.updatedAt);
      lsWrite(room, next);

      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        setSyncStatus(res.ok ? "online" : "offline");
      } catch {
        setSyncStatus("offline");
      }
    },
    [apiUrl, room, names, currentRound, history, roundNumber]
  );

  // ─── Initial hydration: merge local + remote, preferring newer ─
  useEffect(() => {
    let mounted = true;
    (async () => {
      const local = lsRead(room);
      try {
        const res = await fetch(apiUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const server = await res.json();
        if (!mounted) return;
        setSyncStatus("online");

        const localNewer =
          local &&
          (local.updatedAt || 0) > (server.updatedAt || 0) &&
          (local.names?.length || local.history?.length);

        if (localNewer) {
          // Push local-only changes up.
          applyState(local);
          fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(local),
          }).catch(() => {});
        } else {
          applyState(server);
          lsWrite(room, server);
        }
      } catch {
        if (!mounted) return;
        setSyncStatus("offline");
        if (local) applyState(local);
      }
      if (mounted) setLoading(false);
    })();

    return () => {
      mounted = false;
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // ─── Polling: pull fresh state every 5s (paused while spinning / hidden) ──
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (isSpinning) return;
      try {
        const res = await fetch(apiUrl, { cache: "no-store" });
        if (!res.ok) {
          setSyncStatus("offline");
          return;
        }
        const data = await res.json();
        setSyncStatus("online");
        if (data && (data.updatedAt || 0) > updatedAtRef.current) {
          applyState(data);
          lsWrite(room, data);
        }
      } catch {
        setSyncStatus("offline");
      }
    };
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [apiUrl, isSpinning, room, applyState]);

  // ─── Mutations ─────────────────────────────────────────────────
  const addName = () => {
    if (isSpinning) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (names.some((n) => n.name.toLowerCase() === trimmed.toLowerCase())) {
      setNewName("");
      return;
    }
    const nextNames = [
      ...names,
      {
        id:
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        active: true,
      },
    ];
    setNames(nextNames);
    setNewName("");
    play(sfx.addPop);
    persist({ names: nextNames });
  };

  const removeName = (id) => {
    if (isSpinning) return;
    const nextNames = names.filter((n) => n.id !== id);
    const nextRound = currentRound.includes(id)
      ? currentRound.filter((r) => r !== id)
      : currentRound;
    setNames(nextNames);
    setCurrentRound(nextRound);
    play(sfx.click);
    persist({ names: nextNames, currentRound: nextRound });
  };

  const toggleActive = (id) => {
    if (isSpinning) return;
    const nextNames = names.map((n) =>
      n.id === id ? { ...n, active: !n.active } : n
    );
    setNames(nextNames);
    play(sfx.click);
    persist({ names: nextNames });
  };

  const activeNames = names.filter((n) => n.active);
  const filledInRound = activeNames.filter((n) => currentRound.includes(n.id));
  const canPick = activeNames.length > 0 && !isSpinning;

  // ─── The main event: decelerating roulette spin ────────────────
  const pick = () => {
    if (!canPick) return;

    let eligible = activeNames.filter((n) => !currentRound.includes(n.id));
    let roundState = currentRound;
    let roundNum = roundNumber;
    let startedNewRound = false;

    if (eligible.length === 0) {
      eligible = activeNames;
      roundState = [];
      roundNum = roundNumber + 1;
      startedNewRound = true;
    }

    const winner = eligible[Math.floor(Math.random() * eligible.length)];

    setIsSpinning(true);
    setPickedName(null);
    setJustCompletedRound(false);

    if (startedNewRound) play(sfx.splash);

    const totalTicks = 28;
    const startDelay = 45;
    const endDelay = 340;
    const pool = activeNames.length > 1 ? activeNames : [winner];
    let t = 0;

    const doTick = () => {
      if (t < totalTicks) {
        const shown = pool[Math.floor(Math.random() * pool.length)];
        setSpinDisplay(shown.name);
        play(sfx.tick);
        t += 1;
        // Ease-out cubic — slows dramatically near the end.
        const pct = t / totalTicks;
        const delay = startDelay + (endDelay - startDelay) * Math.pow(pct, 2.2);
        spinTimeoutRef.current = setTimeout(doTick, delay);
        return;
      }

      // ── Finale ──
      setSpinDisplay(winner.name);
      setPickedName(winner);
      setIsSpinning(false);
      setRevealKey((k) => k + 1);
      play(sfx.winFanfare);
      fireConfetti();

      const nextRound = [...roundState, winner.id];
      setCurrentRound(nextRound);
      if (startedNewRound) setRoundNumber(roundNum);

      const entry = {
        name: winner.name,
        timestamp: new Date().toISOString(),
        round: roundNum,
      };
      const nextLog = [entry, ...history].slice(0, 300);
      setHistory(nextLog);

      if (nextRound.length >= activeNames.length) {
        setJustCompletedRound(true);
      }

      persist({
        currentRound: nextRound,
        history: nextLog,
        roundNumber: roundNum,
      });
    };

    spinTimeoutRef.current = setTimeout(doTick, 80);
  };

  const resetRound = () => {
    if (isSpinning) return;
    const next = roundNumber + 1;
    setCurrentRound([]);
    setRoundNumber(next);
    setPickedName(null);
    setJustCompletedRound(false);
    setSpinDisplay("");
    play(sfx.whoosh);
    persist({ currentRound: [], roundNumber: next });
  };

  const clearLog = () => {
    setHistory([]);
    setConfirmClearLog(false);
    play(sfx.whoosh);
    persist({ history: [] });
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? "1" : "0");
    } catch {}
    if (!next) {
      // Confirm with a click when un-muting.
      setTimeout(() => {
        try {
          sfx.click();
        } catch {}
      }, 0);
    }
  };

  const formatTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // ─── Hall of Hydration: top 3 fillers by count (all-time in log) ──
  const topFillers = useMemo(() => {
    const counts = {};
    history.forEach((h) => {
      counts[h.name] = (counts[h.name] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [history]);

  // ─── Back-to-back: same name as the next (older) log entry? ──
  const isBackToBack = (i) =>
    i < history.length - 1 && history[i].name === history[i + 1].name;

  const bubbles = Array.from({ length: 14 }, (_, i) => {
    const seed = i * 37.7;
    return {
      size: 20 + ((seed * 3) % 60),
      left: (seed * 7.3) % 100,
      dur: 18 + ((seed * 1.7) % 22),
      delay: -((seed * 2.1) % 25),
      drift: ((seed * 4.4) % 80) - 40 + "px",
    };
  });

  const syncDotColor = {
    online: "var(--mint-deep)",
    offline: "var(--coral)",
    loading: "var(--sun)",
  }[syncStatus];
  const syncLabel = {
    online: "synced",
    offline: "offline",
    loading: "syncing…",
  }[syncStatus];

  return (
    <div className="app-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..900&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400..600&display=swap');

        :root {
          --cream: #F3EAD3;
          --cream-deep: #E8DBB9;
          --ink: #0E2A2A;
          --ocean: #1C5555;
          --ocean-deep: #0D3B3B;
          --coral: #F26E57;
          --coral-deep: #D65132;
          --sun: #F5C04A;
          --mint: #BEE3D4;
          --mint-deep: #8DC7B1;
          --foam: #FEFBF2;
        }

        * { box-sizing: border-box; }
        body { margin: 0; }

        .app-root {
          min-height: 100vh;
          background: var(--cream);
          background-image:
            radial-gradient(circle at 12% 18%, rgba(28,85,85,0.06) 0%, transparent 45%),
            radial-gradient(circle at 88% 82%, rgba(242,110,87,0.05) 0%, transparent 45%);
          color: var(--ink);
          font-family: 'Geist', system-ui, sans-serif;
          position: relative;
          overflow: hidden;
          padding: 32px 20px 80px;
        }

        .bubbles { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 0; }
        .bubble {
          position: absolute;
          bottom: -80px;
          border-radius: 50%;
          background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.85), rgba(190,227,212,0.25) 70%);
          border: 1px solid rgba(28,85,85,0.08);
          animation: rise linear infinite;
        }
        @keyframes rise {
          0%   { transform: translate(0,0); opacity: 0; }
          10%  { opacity: 0.55; }
          85%  { opacity: 0.35; }
          100% { transform: translate(var(--drift), -110vh); opacity: 0; }
        }

        .shell { position: relative; z-index: 1; max-width: 1060px; margin: 0 auto; }

        .masthead {
          display: flex; align-items: center; justify-content: space-between;
          gap: 16px; margin-bottom: 32px; flex-wrap: wrap;
        }
        .wordmark {
          display: flex; align-items: center; gap: 14px;
          font-family: 'Fraunces', serif;
          font-size: clamp(28px, 4.5vw, 40px); font-weight: 700;
          font-variation-settings: 'SOFT' 100, 'opsz' 144;
          letter-spacing: -0.035em; color: var(--ocean-deep); line-height: 1;
        }
        .wordmark em { font-style: italic; color: var(--coral); font-weight: 500; }
        .wordmark .drop-wrap { animation: bob 3.5s ease-in-out infinite; }
        @keyframes bob {
          0%, 100% { transform: translateY(0) rotate(0); }
          50% { transform: translateY(-4px) rotate(-3deg); }
        }
        .subtitle-row {
          display: flex; align-items: center; gap: 10px; margin: 4px 0 0 54px;
          flex-wrap: wrap;
        }
        .subtitle {
          font-family: 'Fraunces', serif; font-style: italic; font-weight: 400;
          font-size: 14px; color: var(--ocean); margin: 0;
        }
        .room-tag {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em;
          background: var(--mint); color: var(--ocean-deep);
          padding: 3px 8px; border-radius: 5px;
          border: 1.5px solid var(--ocean-deep);
        }
        .room-tag::before { content: '#'; opacity: 0.55; margin-right: 1px; }

        .header-tools {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .sync-pill {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10.5px; font-weight: 600; color: var(--ocean);
          background: var(--foam); border: 1.5px solid var(--ocean);
          padding: 5px 9px; border-radius: 999px;
          letter-spacing: 0.05em;
        }
        .sync-dot {
          width: 7px; height: 7px; border-radius: 50%;
          box-shadow: 0 0 6px currentColor;
        }
        .sync-pill.loading .sync-dot { animation: pulse 1.2s ease infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        .mute-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 36px; height: 36px; background: var(--foam);
          border: 2px solid var(--ink); border-radius: 10px;
          box-shadow: 2px 2px 0 var(--ink); cursor: pointer;
          color: var(--ocean-deep);
          transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .mute-btn:hover {
          transform: translate(-1px, -1px);
          box-shadow: 3px 3px 0 var(--ink);
        }
        .mute-btn:active {
          transform: translate(1px, 1px);
          box-shadow: 1px 1px 0 var(--ink);
        }
        .mute-btn.muted { background: var(--cream-deep); color: var(--coral-deep); }

        .round-pill {
          background: var(--ink); color: var(--cream);
          padding: 9px 16px 9px 12px; border-radius: 999px;
          font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
          display: inline-flex; align-items: center; gap: 8px;
          box-shadow: 3px 3px 0 var(--ocean-deep);
        }
        .round-pill .dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--sun); box-shadow: 0 0 0 2px var(--ink);
        }

        .stage {
          background: var(--foam); border: 2.5px solid var(--ink);
          border-radius: 32px; padding: 44px 32px 36px;
          box-shadow: 8px 8px 0 var(--ink);
          position: relative; overflow: hidden;
        }
        .stage::before {
          content: ''; position: absolute; top: -40px; right: -40px;
          width: 160px; height: 160px; background: var(--mint);
          border-radius: 50%; opacity: 0.3;
        }
        .stage::after {
          content: ''; position: absolute; bottom: -30px; left: -30px;
          width: 110px; height: 110px; background: var(--sun);
          border-radius: 50%; opacity: 0.22;
        }
        .stage-inner { position: relative; z-index: 1; }

        .eyebrow {
          text-transform: uppercase; letter-spacing: 0.28em;
          font-size: 10.5px; color: var(--ocean); font-weight: 600;
          text-align: center; margin: 0 0 20px;
        }

        .reveal-box {
          min-height: 160px; display: flex; flex-direction: column;
          align-items: center; justify-content: center; text-align: center;
          padding: 8px 0 20px;
        }
        .picked-name {
          font-family: 'Fraunces', serif;
          font-size: clamp(44px, 8.5vw, 88px); font-weight: 600;
          font-variation-settings: 'SOFT' 100, 'opsz' 144;
          line-height: 0.95; letter-spacing: -0.04em;
          color: var(--ocean-deep); margin: 0; max-width: 100%;
          overflow-wrap: break-word;
        }
        .picked-name.spinning { color: var(--coral); animation: wobble 150ms ease infinite; }
        .picked-name.revealed { animation: popIn 720ms cubic-bezier(0.22, 1.8, 0.5, 1); }
        @keyframes popIn {
          0%   { transform: scale(0.55) rotate(-4deg); opacity: 0; }
          55%  { transform: scale(1.12) rotate(1.5deg); opacity: 1; }
          100% { transform: scale(1) rotate(0); opacity: 1; }
        }
        @keyframes wobble {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-5px); }
        }

        .picked-caption {
          margin-top: 18px; font-size: 14px; color: var(--ocean);
          font-family: 'Fraunces', serif; font-style: italic;
        }
        .picked-caption strong {
          color: var(--coral-deep); font-style: normal; font-weight: 600;
        }

        .empty-prompt {
          font-family: 'Fraunces', serif; font-style: italic;
          font-size: clamp(28px, 4.5vw, 40px);
          color: var(--ocean); opacity: 0.6; font-weight: 400;
        }

        .round-banner {
          margin-top: 14px; background: var(--sun); color: var(--ink);
          padding: 8px 16px; border: 2px solid var(--ink); border-radius: 999px;
          font-family: 'Fraunces', serif; font-weight: 600; font-size: 14px;
          display: inline-flex; align-items: center; gap: 8px;
          animation: popIn 500ms cubic-bezier(0.22, 1.8, 0.5, 1);
        }

        .pick-btn {
          margin: 26px auto 0; display: flex; align-items: center; justify-content: center;
          gap: 14px; width: 100%; max-width: 440px;
          background: var(--coral); color: var(--foam);
          border: 2.5px solid var(--ink); border-radius: 20px;
          padding: 22px 28px;
          font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700;
          font-variation-settings: 'SOFT' 100; letter-spacing: -0.01em;
          cursor: pointer; box-shadow: 6px 6px 0 var(--ink);
          transition: transform 120ms ease, box-shadow 120ms ease, background 120ms;
        }
        .pick-btn:hover:not(:disabled) {
          transform: translate(-2px, -2px);
          box-shadow: 8px 8px 0 var(--ink); background: #F47E68;
        }
        .pick-btn:active:not(:disabled) {
          transform: translate(4px, 4px); box-shadow: 2px 2px 0 var(--ink);
        }
        .pick-btn:disabled {
          opacity: 0.45; cursor: not-allowed;
          background: var(--cream-deep); color: var(--ocean);
        }
        .pick-btn.spinning {
          background: var(--sun); color: var(--ink);
          animation: jiggle 400ms ease infinite;
        }
        @keyframes jiggle {
          0%, 100% { transform: rotate(0); }
          25% { transform: rotate(-0.8deg); }
          75% { transform: rotate(0.8deg); }
        }

        .progress-wrap { margin-top: 28px; }
        .progress-caption {
          text-align: center; font-size: 12px; color: var(--ocean);
          font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase;
          margin-bottom: 10px;
        }
        .progress-caption strong { color: var(--ocean-deep); font-weight: 700; }
        .droplet-row {
          display: flex; gap: 7px; flex-wrap: wrap; justify-content: center;
          max-width: 520px; margin: 0 auto;
        }
        .droplet-svg {
          width: 20px; height: 24px;
          transition: transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .droplet-svg .drop-fill { transition: fill 320ms ease; }
        .droplet-svg.filled { transform: scale(1.08); }

        .section { margin-top: 48px; }
        .section-head {
          display: flex; align-items: baseline; justify-content: space-between;
          gap: 12px; margin-bottom: 18px; flex-wrap: wrap;
        }
        .section-title {
          font-family: 'Fraunces', serif; font-size: 28px; font-weight: 600;
          font-variation-settings: 'SOFT' 100, 'opsz' 144;
          letter-spacing: -0.02em; color: var(--ocean-deep); margin: 0;
          display: flex; align-items: baseline; gap: 12px;
        }
        .section-title .title-mark {
          font-family: 'Fraunces', serif; font-style: italic;
          font-weight: 400; color: var(--coral);
        }
        .section-sub {
          font-size: 12px; color: var(--ocean);
          letter-spacing: 0.15em; text-transform: uppercase; font-weight: 500;
        }

        .add-row { display: flex; gap: 10px; margin-bottom: 18px; }
        .name-input {
          flex: 1; padding: 15px 18px;
          border: 2.5px solid var(--ink); border-radius: 14px;
          background: var(--foam); font-family: 'Geist', sans-serif;
          font-size: 15px; color: var(--ink); outline: none;
          box-shadow: 3px 3px 0 var(--ink);
          transition: transform 120ms ease, box-shadow 120ms ease;
          min-width: 0;
        }
        .name-input::placeholder {
          color: var(--ocean); opacity: 0.55; font-style: italic;
        }
        .name-input:focus {
          transform: translate(-1px, -1px);
          box-shadow: 4px 4px 0 var(--ink);
        }
        .name-input:disabled { opacity: 0.5; cursor: not-allowed; }
        .add-btn {
          padding: 0 22px; background: var(--sun);
          border: 2.5px solid var(--ink); border-radius: 14px;
          font-family: 'Fraunces', serif; font-weight: 700; font-size: 15px;
          cursor: pointer; box-shadow: 3px 3px 0 var(--ink);
          display: flex; align-items: center; gap: 6px;
          color: var(--ink); white-space: nowrap;
          transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .add-btn:hover:not(:disabled) {
          transform: translate(-1px, -1px);
          box-shadow: 4px 4px 0 var(--ink);
        }
        .add-btn:active:not(:disabled) {
          transform: translate(2px, 2px);
          box-shadow: 1px 1px 0 var(--ink);
        }
        .add-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .crew-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 10px;
        }
        .crew-pill {
          display: flex; align-items: center; gap: 12px;
          background: var(--foam); border: 2px solid var(--ink);
          border-radius: 14px; padding: 11px 12px 11px 14px;
          transition: transform 120ms ease, background 200ms ease;
          position: relative;
        }
        .crew-pill:hover { transform: translateY(-1px); }
        .crew-pill.inactive {
          opacity: 0.55; background: var(--cream-deep);
        }
        .crew-pill.inactive .crew-name {
          text-decoration: line-through;
          text-decoration-color: var(--ocean);
          text-decoration-thickness: 1.5px;
        }
        .crew-pill.served {
          background: var(--mint); border-color: var(--ocean-deep);
        }

        .check-btn {
          width: 24px; height: 24px;
          border: 2.5px solid var(--ink); border-radius: 7px;
          background: var(--foam);
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer; flex-shrink: 0; padding: 0;
          transition: background 120ms ease;
        }
        .check-btn.checked { background: var(--ocean-deep); }
        .check-btn:disabled { cursor: not-allowed; opacity: 0.6; }
        .check-btn svg { opacity: 0; transition: opacity 120ms ease; }
        .check-btn.checked svg { opacity: 1; }

        .crew-name {
          flex: 1; font-size: 15px; font-weight: 500; color: var(--ink);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .served-badge {
          font-size: 10px; font-weight: 700;
          letter-spacing: 0.15em; text-transform: uppercase;
          color: var(--ocean-deep); background: var(--mint-deep);
          padding: 3px 7px; border-radius: 6px;
          border: 1.5px solid var(--ocean-deep); flex-shrink: 0;
        }
        .remove-btn {
          background: transparent; border: none;
          color: var(--coral-deep); cursor: pointer;
          padding: 4px; border-radius: 6px;
          display: inline-flex; align-items: center;
          opacity: 0.5;
          transition: opacity 120ms, background 120ms;
        }
        .remove-btn:hover { opacity: 1; background: rgba(242,110,87,0.15); }
        .remove-btn:disabled { cursor: not-allowed; opacity: 0.25; }

        .empty-crew {
          padding: 32px 20px; text-align: center;
          background: var(--foam); border: 2px dashed var(--ocean);
          border-radius: 14px; color: var(--ocean);
          font-family: 'Fraunces', serif; font-style: italic;
        }

        .actions-row { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
        .ghost-btn {
          display: inline-flex; align-items: center; gap: 7px;
          background: transparent; border: 1.5px solid var(--ocean);
          color: var(--ocean-deep); padding: 9px 14px; border-radius: 10px;
          font-size: 13px; font-weight: 500; cursor: pointer;
          font-family: 'Geist', sans-serif;
          transition: background 120ms;
        }
        .ghost-btn:hover { background: var(--mint); }
        .ghost-btn.danger {
          color: var(--coral-deep); border-color: var(--coral-deep);
        }
        .ghost-btn.danger:hover { background: rgba(242,110,87,0.12); }
        .ghost-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ─── Hall of Hydration ───────────────────────────────── */
        .podium {
          background: linear-gradient(135deg, var(--foam) 0%, var(--mint) 100%);
          border: 2px solid var(--ink); border-radius: 14px;
          padding: 14px 18px; margin-bottom: 18px;
          box-shadow: 3px 3px 0 var(--ink);
          display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
        }
        .podium-label {
          font-family: 'Fraunces', serif; font-style: italic;
          font-weight: 600; font-size: 14px;
          color: var(--ocean-deep);
        }
        .podium-list {
          display: flex; gap: 10px; flex-wrap: wrap; flex: 1;
        }
        .podium-slot {
          display: inline-flex; align-items: center; gap: 6px;
          background: var(--foam); border: 1.5px solid var(--ocean-deep);
          padding: 4px 10px; border-radius: 999px;
          font-size: 13px; font-weight: 600; color: var(--ink);
        }
        .podium-slot .medal { font-size: 15px; }
        .podium-slot .cnt {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px; font-weight: 600;
          color: var(--coral-deep);
        }

        .log-trigger {
          display: flex; align-items: center; gap: 10px;
          background: transparent; border: none;
          font-family: 'Fraunces', serif; font-size: 28px; font-weight: 600;
          color: var(--ocean-deep); cursor: pointer; padding: 0;
          font-variation-settings: 'SOFT' 100; letter-spacing: -0.02em;
        }
        .log-trigger .chev { transition: transform 250ms ease; color: var(--coral); }
        .log-trigger.open .chev { transform: rotate(180deg); }
        .log-count {
          font-family: 'JetBrains Mono', monospace; font-size: 12px;
          color: var(--ocean); background: var(--cream-deep);
          padding: 3px 9px; border-radius: 6px; font-weight: 500;
        }

        .log-body {
          max-height: 320px; overflow-y: auto;
          background: var(--foam); border: 2px solid var(--ink);
          border-radius: 14px; padding: 4px; margin-top: 14px;
          box-shadow: 3px 3px 0 var(--ink);
        }
        .log-body::-webkit-scrollbar { width: 8px; }
        .log-body::-webkit-scrollbar-track { background: transparent; }
        .log-body::-webkit-scrollbar-thumb {
          background: var(--cream-deep); border-radius: 4px;
        }

        .log-entry {
          display: grid; grid-template-columns: 52px 1fr auto auto;
          gap: 12px; align-items: center;
          padding: 9px 12px; border-bottom: 1px dashed var(--cream-deep);
        }
        .log-entry:last-child { border-bottom: none; }
        .log-round-tag {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          font-weight: 700; color: var(--foam); background: var(--coral);
          padding: 3px 7px; border-radius: 5px;
          text-align: center; letter-spacing: 0.05em;
        }
        .log-name {
          font-family: 'Geist', sans-serif; font-size: 14px;
          font-weight: 500; color: var(--ink);
        }
        .log-streak {
          font-family: 'Fraunces', serif; font-size: 10.5px; font-weight: 600;
          color: var(--coral-deep); background: rgba(242,110,87,0.15);
          padding: 2px 7px; border-radius: 5px;
          letter-spacing: 0.02em; white-space: nowrap;
        }
        .log-time {
          font-family: 'JetBrains Mono', monospace; font-size: 11px;
          color: var(--ocean);
        }

        .empty-log {
          text-align: center; padding: 28px 16px;
          color: var(--ocean); font-family: 'Fraunces', serif;
          font-style: italic; font-size: 14px;
        }

        .confirm-inline {
          display: inline-flex; align-items: center; gap: 8px;
          margin-left: 8px; font-size: 13px;
          color: var(--coral-deep); font-weight: 500;
        }
        .confirm-inline button {
          padding: 5px 10px; border-radius: 6px;
          border: 1.5px solid var(--ink); cursor: pointer;
          font-family: 'Geist', sans-serif; font-weight: 600; font-size: 12px;
        }
        .confirm-yes { background: var(--coral); color: var(--foam); }
        .confirm-no { background: var(--foam); color: var(--ink); }

        .footer-sig {
          text-align: center; margin-top: 64px;
          font-family: 'Fraunces', serif; font-style: italic;
          font-size: 13px; color: var(--ocean); opacity: 0.7;
        }
        .footer-sig .heart { color: var(--coral); font-style: normal; }

        @media (max-width: 640px) {
          .stage { padding: 32px 20px 28px; border-radius: 24px; }
          .section-title { font-size: 24px; }
          .log-trigger { font-size: 22px; }
          .add-row { flex-direction: column; }
          .add-btn { width: 100%; justify-content: center; padding: 14px; }
          .subtitle-row { margin-left: 0; }
          .log-entry { grid-template-columns: 48px 1fr auto; row-gap: 4px; }
          .log-time { grid-column: 2 / -1; text-align: right; }
        }
      `}</style>

      <div className="bubbles" aria-hidden="true">
        {bubbles.map((b, i) => (
          <div
            key={i}
            className="bubble"
            style={{
              width: b.size,
              height: b.size,
              left: `${b.left}%`,
              animationDuration: `${b.dur}s`,
              animationDelay: `${b.delay}s`,
              "--drift": b.drift,
            }}
          />
        ))}
      </div>

      <div className="shell">
        <header className="masthead">
          <div>
            <div className="wordmark">
              <span className="drop-wrap"><WaterDrop size={44} /></span>
              <span>
                H<sub style={{ fontSize: "0.55em", verticalAlign: "baseline" }}>2</sub>
                <em>Whose?</em>
              </span>
            </div>
            <div className="subtitle-row">
              <span className="subtitle">the fairest way to find the next bottle-filler.</span>
              {room !== "default" && <span className="room-tag">{room}</span>}
            </div>
          </div>

          <div className="header-tools">
            <span
              className={`sync-pill ${syncStatus === "loading" ? "loading" : ""}`}
              title={
                syncStatus === "online"
                  ? "Synced with the crew in real time."
                  : syncStatus === "offline"
                  ? "Can't reach the server — changes will sync when back online."
                  : "Checking in with the server…"
              }
            >
              <span className="sync-dot" style={{ background: syncDotColor, color: syncDotColor }} />
              {syncLabel}
            </span>

            <button
              className={`mute-btn ${muted ? "muted" : ""}`}
              onClick={toggleMute}
              aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX size={18} strokeWidth={2.2} /> : <Volume2 size={18} strokeWidth={2.2} />}
            </button>

            <div className="round-pill">
              <span className="dot" />
              Round №{roundNumber}
            </div>
          </div>
        </header>

        <section className="stage">
          <div className="stage-inner">
            <p className="eyebrow">
              {isSpinning
                ? "bubbling up a name…"
                : pickedName
                ? "today's bottle hero"
                : "who's up next?"}
            </p>

            <div className="reveal-box">
              {isSpinning ? (
                <h2 className="picked-name spinning">{spinDisplay || "…"}</h2>
              ) : pickedName ? (
                <>
                  <h2 key={revealKey} className="picked-name revealed">
                    {pickedName.name}
                  </h2>
                  <p className="picked-caption">
                    grab the bottle, <strong>{pickedName.name.split(" ")[0]}</strong> — the crew salutes you.
                  </p>
                  {justCompletedRound && (
                    <div className="round-banner">
                      🎉 round {roundNumber} complete — everyone's hydrated!
                    </div>
                  )}
                </>
              ) : names.length === 0 ? (
                <p className="empty-prompt">add your crew below to begin.</p>
              ) : activeNames.length === 0 ? (
                <p className="empty-prompt">tick at least one buddy to play.</p>
              ) : (
                <p className="empty-prompt">tap the button. fate will decide.</p>
              )}
            </div>

            <button
              className={`pick-btn ${isSpinning ? "spinning" : ""}`}
              onClick={pick}
              disabled={!canPick}
            >
              <WaterDrop size={26} invert={!isSpinning} />
              {isSpinning
                ? "splashing…"
                : pickedName
                ? "pick another buddy"
                : "pick a buddy"}
            </button>

            {activeNames.length > 0 && (
              <div className="progress-wrap">
                <p className="progress-caption">
                  <strong>{filledInRound.length}</strong> of{" "}
                  <strong>{activeNames.length}</strong> filled this round
                </p>
                <div className="droplet-row">
                  {activeNames.map((n) => {
                    const filled = currentRound.includes(n.id);
                    return (
                      <svg
                        key={n.id}
                        className={`droplet-svg ${filled ? "filled" : ""}`}
                        viewBox="0 0 20 24"
                        aria-label={n.name}
                      >
                        <title>{n.name}</title>
                        <path
                          className="drop-fill"
                          d="M10 1 C10 1 2 11 2 16 A8 8 0 0 0 18 16 C18 11 10 1 10 1 Z"
                          fill={filled ? "var(--coral)" : "var(--cream-deep)"}
                          stroke="var(--ink)"
                          strokeWidth="1.8"
                          strokeLinejoin="round"
                        />
                      </svg>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h3 className="section-title">
              The Crew <span className="title-mark">— your bottle squad</span>
            </h3>
            <span className="section-sub">
              {activeNames.length}/{names.length} in play
            </span>
          </div>

          <div className="add-row">
            <input
              className="name-input"
              placeholder="who's joining the rotation?"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addName()}
              maxLength={40}
              disabled={isSpinning}
            />
            <button
              className="add-btn"
              onClick={addName}
              disabled={isSpinning || !newName.trim()}
            >
              <Plus size={16} strokeWidth={2.5} /> add buddy
            </button>
          </div>

          {loading ? (
            <div className="empty-crew">loading your crew…</div>
          ) : names.length === 0 ? (
            <div className="empty-crew">
              no buddies yet — type a name above and hit add to start the rotation.
            </div>
          ) : (
            <div className="crew-grid">
              {names.map((n) => {
                const served = n.active && currentRound.includes(n.id);
                return (
                  <div
                    key={n.id}
                    className={`crew-pill ${!n.active ? "inactive" : ""} ${served ? "served" : ""}`}
                  >
                    <button
                      className={`check-btn ${n.active ? "checked" : ""}`}
                      onClick={() => toggleActive(n.id)}
                      disabled={isSpinning}
                      aria-label={n.active ? `Unselect ${n.name}` : `Select ${n.name}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
                        stroke="var(--foam)" strokeWidth="2.8"
                        strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 7 L6 11 L12 3" />
                      </svg>
                    </button>
                    <span className="crew-name">{n.name}</span>
                    {served && <span className="served-badge">done</span>}
                    <button
                      className="remove-btn"
                      onClick={() => removeName(n.id)}
                      disabled={isSpinning}
                      aria-label={`Remove ${n.name}`}
                    >
                      <X size={15} strokeWidth={2.2} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="actions-row">
            <button className="ghost-btn" onClick={resetRound} disabled={isSpinning}>
              <RotateCcw size={14} /> start fresh round
            </button>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <button
              className={`log-trigger ${showLog ? "open" : ""}`}
              onClick={() => setShowLog(!showLog)}
            >
              Splash Log
              <ChevronDown size={24} className="chev" />
              <span className="log-count">{history.length} picks</span>
            </button>
            {showLog && history.length > 0 && (
              <div>
                {!confirmClearLog ? (
                  <button
                    className="ghost-btn danger"
                    onClick={() => setConfirmClearLog(true)}
                  >
                    <Eraser size={14} /> clear log
                  </button>
                ) : (
                  <span className="confirm-inline">
                    wipe all history?
                    <button className="confirm-yes" onClick={clearLog}>yes, wipe</button>
                    <button className="confirm-no" onClick={() => setConfirmClearLog(false)}>nope</button>
                  </span>
                )}
              </div>
            )}
          </div>

          {showLog && topFillers.length > 0 && (
            <div className="podium">
              <span className="podium-label">Hall of Hydration</span>
              <div className="podium-list">
                {topFillers.map(([name, count], i) => (
                  <span key={name} className="podium-slot">
                    <span className="medal">{["🥇", "🥈", "🥉"][i]}</span>
                    {name}
                    <span className="cnt">×{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {showLog &&
            (history.length === 0 ? (
              <div className="empty-log">
                no splashes yet — your log will write itself as picks happen.
              </div>
            ) : (
              <div className="log-body">
                {history.map((h, i) => (
                  <div className="log-entry" key={i}>
                    <span className="log-round-tag">R{h.round}</span>
                    <span className="log-name">{h.name}</span>
                    {isBackToBack(i) ? (
                      <span className="log-streak">🔥 back-to-back</span>
                    ) : (
                      <span />
                    )}
                    <span className="log-time">{formatTime(h.timestamp)}</span>
                  </div>
                ))}
              </div>
            ))}
        </section>

        <div className="footer-sig">
          drink water, colleagues. <span className="heart">♥</span>
        </div>
      </div>
    </div>
  );
}

function WaterDrop({ size = 36, invert = false }) {
  return (
    <svg width={size} height={size * 1.2} viewBox="0 0 36 44" aria-hidden="true">
      <path
        d="M18 2 C18 2 4 20 4 28 A14 14 0 0 0 32 28 C32 20 18 2 18 2 Z"
        fill={invert ? "var(--foam)" : "var(--coral)"}
        stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round"
      />
      <ellipse
        cx="13" cy="22" rx="3" ry="4.5"
        fill={invert ? "var(--coral)" : "var(--foam)"}
        opacity="0.65"
      />
    </svg>
  );
}
