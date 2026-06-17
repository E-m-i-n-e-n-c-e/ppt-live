"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getSocket, disconnectSocket } from "@/lib/socket";
import styles from "./view.module.css";

interface RoomState {
  currentSlide: number;
  totalSlides: number;
  slides: string[];
  presenterName: string;
  viewers: { id: string; name: string }[];
}

export default function ViewerPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const roomId = params.roomId as string;
  const viewerName = searchParams.get("name") ?? "Viewer";

  const [state, setState] = useState<RoomState | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [viewerCount, setViewerCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-room", { roomId, name: viewerName, role: "viewer" });
    });

    socket.on("room-state", (data: RoomState) => {
      setState(data);
      setCurrentSlide(data.currentSlide);
      setViewerCount(data.viewers.length + 1); // +1 for self
    });

    socket.on("slide-update", ({ slideIndex }: { slideIndex: number }) => {
      setCurrentSlide(slideIndex);
    });

    socket.on("viewer-joined", () => {
      setViewerCount((c) => c + 1);
    });

    socket.on("viewer-left", () => {
      setViewerCount((c) => Math.max(1, c - 1));
    });

    socket.on("session-ended", () => {
      setEnded(true);
      disconnectSocket();
    });

    socket.on("error", ({ message }: { message: string }) => {
      setError(message);
    });

    if (socket.connected) {
      setConnected(true);
      socket.emit("join-room", { roomId, name: viewerName, role: "viewer" });
    }

    return () => {
      socket.off("connect");
      socket.off("room-state");
      socket.off("slide-update");
      socket.off("viewer-joined");
      socket.off("viewer-left");
      socket.off("session-ended");
      socket.off("error");
    };
  }, [roomId, viewerName]);

  if (error) {
    return (
      <div className={styles.centered}>
        <div className={styles.errorCard}>
          <span className={styles.errorIcon}>🚫</span>
          <h2>Room Not Found</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => router.push("/")}>
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (ended) {
    return (
      <div className={styles.centered}>
        <div className={styles.endCard}>
          <span style={{ fontSize: 40 }}>👋</span>
          <h2>Presentation Ended</h2>
          <p>The presenter has ended this session.</p>
          <button className="btn btn-primary" onClick={() => router.push("/")}>
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className={styles.centered}>
        <div className={styles.loadCard}>
          <span className="spinner" style={{ width: 28, height: 28 }} />
          <p>Joining room <strong>{roomId}</strong>…</p>
        </div>
      </div>
    );
  }

  const slideUrl = state.slides[currentSlide];

  return (
    <div className={styles.root}>
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className={styles.topBar}>
        <div className={styles.presenterInfo}>
          <span className="live-dot" />
          <span className={styles.presenterName}>{state.presenterName}</span>
          <span className={styles.topBarSep}>·</span>
          <span className={styles.topBarMeta}>Live Presentation</span>
        </div>

        <div className={styles.topBarRight}>
          <span className="badge badge-accent">
            {currentSlide + 1} / {state.totalSlides}
          </span>
          <span className="badge badge-green">
            <span className="live-dot" style={{ width: 5, height: 5 }} />
            {viewerCount} watching
          </span>
          <span className={styles.viewerTag}>
            <div className={styles.viewerAvatar}>{viewerName[0].toUpperCase()}</div>
            {viewerName}
          </span>
        </div>
      </header>

      {/* ── Slide ────────────────────────────────────────────────────────── */}
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

        {/* Read-only indicator */}
        <div className={styles.syncBadge}>
          <span className="live-dot" style={{ width: 5, height: 5 }} />
          Synced with presenter
        </div>
      </div>

      {/* ── Slide progress bar ───────────────────────────────────────────── */}
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${((currentSlide + 1) / state.totalSlides) * 100}%` }}
        />
      </div>
    </div>
  );
}
