"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getSocket, disconnectSocket } from "@/lib/socket";
import styles from "./room.module.css";

interface Viewer {
  id: string;
  name: string;
}

interface RoomState {
  currentSlide: number;
  totalSlides: number;
  slides: string[];
  viewers: Viewer[];
}

export default function PresenterRoom() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const roomId = params.roomId as string;
  const presenterName = searchParams.get("name") ?? "Presenter";

  const [state, setState] = useState<RoomState | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-room", { roomId, name: presenterName, role: "presenter" });
    });

    socket.on("room-state", (data: RoomState) => {
      setState(data);
      setCurrentSlide(data.currentSlide);
      setViewers(data.viewers);
    });

    socket.on("viewer-joined", (viewer: Viewer) => {
      setViewers((prev) => [...prev.filter((v) => v.id !== viewer.id), viewer]);
    });

    socket.on("viewer-left", ({ id }: { id: string }) => {
      setViewers((prev) => prev.filter((v) => v.id !== id));
    });

    socket.on("session-ended", () => setEnded(true));

    if (socket.connected) {
      setConnected(true);
      socket.emit("join-room", { roomId, name: presenterName, role: "presenter" });
    }

    return () => {
      socket.off("connect");
      socket.off("room-state");
      socket.off("viewer-joined");
      socket.off("viewer-left");
      socket.off("session-ended");
    };
  }, [roomId, presenterName]);

  // ── Keyboard navigation ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") goTo(currentSlide + 1);
      if (e.key === "ArrowLeft") goTo(currentSlide - 1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlide, state]);

  const goTo = useCallback(
    (idx: number) => {
      if (!state) return;
      const clamped = Math.max(0, Math.min(idx, state.totalSlides - 1));
      if (clamped === currentSlide) return;
      setCurrentSlide(clamped);
      getSocket().emit("slide-change", { roomId, slideIndex: clamped });
    },
    [state, currentSlide, roomId]
  );

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyJoinLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/view/${roomId}`);
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
        <button className="btn btn-primary" onClick={() => router.push("/")}>Back to Home</button>
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

  const slideUrl = state.slides[currentSlide];

  return (
    <div className={styles.root}>
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sideTop}>
          <a href="/" className={styles.logo}>ppt-live</a>

          {/* Room code */}
          <div className={styles.codeCard}>
            <div className={styles.codeLabel}>
              <span className="live-dot" />
              Room Code
            </div>
            <div className={styles.code}>{roomId}</div>
            <div className={styles.codeActions}>
              <button className="btn btn-ghost" onClick={copyRoomCode} style={{ flex: 1, fontSize: 12 }}>
                {copied ? "✓ Copied" : "Copy Code"}
              </button>
              <button className="btn btn-ghost" onClick={copyJoinLink} style={{ flex: 1, fontSize: 12 }}>
                Copy Link
              </button>
            </div>
          </div>

          {/* Viewers */}
          <div className={styles.viewersSection}>
            <div className={styles.viewersHeader}>
              <span>Viewers</span>
              <span className="badge badge-accent">{viewers.length}</span>
            </div>
            <div className={styles.viewersList}>
              {viewers.length === 0 ? (
                <p className={styles.noViewers}>Waiting for viewers…</p>
              ) : (
                viewers.map((v) => (
                  <div key={v.id} className={styles.viewer}>
                    <div className={styles.avatar}>{v.name[0].toUpperCase()}</div>
                    <span>{v.name}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Slide strip */}
        <div className={styles.slideStrip}>
          {state.slides.map((src, i) => (
            <button
              key={i}
              className={`${styles.stripThumb} ${i === currentSlide ? styles.stripActive : ""}`}
              onClick={() => goTo(i)}
              title={`Slide ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Slide ${i + 1}`} />
              <span className={styles.thumbNum}>{i + 1}</span>
            </button>
          ))}
        </div>

        <div className={styles.sideBottom}>
          <div className={styles.connectionStatus}>
            <span className={connected ? "live-dot" : ""} style={!connected ? { width: 7, height: 7, borderRadius: "50%", background: "var(--red)", display: "inline-block" } : {}} />
            {connected ? "Connected" : "Reconnecting…"}
          </div>
          <button className="btn btn-danger" onClick={endSession} style={{ width: "100%" }}>
            End Session
          </button>
        </div>
      </aside>

      {/* ── Main stage ──────────────────────────────────────────────────── */}
      <div className={styles.stage}>
        <div className={styles.slideWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={slideUrl}
            src={slideUrl}
            alt={`Slide ${currentSlide + 1}`}
            className={styles.slideImg}
          />
        </div>

        {/* Controls */}
        <div className={styles.controls}>
          <button
            id="prev-btn"
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
            id="next-btn"
            className="btn btn-primary"
            onClick={() => goTo(currentSlide + 1)}
            disabled={currentSlide === state.totalSlides - 1}
          >
            Next →
          </button>
        </div>

        <p className={styles.keyHint}>← → or Spacebar to navigate</p>
      </div>
    </div>
  );
}
