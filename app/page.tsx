"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function HomePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  // Join state
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinError, setJoinError] = useState("");

  // ── Upload ─────────────────────────────────────────────────────────────────

  const handleFile = useCallback((f: File) => {
    if (!f.name.match(/\.pdf$/i)) {
      setUploadError("Only .pdf files are supported");
      return;
    }
    setFile(f);
    setUploadError("");
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError("");

    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
        return;
      }

      router.push(`/room/${data.roomId}?mode=presenting&name=Presenter`);
    } catch {
      setUploadError("Network error. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  // ── Join ───────────────────────────────────────────────────────────────────

  const handleJoin = async () => {
    const code = joinCode.trim().toUpperCase();
    const name = joinName.trim();

    if (!code || code.length < 4) {
      setJoinError("Enter a valid room code");
      return;
    }
    if (!name) {
      setJoinError("Enter your display name");
      return;
    }

    router.push(`/room/${code}?mode=viewing&tempName=${encodeURIComponent(name)}`);
  };

  return (
    <div className={styles.root}>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div className={styles.hero}>
        <div className={styles.logoBadge}>
          <span className="live-dot" />
          Live Presentations
        </div>
        <h1 className={styles.heading}>
          Present your slides,
          <br />
          <span className={styles.gradient}>live & in sync</span>
        </h1>
        <p className={styles.sub}>
          Upload a PDF, share a 6-character code. Everyone can view or present — 
          switch modes anytime, no rigid roles.
        </p>
      </div>

      {/* ── Cards ─────────────────────────────────────────────────────────── */}
      <div className={styles.cards}>
        {/* Upload card */}
        <div className={`${styles.card} card fade-up`}>
          <div className={styles.cardHeader}>
            <div className={styles.iconWrap} style={{ background: "rgba(99,102,241,0.12)" }}>
              <UploadIcon />
            </div>
            <div>
              <h2 className={styles.cardTitle}>Start a Presentation</h2>
              <p className={styles.cardSub}>Upload your .pdf and get a live room code</p>
            </div>
          </div>

          <div
            id="drop-zone"
            className={`${styles.dropZone} ${isDragging ? styles.dragging : ""} ${file ? styles.hasFile : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            {file ? (
              <>
                <PptIcon />
                <p className={styles.fileName}>{file.name}</p>
                <p className={styles.fileSize}>{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              </>
            ) : (
              <>
                <div className={styles.dropIcon}><CloudIcon /></div>
                <p className={styles.dropText}>Drop your .pdf here</p>
                <p className={styles.dropSub}>or click to browse</p>
              </>
            )}
          </div>

          {uploadError && <p className={styles.error}>{uploadError}</p>}

          <button
            id="upload-btn"
            className={`btn btn-primary ${styles.fullBtn}`}
            onClick={handleUpload}
            disabled={!file || uploading}
          >
            {uploading ? (
              <>
                <span className="spinner" />
                Converting slides…
              </>
            ) : (
              <>
                <span>🚀</span> Start Presenting
              </>
            )}
          </button>
        </div>

        {/* Divider */}
        <div className={styles.divider}>
          <span>or</span>
        </div>

        {/* Join card */}
        <div className={`${styles.card} card fade-up`} style={{ animationDelay: "0.1s" }}>
          <div className={styles.cardHeader}>
            <div className={styles.iconWrap} style={{ background: "rgba(16,185,129,0.12)" }}>
              <JoinIcon />
            </div>
            <div>
              <h2 className={styles.cardTitle}>Join a Presentation</h2>
              <p className={styles.cardSub}>Join a live session and optionally take control</p>
            </div>
          </div>

          <div className={styles.form}>
            <div className={styles.field}>
              <label htmlFor="room-code" className={styles.label}>Room Code</label>
              <input
                id="room-code"
                className="input"
                placeholder="e.g. AB3K9Z"
                value={joinCode}
                onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setJoinError(""); }}
                maxLength={8}
                style={{ fontFamily: "var(--mono)", letterSpacing: "0.15em", fontSize: 18, textAlign: "center" }}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="display-name" className={styles.label}>Your Name</label>
              <input
                id="display-name"
                className="input"
                placeholder="How should we call you?"
                value={joinName}
                onChange={(e) => { setJoinName(e.target.value); setJoinError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              />
            </div>
          </div>

          {joinError && <p className={styles.error}>{joinError}</p>}

          <button
            id="join-btn"
            className={`btn btn-primary ${styles.fullBtn}`}
            onClick={handleJoin}
            style={{ background: "var(--green)", boxShadow: "0 0 20px rgba(16,185,129,0.3)" }}
          >
            <span>👁️</span> Join Presentation
          </button>
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <p>Real-time collaboration · Shared cursors & drawing · Switch presenter mode anytime</p>
      </footer>
    </div>
  );
}

// ─── Inline SVG icons ──────────────────────────────────────────────────────────

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function JoinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </svg>
  );
}

function PptIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
    </svg>
  );
}
