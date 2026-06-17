"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getSocket, disconnectSocket } from "@/lib/socket";
import styles from "./room.module.css";

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
  slides: number; // Just the count now
  participants: Participant[];
  activePresenter: string | null;
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
  const userName = searchParams.get("name") ?? "Guest";

  const [state, setState] = useState<RoomState | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [myMode, setMyMode] = useState<"presenting" | "viewing">(initialMode);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [cursors, setCursors] = useState<CursorPosition[]>([]);
  const [drawingsBySlide, setDrawingsBySlide] = useState<Record<number, DrawPath[]>>({});
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingEnabled, setDrawingEnabled] = useState(false);
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>([]);
  const [currentDrawingId, setCurrentDrawingId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState(userName);
  const [myCursor, setMyCursor] = useState<{ x: number; y: number } | null>(null);
  const [showCustomCursor, setShowCustomCursor] = useState(true);

  const slideContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Get drawings for current slide
  const drawings = drawingsBySlide[currentSlide] || [];

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-room", { roomId, name: userName, mode: myMode });
    });

    socket.on("room-state", (data: RoomState) => {
      setState(data);
      setCurrentSlide(data.currentSlide);
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
      setCurrentSlide(slideIndex);
    });

    socket.on("cursor-update", ({ participantId, name, x, y }: CursorPosition) => {
      setCursors((prev) => {
        const filtered = prev.filter((c) => c.participantId !== participantId);
        return [...filtered, { participantId, name, x, y }];
      });
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

    socket.on("session-ended", () => setEnded(true));

    socket.on("error", ({ message }: { message: string }) => {
      alert(message);
    });

    if (socket.connected) {
      setConnected(true);
      socket.emit("join-room", { roomId, name: userName, mode: myMode });
    }

    return () => {
      socket.off("connect");
      socket.off("room-state");
      socket.off("participant-joined");
      socket.off("participant-left");
      socket.off("participant-updated");
      socket.off("slide-update");
      socket.off("cursor-update");
      socket.off("draw-update");
      socket.off("clear-drawings");
      socket.off("session-ended");
      socket.off("error");
    };
  }, [roomId, userName, myMode]);

  // ── Fullscreen state detection ──────────────────────────────────────────────
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // ── Keyboard navigation ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Fullscreen toggle for everyone (F key)
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
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

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw all completed paths
    drawings.forEach((drawing) => {
      ctx.strokeStyle = "#FF0000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      drawing.path.forEach((point, i) => {
        if (i === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
    });

    // Draw current path being drawn
    if (currentPath.length > 0 && isDrawing) {
      ctx.strokeStyle = "#FF0000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      currentPath.forEach((point, i) => {
        if (i === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
    }
  }, [drawings, currentPath, isDrawing]);

  const goTo = useCallback(
    (idx: number) => {
      if (!state || myMode !== "presenting") return;
      const clamped = Math.max(0, Math.min(idx, state.totalSlides - 1));
      if (clamped === currentSlide) return;
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

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      slideContainerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (myMode !== "presenting") return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    // Update local cursor position
    setMyCursor({ x, y });

    getSocket().emit("cursor-move", { roomId, x, y });
  };

  const handleDrawStart = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (myMode !== "presenting" || !drawingEnabled) return;
    setIsDrawing(true);
    
    // Generate unique ID for this drawing session
    const drawingId = `${Date.now()}-${Math.random()}`;
    setCurrentDrawingId(drawingId);
    
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    
    // Calculate position relative to the actual displayed image size
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    setCurrentPath([{ x, y }]);
  };

  const handleDrawMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || myMode !== "presenting" || !currentDrawingId) return;
    
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    
    // Calculate position relative to the actual displayed image size
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    const newPath = [...currentPath, { x, y }];
    setCurrentPath(newPath);
    
    // Emit real-time drawing update with slide index and drawing ID
    getSocket().emit("draw", { roomId, path: newPath, slideIndex: currentSlide, drawingId: currentDrawingId });
  };

  const handleDrawEnd = () => {
    if (!isDrawing || myMode !== "presenting") return;
    setIsDrawing(false);
    if (currentPath.length > 0 && currentDrawingId) {
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
    if (newName.trim() && newName !== userName) {
      // TODO: Emit name change to server
      getSocket().emit("update-name", { roomId, name: newName.trim() });
      setIsEditingName(false);
    }
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
    const link = `${window.location.origin}/room/${roomId}?mode=viewing&name=Guest`;
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

  const endSession = () => {
    getSocket().emit("end-session", { roomId });
    disconnectSocket();
    router.push("/");
  };

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
        </div>

        {/* Slide strip */}
        <div className={styles.slideStrip}>
          {slideUrls.map((src, i) => (
            <button
              key={i}
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

        <div className={styles.sideBottom}>
          <div className={styles.connectionStatus}>
            <span className={connected ? "live-dot" : ""} />
            {connected ? "Connected" : "Reconnecting…"}
          </div>
          <button className="btn btn-danger" onClick={endSession} style={{ width: "100%" }}>
            Leave Session
          </button>
        </div>
      </aside>

      {/* ── Main stage ──────────────────────────────────────────────────── */}
      <div className={styles.stage}>
        <div
          ref={slideContainerRef}
          className={styles.slideWrap}
          onMouseMove={handleMouseMove}
          style={{ position: "relative", cursor: myMode === "presenting" && showCustomCursor ? "none" : "default" }}
        >
          <img
            key={slideUrl}
            src={slideUrl}
            alt={`Slide ${currentSlide + 1}`}
            className={styles.slideImg}
          />

          {/* Drawing Canvas */}
          <canvas
            ref={canvasRef}
            className={styles.drawingCanvas}
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
              cursor: drawingEnabled && myMode === "presenting" ? "crosshair" : "default",
              pointerEvents: drawingEnabled && myMode === "presenting" ? "auto" : "none",
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

          {/* My own cursor (when presenting, custom cursor enabled, and not drawing) */}
          {myMode === "presenting" && myCursor && showCustomCursor && !drawingEnabled && (
            <div
              className={styles.remoteCursor}
              style={{
                left: `${myCursor.x}%`,
                top: `${myCursor.y}%`,
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
              className={`btn ${drawingEnabled ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setDrawingEnabled(!drawingEnabled)}
              title="Toggle drawing mode"
            >
              {drawingEnabled ? "✏️ Drawing" : "✏️ Pen"}
            </button>

            <button
              className={`btn ${showCustomCursor ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowCustomCursor(!showCustomCursor)}
              title="Toggle custom cursor"
            >
              {showCustomCursor ? "🖱️ Custom" : "🖱️ Default"}
            </button>

            {drawings.length > 0 && (
              <button className="btn btn-ghost" onClick={clearAllDrawings}>
                🗑️ Clear
              </button>
            )}

            <button className="btn btn-ghost" onClick={toggleFullscreen}>
              {isFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}
            </button>

            <button
              className="btn btn-primary"
              onClick={() => goTo(currentSlide + 1)}
              disabled={currentSlide === state.totalSlides - 1}
            >
              Next →
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
              {isFullscreen ? "⛶ Exit Fullscreen" : "⛶ Fullscreen"}
            </button>
          </div>
        )}

        <p className={styles.keyHint}>
          {myMode === "presenting"
            ? "← → or Spacebar to navigate · F for fullscreen"
            : "Press F for fullscreen"}
        </p>
      </div>
    </div>
  );
}
