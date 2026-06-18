"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getSocket, disconnectSocket } from "@/lib/socket";
import styles from "./room.module.css";
import { getStroke } from "perfect-freehand";

const LASER_STROKE_OPTIONS = {
  size: 6,
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
};

function getLaserStrokePath(points: { x: number; y: number }[]): Path2D {
  const outline = getStroke(points.map((p) => [p.x, p.y]), LASER_STROKE_OPTIONS);
  if (!outline.length) return new Path2D();
  const d = outline.reduce<(string | number)[]>(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"]
  );
  d.push("Z");
  return new Path2D(d.join(" "));
}

const STROKE_OPTIONS = {
  size: 10,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: true,
};

function getStrokePath(points: { x: number; y: number }[]): Path2D {
  const outline = getStroke(points.map((p) => [p.x, p.y]), STROKE_OPTIONS);
  if (!outline.length) return new Path2D();
  // Quadratic bezier reducer from perfect-freehand docs — smoother than lineTo
  const d = outline.reduce<(string | number)[]>(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"]
  );
  d.push("Z");
  return new Path2D(d.join(" "));
}

interface Participant {
  id: string;
  name: string;
  mode: "presenting" | "viewing";
  cursorX?: number;
  cursorY?: number;
}

interface RoomState {
  currentSlide: number;
  totalSlides: number;
  slides: number;
  participants: Participant[];
  activePresenter: string | null;
  drawings?: Record<number, { participantId: string; name: string; path: { x: number; y: number }[]; drawingId?: string }[]>;
}

interface CursorPosition {
  participantId: string;
  name: string;
  x: number;
  y: number;
}

interface DrawPath {
  participantId: string;
  name: string;
  path: { x: number; y: number }[];
  drawingId?: string;
}

