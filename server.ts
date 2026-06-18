import { createServer } from "http";
import { Server, Socket } from "socket.io";
import next from "next";
import express, { Request, Response } from "express";
import { 
  roomExists, 
  getRoomMeta, 
  updateCurrentSlide,
  addParticipant,
  removeParticipant,
  getParticipants,
  updateParticipant,
  type Participant 
} from "./lib/room-store";

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

// ─── Bootstrap ────────────────────────────────────────────────────────────────

nextApp.prepare().then(() => {
  const app = express();
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  // ─── Socket Events ───────────────────────────────────────────────────────────

  io.on("connection", (socket: Socket) => {
    console.log(`[WS] Connected: ${socket.id}`);

    socket.on(
      "join-room",
      async ({
        roomId,
        name,
        mode = "viewing",
      }: {
        roomId: string;
        name: string;
        mode?: "presenting" | "viewing";
      }) => {
        // Check if room exists in Redis
        const exists = await roomExists(roomId);
        if (!exists) {
          console.log(`[WS] Room ${roomId} not found in Redis`);
          socket.emit("error", { message: "Room not found" });
          return;
        }

        const roomMeta = await getRoomMeta(roomId);
        if (!roomMeta) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        socket.join(roomId);
        
        const participant: Participant = { id: socket.id, name, mode };
        addParticipant(roomId, participant);
        socket.data = { roomId, name, mode };

        console.log(`[WS] "${name}" joined room ${roomId} in ${mode} mode`);

        // Broadcast to others
        const participants = getParticipants(roomId);
        io.to(roomId).emit("participant-joined", { participant });

        // Send current state to the new participant
        socket.emit("room-state", {
          currentSlide: roomMeta.currentSlide,
          totalSlides: roomMeta.totalSlides,
          slides: roomMeta.totalSlides, // Just send count
          participants,
          activePresenter: null, // TODO: track active presenter
        });
      }
    );

    socket.on(
      "toggle-mode",
      ({ roomId, mode }: { roomId: string; mode: "presenting" | "viewing" }) => {
        const participants = getParticipants(roomId);
        const participant = participants.find(p => p.id === socket.id);
        if (!participant) return;

        participant.mode = mode;
        updateParticipant(roomId, participant);

        io.to(roomId).emit("participant-updated", { participant });
        console.log(`[WS] ${participant.name} switched to ${mode} mode`);
      }
    );

    socket.on(
      "update-name",
      ({ roomId, name }: { roomId: string; name: string }) => {
        const participants = getParticipants(roomId);
        const participant = participants.find(p => p.id === socket.id);
        if (!participant) return;

        const oldName = participant.name;
        participant.name = name;
        socket.data.name = name;
        updateParticipant(roomId, participant);

        io.to(roomId).emit("participant-updated", { participant });
        console.log(`[WS] ${oldName} changed name to ${name}`);
      }
    );

    socket.on(
      "slide-change",
      async ({ roomId, slideIndex }: { roomId: string; slideIndex: number }) => {
        const participants = getParticipants(roomId);
        const participant = participants.find(p => p.id === socket.id);
        if (!participant || participant.mode !== "presenting") return;

        await updateCurrentSlide(roomId, slideIndex);
        io.to(roomId).emit("slide-update", { slideIndex, presenterId: socket.id });
        console.log(`[WS] Room ${roomId}: slide → ${slideIndex} by ${participant.name}`);
      }
    );

    socket.on(
      "cursor-move",
      ({ roomId, x, y }: { roomId: string; x: number; y: number }) => {
        const participants = getParticipants(roomId);
        const participant = participants.find(p => p.id === socket.id);
        if (!participant || participant.mode !== "presenting") return;

        participant.cursorX = x;
        participant.cursorY = y;
        updateParticipant(roomId, participant);

        // Broadcast cursor position to others
        socket.to(roomId).emit("cursor-update", {
          participantId: socket.id,
          name: participant.name,
          x,
          y,
        });
      }
    );

    socket.on("cursor-hide", ({ roomId }: { roomId: string }) => {
      const participants = getParticipants(roomId);
      const participant = participants.find(p => p.id === socket.id);
      if (!participant || participant.mode !== "presenting") return;

      socket.to(roomId).emit("cursor-hide", { participantId: socket.id });
    });

    socket.on(
      "draw",
      ({
        roomId,
        path,
        slideIndex,
        drawingId,
      }: {
        roomId: string;
        path: { x: number; y: number }[];
        slideIndex: number;
        drawingId?: string;
      }) => {
        const participants = getParticipants(roomId);
        const participant = participants.find(p => p.id === socket.id);
        if (!participant || participant.mode !== "presenting") return;

        // Broadcast drawing to all participants with slide index and drawing ID
        io.to(roomId).emit("draw-update", {
          participantId: socket.id,
          name: participant.name,
          path,
          slideIndex,
          drawingId,
        });
      }
    );

    socket.on("clear-drawings", ({ roomId, slideIndex }: { roomId: string; slideIndex: number }) => {
      const participants = getParticipants(roomId);
      const participant = participants.find(p => p.id === socket.id);
      if (!participant || participant.mode !== "presenting") return;

      io.to(roomId).emit("clear-drawings", { slideIndex });
      console.log(`[WS] Drawings cleared on slide ${slideIndex} by ${participant.name}`);
    });

    socket.on("end-session", ({ roomId }: { roomId: string }) => {
      const participants = getParticipants(roomId);
      const participant = participants.find(p => p.id === socket.id);
      if (!participant) return;

      io.to(roomId).emit("session-ended", {});
      console.log(`[WS] Room ${roomId} ended by ${participant.name}`);
    });

    socket.on("disconnect", () => {
      const { roomId, name } = (socket.data ?? {}) as {
        roomId?: string;
        name?: string;
      };
      if (!roomId) return;

      removeParticipant(roomId, socket.id);
      io.to(roomId).emit("participant-left", { id: socket.id, name });
      console.log(`[WS] ${name} left room ${roomId}`);
    });
  });

  // ─── HTTP ────────────────────────────────────────────────────────────────────

  app.all("/{*path}", (req: Request, res: Response) => {
    handle(req, res);
  });

  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀  ppt-live running at http://0.0.0.0:${PORT}\n`);
  });
});