export default function UnifiedRoom() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const roomId = params.roomId as string;
  const initialMode = (searchParams.get("mode") as "presenting" | "viewing") ?? "viewing";
  const userName = searchParams.get("name") ?? "";
  const tempName = searchParams.get("tempName") ?? "";

  const [hasJoined, setHasJoined] = useState(!!searchParams.get("name"));
  const [joinNameInput, setJoinNameInput] = useState(userName || tempName);

  const [state, setState] = useState<RoomState | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [slideDirection, setSlideDirection] = useState<"next" | "prev">("next");
  const [myMode, setMyMode] = useState<"presenting" | "viewing">(initialMode);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [cursors, setCursors] = useState<CursorPosition[]>([]);
  const [drawingsBySlide, setDrawingsBySlide] = useState<Record<number, DrawPath[]>>({});
  const [isDrawing, setIsDrawing] = useState(false);
  const [activeTool, setActiveTool] = useState<"none" | "pen" | "laser">("none");
  const drawingEnabled = activeTool === "pen";
  const laserEnabled = activeTool === "laser";
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>([]);
  const [currentDrawingId, setCurrentDrawingId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState(userName);
  const [appliedName, setAppliedName] = useState(userName);
  const [myCursor, setMyCursor] = useState<{ x: number; y: number } | null>(null);
  const [showCustomCursor, setShowCustomCursor] = useState(true); // Original feature: Custom vs Default look
  const [isPointerVisible, setIsPointerVisible] = useState(false); // New feature: Broadcast pointer to everyone
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"info" | "slides">("info");
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const slideContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laserCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastLaserEmitRef = useRef<number>(0);
  const laserStrokesRef = useRef<Map<string, { strokes: Map<string, { x: number; y: number }[]>; lastActivity: number }>>(new Map());
  const currentLaserStrokeRef = useRef<string | null>(null);

  // Throttling refs (Cap at ~200 FPS -> 5ms)
  const lastCursorMoveRef = useRef<number>(0);
  const lastDrawEmitRef = useRef<number>(0);

  const [stageDimensions, setStageDimensions] = useState({ width: 0, height: 0 });

  // ── Calculate Strict 16:9 Dimensions ───────────────────────────────────────
  useEffect(() => {
    const updateDimensions = () => {
      if (!slideContainerRef.current) return;
      const rect = slideContainerRef.current.getBoundingClientRect();
      const containerAspect = rect.width / rect.height;
      const imageAspect = 16 / 9;

      let width = rect.width;
      let height = rect.height;

      if (containerAspect > imageAspect) {
        // Container is wider -> pillarbox
        height = rect.height;
        width = height * imageAspect;
      } else {
        // Container is taller -> letterbox
        width = rect.width;
        height = width / imageAspect;
      }

      setStageDimensions({ width, height });
    };

    updateDimensions();
    // Re-calculate after a brief delay for fullscreen transitions
    setTimeout(updateDimensions, 50);

    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [isFullscreen]);

  // Get drawings for current slide
  const drawings = drawingsBySlide[currentSlide] || [];

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasJoined) return;

    const socket = getSocket();

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-room", { roomId, name: appliedName, mode: myMode });
    });

    socket.on("room-state", (data: RoomState) => {
      setState(data);
      setCurrentSlide((prev) => {
        if (data.currentSlide > prev) setSlideDirection("next");
        else if (data.currentSlide < prev) setSlideDirection("prev");
        return data.currentSlide;
      });
      if (data.drawings) setDrawingsBySlide(data.drawings);
    });

    socket.on("participant-joined", ({ participant }: { participant: Participant }) => {
      setState((prev) => {
        if (!prev) return prev;
        const newParticipants = prev.participants.filter((p) => p.id !== participant.id);
        return { ...prev, participants: [...newParticipants, participant] };
      });
    });

    socket.on("participant-left", ({ id }: { id: string }) => {
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          participants: prev.participants.filter((p) => p.id !== id),
        };
      });
      setCursors((prev) => prev.filter((c) => c.participantId !== id));
    });

    socket.on("participant-updated", ({ participant }: { participant: Participant }) => {
      setState((prev) => {
        if (!prev) return prev;
        const newParticipants = prev.participants.map((p) =>
          p.id === participant.id ? participant : p
        );
        return { ...prev, participants: newParticipants };
      });
    });

    socket.on("slide-update", ({ slideIndex }: { slideIndex: number }) => {
      setCurrentSlide((prev) => {
        if (slideIndex > prev) setSlideDirection("next");
        else if (slideIndex < prev) setSlideDirection("prev");
        return slideIndex;
      });
    });

    socket.on("cursor-update", ({ participantId, name, x, y }: CursorPosition) => {
      setCursors((prev) => {
        const filtered = prev.filter((c) => c.participantId !== participantId);
        return [...filtered, { participantId, name, x, y }];
      });
    });

    socket.on("cursor-hide", ({ participantId }: { participantId: string }) => {
      setCursors((prev) => prev.filter((c) => c.participantId !== participantId));
    });

    socket.on("draw-update", ({ participantId, name, path, slideIndex, drawingId }: DrawPath & { slideIndex: number; drawingId?: string }) => {
      setDrawingsBySlide((prev) => {
        const slideDrawings = prev[slideIndex] || [];

        if (drawingId) {
          // Check if this drawing ID already exists
          const existingIndex = slideDrawings.findIndex(d => d.drawingId === drawingId);

          if (existingIndex !== -1) {
            // Update existing drawing
            const updated = [...slideDrawings];
            updated[existingIndex] = { participantId, name, path, drawingId };
            return {
              ...prev,
              [slideIndex]: updated,
            };
          }
        }

        // Add as new drawing
        return {
          ...prev,
          [slideIndex]: [...slideDrawings, { participantId, name, path, drawingId }],
        };
      });
    });

    socket.on("clear-drawings", ({ slideIndex }: { slideIndex: number }) => {
      setDrawingsBySlide((prev) => ({
        ...prev,
        [slideIndex]: [],
      }));
    });

    socket.on("laser-update", ({ participantId, strokeId, path }: { participantId: string; strokeId: string; path: { x: number; y: number }[] }) => {
      const entry = laserStrokesRef.current.get(participantId) ?? { strokes: new Map(), lastActivity: 0 };
      entry.strokes.set(strokeId, path);
      entry.lastActivity = Date.now();
      laserStrokesRef.current.set(participantId, entry);
    });

    socket.on("session-ended", () => setEnded(true));

    socket.on("error", ({ message }: { message: string }) => {
      alert(message);
    });

    if (socket.connected) {
      setConnected(true);
      socket.emit("join-room", { roomId, name: appliedName, mode: myMode });
    }

    return () => {
      socket.off("connect");
      socket.off("room-state");
      socket.off("participant-joined");
      socket.off("participant-left");
      socket.off("participant-updated");
      socket.off("slide-update");
      socket.off("cursor-update");
      socket.off("cursor-hide");
      socket.off("draw-update");
      socket.off("clear-drawings");
      socket.off("laser-update");
      socket.off("session-ended");
      socket.off("error");
    };
  }, [roomId, appliedName, myMode, showCustomCursor, isPointerVisible, hasJoined]);

  // Disconnect socket entirely on unmount (e.g. back button)
  useEffect(() => {
    return () => {
      disconnectSocket();
    };
  }, []);

  // Sync native fullscreen exits
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // ── Sync URL Params ─────────────────────────────────────────────────────────
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", myMode);

    // Immediately remove tempName so it doesn't stay in the URL
    if (url.searchParams.has("tempName")) {
      url.searchParams.delete("tempName");
    }

    if (hasJoined && appliedName) {
      url.searchParams.set("name", appliedName);
    } else {
      url.searchParams.delete("name");
    }
    window.history.replaceState(null, "", url.toString());
  }, [myMode, appliedName, hasJoined]);

  // ── Keyboard navigation ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Fullscreen toggle for everyone (F key)
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      if (e.key === "Escape") {
        setIsFullscreen(false);
        return;
      }

      // Slide navigation only for presenters
      if (myMode !== "presenting") return;

      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        goTo(currentSlide + 1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(currentSlide - 1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [currentSlide, state, myMode]);

  // ── Drawing canvas sync ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#FF6B6B";

    drawings.forEach((drawing) => {
      ctx.fill(getStrokePath(drawing.path));
    });

    if (currentPath.length > 0 && isDrawing) {
      ctx.fill(getStrokePath(currentPath));
    }
  }, [drawings, currentPath, isDrawing]);

  // ── Laser rAF loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    const HOLD_MS = 2000;
    const FADE_MS = 1500;
    let rafId: number;

    const drawStroke = (ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) => {
      if (pts.length === 1) {
        ctx.shadowColor = "#FF3B30";
        ctx.shadowBlur = 16;
        ctx.fillStyle = "#FF6B6B";
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 5, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const path = getLaserStrokePath(pts);
      ctx.shadowColor = "#FF3B30";
      ctx.shadowBlur = 18;
      ctx.fillStyle = "#FF6B6B";
      ctx.fill(path);
    };

    const frame = () => {
      const canvas = laserCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const now = Date.now();
          laserStrokesRef.current.forEach((entry, participantId) => {
            const age = now - entry.lastActivity;
            const alpha = age < HOLD_MS ? 1
              : age < HOLD_MS + FADE_MS ? 1 - (age - HOLD_MS) / FADE_MS
              : 0;
            if (alpha <= 0) { laserStrokesRef.current.delete(participantId); return; }
            ctx.save();
            ctx.globalAlpha = alpha;
            entry.strokes.forEach(pts => drawStroke(ctx, pts));
            ctx.restore();
          });
        }
      }
      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const goTo = useCallback(
    (idx: number) => {
      if (!state || myMode !== "presenting") return;
      const clamped = Math.max(0, Math.min(idx, state.totalSlides - 1));
      if (clamped === currentSlide) return;
      setSlideDirection(clamped > currentSlide ? "next" : "prev");
      setCurrentSlide(clamped);
      getSocket().emit("slide-change", { roomId, slideIndex: clamped });
    },
    [state, currentSlide, roomId, myMode]
  );

  const toggleMode = () => {
    const newMode = myMode === "presenting" ? "viewing" : "presenting";
    setMyMode(newMode);
    getSocket().emit("toggle-mode", { roomId, mode: newMode });
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 3000);
  };

  const togglePointerVisibility = () => {
    const nextState = !isPointerVisible;
    setIsPointerVisible(nextState);
    if (!nextState) {
      getSocket().emit("cursor-hide", { roomId });
      showToast("Pointer hidden from everyone");
    } else {
      showToast("Pointer visible to everyone");
    }
  };

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
    setIsOptionsOpen(false); // Close menu when exiting fullscreen
  };

  const triggerNativeFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(err => console.error("Error attempting to enable full-screen mode:", err));
    } else {
      document.exitFullscreen();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (myMode !== "presenting") return;

    const now = Date.now();
    if (now - lastCursorMoveRef.current < 5) return; // 5ms = 200 FPS cap
    lastCursorMoveRef.current = now;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    // Update local cursor position
    setMyCursor({ x, y });

    if (isPointerVisible) {
      getSocket().emit("cursor-move", { roomId, x, y });
    }
  };

  const handleDrawStart = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (myMode !== "presenting" || (!drawingEnabled && !laserEnabled)) return;
    setIsDrawing(true);
    if (laserEnabled) {
      const strokeId = `${Date.now()}-${Math.random()}`;
      currentLaserStrokeRef.current = strokeId;
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (canvas.height / rect.height);
      const entry = laserStrokesRef.current.get("me") ?? { strokes: new Map(), lastActivity: 0 };
      entry.strokes.set(strokeId, [{ x, y }]);
      entry.lastActivity = Date.now();
      laserStrokesRef.current.set("me", entry);
      getSocket().emit("laser", { roomId, strokeId, path: [{ x, y }] });
      return;
    }

    // Generate unique ID for this drawing session
    const drawingId = `${Date.now()}-${Math.random()}`;
    setCurrentDrawingId(drawingId);

    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    setCurrentPath([{ x, y }]);
  };

  const handleDrawMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (myMode !== "presenting") return;

    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    // ── Laser branch (mouse held) ────────────────────────────────────────────
    if (laserEnabled) {
      if (!isDrawing || !currentLaserStrokeRef.current) return;
      const entry = laserStrokesRef.current.get("me");
      if (!entry) return;
      const pts = entry.strokes.get(currentLaserStrokeRef.current) ?? [];
      pts.push({ x, y });
      entry.strokes.set(currentLaserStrokeRef.current, pts);
      entry.lastActivity = Date.now();
      const now = Date.now();
      if (now - lastLaserEmitRef.current >= 5) {
        getSocket().emit("laser", { roomId, strokeId: currentLaserStrokeRef.current, path: pts });
        lastLaserEmitRef.current = now;
      }
      return;
    }

    // ── Pen branch ──────────────────────────────────────────────────────────
    if (!isDrawing || !currentDrawingId) return;

    const newPath = [...currentPath, { x, y }];
    setCurrentPath(newPath);

    const now = Date.now();
    if (now - lastDrawEmitRef.current >= 5) {
      getSocket().emit("draw", { roomId, path: newPath, slideIndex: currentSlide, drawingId: currentDrawingId });
      lastDrawEmitRef.current = now;
    }
  };

  const handleDrawEnd = () => {
    if (!isDrawing || myMode !== "presenting") return;
    setIsDrawing(false);
    currentLaserStrokeRef.current = null;
    if (currentPath.length > 0 && currentDrawingId) {
      // Ensure the finalized path is broadcasted (in case the last move was skipped by throttle)
      getSocket().emit("draw", { roomId, path: currentPath, slideIndex: currentSlide, drawingId: currentDrawingId });

      // Already emitted during drawing, just save to local state
      setDrawingsBySlide((prev) => ({
        ...prev,
        [currentSlide]: [...(prev[currentSlide] || []), { participantId: "me", name: newName, path: currentPath, drawingId: currentDrawingId }],
      }));
    }
    setCurrentPath([]);
    setCurrentDrawingId(null);
  };

  const clearAllDrawings = () => {
    getSocket().emit("clear-drawings", { roomId, slideIndex: currentSlide });
    setDrawingsBySlide((prev) => ({
      ...prev,
      [currentSlide]: [],
    }));
  };

  const handleNameChange = () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== appliedName) {
      getSocket().emit("update-name", { roomId, name: trimmed });
      setAppliedName(trimmed);
    }
    setIsEditingName(false);
  };

  const copyRoomCode = () => {
    const code = roomId;
    if (!navigator.clipboard) {
      const textArea = document.createElement("textarea");
      textArea.value = code;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyJoinLink = () => {
    const link = `${window.location.origin}/room/${roomId}`;
    if (!navigator.clipboard) {
      const textArea = document.createElement("textarea");
      textArea.value = link;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const leaveSession = () => {
    disconnectSocket();
    router.push("/");
  };

  if (!hasJoined) {
    return (
      <div className={styles.root}>
        <div className={styles.centered} style={{ flexDirection: "column", gap: 24, padding: 20, width: "100%" }}>
          <div className="card fade-up" style={{ width: "100%", maxWidth: 400, background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px" }}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Join Room</h2>
              <p style={{ color: "var(--text-2)", fontFamily: "var(--mono)", letterSpacing: "0.1em" }}>{roomId}</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Role</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className={`btn ${myMode === "viewing" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setMyMode("viewing")}
                    style={{ flex: 1 }}
                  >
                    👁️ Viewing
                  </button>
                  <button
                    className={`btn ${myMode === "presenting" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setMyMode("presenting")}
                    style={{ flex: 1 }}
                  >
                    🎤 Presenting
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="join-name" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Your Name</label>
                <input
                  id="join-name"
                  className="input"
                  placeholder="How should we call you?"
                  value={joinNameInput}
                  onChange={(e) => setJoinNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && joinNameInput.trim()) {
                      setAppliedName(joinNameInput.trim());
                      setNewName(joinNameInput.trim());
                      setHasJoined(true);
                    }
                  }}
                  autoFocus
                />
              </div>

              <button
                className={`btn btn-primary`}
                onClick={() => {
                  if (joinNameInput.trim()) {
                    setAppliedName(joinNameInput.trim());
                    setNewName(joinNameInput.trim());
                    setHasJoined(true);
                  }
                }}
                disabled={!joinNameInput.trim()}
                style={{ marginTop: 8, width: "100%" }}
              >
                Join Room
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (ended) {
    return (
      <div className={styles.centered}>
        <h2>Session Ended</h2>
        <button className="btn btn-primary" onClick={() => router.push("/")}>
          Back to Home
        </button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className={styles.centered}>
        <span className="spinner" />
        <p style={{ color: "var(--text-2)", marginTop: 16 }}>Connecting to room…</p>
      </div>
    );
  }

  const slideUrl = `/api/slide/${roomId}/${currentSlide + 1}`;
  const presenters = state.participants.filter((p) => p.mode === "presenting");
  const viewers = state.participants.filter((p) => p.mode === "viewing");

  // Generate thumbnail URLs for slide strip
  const slideUrls = Array.from({ length: state.totalSlides }, (_, i) =>
    `/api/slide/${roomId}/${i + 1}`
  );

  return (
    <div className={styles.root}>
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sideTop}>
          <a href="/" className={styles.logo}>
            ppt-live
          </a>
          <div className={styles.tabs}>
            <button
              className={`${styles.tabBtn} ${sidebarTab === "info" ? styles.tabActive : ""}`}
              onClick={() => setSidebarTab("info")}
            >
              Info
            </button>
            <button
              className={`${styles.tabBtn} ${sidebarTab === "slides" ? styles.tabActive : ""}`}
              onClick={() => setSidebarTab("slides")}
            >
              Slides
            </button>
          </div>
        </div>

        <div className={styles.sideContent}>
          {sidebarTab === "info" ? (
            <>
              {/* Mode Toggle */}
              <div className={styles.modeToggle}>
                <button
                  className={`btn ${myMode === "presenting" ? "btn-primary" : "btn-ghost"}`}
                  onClick={toggleMode}
                  style={{ width: "100%", marginBottom: 8 }}
                >
                  {myMode === "presenting" ? "🎤 Presenting" : "👁️ Viewing"}
                </button>
                <p style={{ fontSize: 11, color: "var(--text-2)", textAlign: "center" }}>
                  {myMode === "presenting"
                    ? "You can present & control slides"
                    : "Click to switch to presenting mode"}
                </p>
              </div>

              {/* User Name */}
              <div className={styles.nameCard}>
                {isEditingName ? (
                  <div style={{ display: "flex", gap: 4 }}>
                    <input
                      type="text"
                      className="input"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleNameChange()}
                      onBlur={handleNameChange}
                      autoFocus
                      style={{ flex: 1, fontSize: 13 }}
                    />
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>👤 {newName}</span>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setIsEditingName(true)}
                      style={{ fontSize: 11, padding: "4px 8px" }}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>

              {/* Room code */}
              <div className={styles.codeCard}>
                <div className={styles.codeLabel}>
                  <span className="live-dot" />
                  Room Code
                </div>
                <div className={styles.code}>{roomId}</div>
                <div className={styles.codeActions}>
                  <button
                    className="btn btn-ghost"
                    onClick={copyRoomCode}
                    style={{ flex: 1, fontSize: 12 }}
                  >
                    {copied ? "✓ Copied" : "Copy Code"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={copyJoinLink}
                    style={{ flex: 1, fontSize: 12 }}
                  >
                    Copy Link
                  </button>
                </div>
              </div>

              {/* Participants */}
              <div className={styles.viewersSection}>
                <div className={styles.viewersHeader}>
                  <span>Participants</span>
                  <span className="badge badge-accent">{state.participants.length}</span>
                </div>
                <div className={styles.viewersList}>
                  {presenters.length > 0 && (
                    <>
                      <p style={{ fontSize: 10, color: "var(--text-2)", margin: "8px 0 4px" }}>
                        PRESENTING
                      </p>
                      {presenters.map((p) => (
                        <div key={p.id} className={styles.viewer}>
                          <div className={styles.avatar} style={{ background: "var(--accent)" }}>
                            {p.name[0].toUpperCase()}
                          </div>
                          <span>{p.name}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {viewers.length > 0 && (
                    <>
                      <p style={{ fontSize: 10, color: "var(--text-2)", margin: "8px 0 4px" }}>
                        VIEWING
                      </p>
                      {viewers.map((p) => (
                        <div key={p.id} className={styles.viewer}>
                          <div className={styles.avatar}>{p.name[0].toUpperCase()}</div>
                          <span>{p.name}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

              <div style={{ marginTop: "auto", paddingTop: 16 }}>
                <button className="btn btn-danger" onClick={leaveSession} style={{ width: "100%" }}>
                  Leave Session
                </button>
              </div>
            </>
          ) : (
            <div className={styles.slideStrip}>
              {slideUrls.map((src, i) => (
                <button
                  key={i}
                  ref={(el) => {
                    thumbRefs.current[i] = el;
                  }}
                  className={`${styles.stripThumb} ${i === currentSlide ? styles.stripActive : ""}`}
                  onClick={() => myMode === "presenting" && goTo(i)}
                  disabled={myMode !== "presenting"}
                  title={`Slide ${i + 1}`}
                >
                  <img src={src} alt={`Slide ${i + 1}`} />
                  <span className={styles.thumbNum}>{i + 1}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.sideBottom}>
          <div className={styles.connectionStatus}>
            <span className={connected ? "live-dot" : ""} />
            {connected ? "Connected" : "Reconnecting…"}
          </div>
        </div>
      </aside>

      {/* ── Main stage ──────────────────────────────────────────────────── */}
      <div className={styles.stage}>
        <div
          ref={slideContainerRef}
          className={`${styles.slideWrap} ${isFullscreen ? styles.theaterMode : ""}`}
          style={{ cursor: myMode === "presenting" && showCustomCursor ? "none" : "default" }}
        >
          <div
            className={styles.stageContent}
            onMouseMove={handleMouseMove}
            style={{
              width: stageDimensions.width ? `${stageDimensions.width}px` : "100%",
              height: stageDimensions.height ? `${stageDimensions.height}px` : "100%",
            }}
          >
            {slideUrls.map((url, i) => (
              <img
                key={url}
                src={url}
                alt={`Slide ${i + 1}`}
                className={`${styles.slideImg} ${i === currentSlide
                  ? slideDirection === "next"
                    ? styles.slideNext
                    : styles.slidePrev
                  : ""
                  }`}
                style={{
                  display: i === currentSlide ? "block" : "none",
                  position: "absolute",
                  top: 0,
                  left: 0
                }}
              />
            ))}

            {/* Drawing Canvas */}
            <canvas
              key={currentSlide}
              ref={canvasRef}
              className={`${styles.drawingCanvas} ${slideDirection === "next" ? styles.slideNext : styles.slidePrev}`}
              width={1920}
              height={1080}
              onMouseDown={handleDrawStart}
              onMouseMove={handleDrawMove}
              onMouseUp={handleDrawEnd}
              onMouseLeave={handleDrawEnd}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                cursor: (drawingEnabled || laserEnabled) && myMode === "presenting" ? "crosshair" : "default",
                pointerEvents: (drawingEnabled || laserEnabled) && myMode === "presenting" ? "auto" : "none",
              }}
            />

            {/* Laser canvas — sits on top, never persisted */}
            <canvas
              ref={laserCanvasRef}
              width={1920}
              height={1080}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />

            {/* Other presenters' cursors */}
            {cursors.map((cursor) => (
              <div
                key={cursor.participantId}
                className={styles.remoteCursor}
                style={{
                  left: `${cursor.x}%`,
                  top: `${cursor.y}%`,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M5 3L15 10L9 11L7 17L5 3Z"
                    fill="var(--accent)"
                    stroke="white"
                    strokeWidth="1"
                  />
                </svg>
                <span className={styles.cursorName}>{cursor.name}</span>
              </div>
            ))}

            {/* My own cursor (when presenting, custom cursor enabled, pointer visible, and not drawing) */}
            {myMode === "presenting" && myCursor && showCustomCursor && isPointerVisible && !drawingEnabled && (
              <div
                className={styles.remoteCursor}
                style={{
                  left: `${myCursor.x}%`,
                  top: `${myCursor.y}%`,
                  transition: "none"
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M5 3L15 10L9 11L7 17L5 3Z"
                    fill="var(--accent)"
                    stroke="white"
                    strokeWidth="1"
                  />
                </svg>
                <span className={styles.cursorName}>{newName} (You)</span>
              </div>
            )}

            {/* Google Slides style floating toolbar - ONLY in fullscreen */}
            {isFullscreen && (
              <>
              <div className={styles.floatingToolbarZone}>
                <div className={styles.floatingToolbar}>
                  <button
                    className={styles.toolbarBtn}
                    onClick={(e) => { e.stopPropagation(); goTo(currentSlide - 1); }}
                    disabled={currentSlide === 0 || myMode === "viewing"}
                    title="Previous Slide"
                  >
                    ◀
                  </button>
                  <span className={styles.toolbarSlideNum}>
                    Slide {currentSlide + 1}
                  </span>
                  <button
                    className={styles.toolbarBtn}
                    onClick={(e) => { e.stopPropagation(); goTo(currentSlide + 1); }}
                    disabled={currentSlide === state.totalSlides - 1 || myMode === "viewing"}
                    title="Next Slide"
                  >
                    ▶
                  </button>

                  <div style={{ position: "relative" }}>
                    <button
                      className={styles.toolbarBtn}
                      onClick={(e) => { e.stopPropagation(); setIsOptionsOpen(!isOptionsOpen); }}
                      title="Options"
                    >
                      ⋮
                    </button>

                    {isOptionsOpen && (
                      <div className={styles.optionsMenu}>
                        {myMode === "presenting" && (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); togglePointerVisibility(); setIsOptionsOpen(false); }}>
                              {isPointerVisible ? "Hide pointer" : "Show pointer"}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setShowCustomCursor(!showCustomCursor); setIsOptionsOpen(false); }}>
                              {showCustomCursor ? "Use default cursor" : "Use custom cursor"}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setActiveTool(activeTool === "pen" ? "none" : "pen"); setIsOptionsOpen(false); }}>
                              {drawingEnabled ? "Turn off pen" : "Turn on pen"}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setActiveTool(activeTool === "laser" ? "none" : "laser"); setIsOptionsOpen(false); }}>
                              {laserEnabled ? "Turn off laser" : "Turn on laser"}
                            </button>
                            <button disabled={drawings.length === 0} onClick={(e) => { e.stopPropagation(); clearAllDrawings(); setIsOptionsOpen(false); }}>
                              Clear drawings
                            </button>
                            <div className={styles.menuDivider} />
                          </>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}>
                          Exit full screen
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {myMode === "presenting" && (
                <div className={styles.floatingToolbarZoneRight}>
                  <div className={styles.penToolbar}>
                    <button
                      className={`${styles.penToolBtn} ${drawingEnabled ? styles.penToolBtnActive : ""}`}
                      onClick={() => setActiveTool(activeTool === "pen" ? "none" : "pen")}
                    >
                      ✏️ Pen
                    </button>
                    <button
                      className={`${styles.penToolBtn} ${laserEnabled ? styles.penToolBtnActive : ""}`}
                      onClick={() => setActiveTool(activeTool === "laser" ? "none" : "laser")}
                    >
                      🔴 Laser
                    </button>
                    <button
                      className={styles.penToolBtn}
                      onClick={clearAllDrawings}
                      disabled={drawings.length === 0}
                    >
                      🗑️ Clear
                    </button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
        </div>

        {/* Controls */}
        {myMode === "presenting" && (
          <div className={styles.controls}>
            <button
              className="btn btn-ghost"
              onClick={() => goTo(currentSlide - 1)}
              disabled={currentSlide === 0}
            >
              ← Prev
            </button>

            <div className={styles.slideCounter}>
              <span className={styles.slideNum}>{currentSlide + 1}</span>
              <span className={styles.slideTotal}> / {state.totalSlides}</span>
            </div>

            <button
              className="btn btn-ghost"
              onClick={() => goTo(currentSlide + 1)}
              disabled={currentSlide === state.totalSlides - 1}
            >
              Next →
            </button>

            <div style={{ width: "1px", height: "24px", background: "var(--border)", margin: "0 8px" }} />

            <button
              className={`btn ${drawingEnabled ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setActiveTool(activeTool === "pen" ? "none" : "pen")}
              title="Toggle drawing mode"
            >
              {drawingEnabled ? "✏️ Drawing" : "✏️ Pen"}
            </button>

            <button
              className={`btn ${laserEnabled ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setActiveTool(activeTool === "laser" ? "none" : "laser")}
              title="Toggle laser pointer"
            >
              🔴 Laser
            </button>

            <button
              className={`btn ${showCustomCursor ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowCustomCursor(!showCustomCursor)}
              title="Toggle custom cursor"
            >
              {showCustomCursor ? "🖱️ Custom" : "🖱️ Default"}
            </button>

            <button
              className={`btn ${isPointerVisible ? "btn-primary" : "btn-ghost"}`}
              onClick={togglePointerVisibility}
              title="Toggle pointer broadcasting"
            >
              {isPointerVisible ? "👁️ Pointer On" : "👁️ Pointer Off"}
            </button>

            <button className="btn btn-ghost" onClick={clearAllDrawings} disabled={drawings.length === 0}>
              🗑️ Clear
            </button>

            <button className="btn btn-ghost" onClick={toggleFullscreen}>
              {isFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}
            </button>
          </div>
        )}

        {myMode === "viewing" && (
          <div className={styles.viewerControls}>
            <div className={styles.viewerBadge}>
              <span className="live-dot" style={{ width: 5, height: 5 }} />
              Watching {presenters.length > 0 ? presenters[0].name : "presentation"}
            </div>
            <button className="btn btn-ghost" onClick={toggleFullscreen}>
              {isFullscreen ? "⛶ Exit Theater" : "⛶ Theater"}
            </button>
            <button className="btn btn-primary" onClick={triggerNativeFullscreen}>
              🖥️ Takeover
            </button>
          </div>
        )}

        <p className={styles.keyHint}>
          {myMode === "presenting"
            ? "← → or Spacebar to navigate · F for fullscreen"
            : "Press F for fullscreen"}
        </p>

        {/* Toast Notification */}
        {toastMessage && (
          <div className={styles.toast}>
            {toastMessage}
          </div>
        )}
      </div>
    </div>
  );
}
