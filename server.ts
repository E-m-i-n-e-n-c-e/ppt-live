import { createServer } from "http";
import { Server, Socket } from "socket.io";
import next from "next";
import express, { Request, Response } from "express";
import { readFile } from "fs/promises";
import path from "path";

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

// ─── Types ────────────────────────────────────────────────────────────────────

interface Viewer {
  id: string;
  name: string;
}

interface Room {
  slides: string[];
  totalSlides: number;
  currentSlide: number;
  presenter: { id: string; name: string } | null;
  viewers: Map<string, string>; // socketId → name
}

// ─── Global Room Store ────────────────────────────────────────────────────────

export const rooms = new Map<string, Room>();

async function loadRoomFromManifest(roomId: string): Promise<Room | null> {
  try {
    const manifestPath = path.join(
      process.cwd(),
      "public",
      "rooms",
      roomId,
      "manifest.json"
    );
    const raw = await readFile(manifestPath, "utf-8");
    const data = JSON.parse(raw) as { slides: string[]; totalSlides: number };
    return {
      slides: data.slides,
      totalSlides: data.totalSlides,
      currentSlide: 0,
      presenter: null,
      viewers: new Map(),
    };
  } catch {
    return null;
  }
}

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
        role,
      }: {
        roomId: string;
        name: string;
        role: "presenter" | "viewer";
      }) => {
        // Lazy-load room from manifest if not in memory
        if (!rooms.has(roomId)) {
          const loaded = await loadRoomFromManifest(roomId);
          if (!loaded) {
            socket.emit("error", { message: "Room not found" });
            return;
          }
          rooms.set(roomId, loaded);
        }

        const room = rooms.get(roomId)!;
        socket.join(roomId);
        socket.data = { roomId, name, role };

        if (role === "presenter") {
          room.presenter = { id: socket.id, name };
          console.log(`[WS] Presenter "${name}" joined room ${roomId}`);
        } else {
          room.viewers.set(socket.id, name);
          io.to(roomId).emit("viewer-joined", { id: socket.id, name });
          console.log(`[WS] Viewer "${name}" joined room ${roomId}`);
        }

        const viewers: Viewer[] = Array.from(room.viewers.entries()).map(
          ([id, n]) => ({ id, name: n })
        );

        socket.emit("room-state", {
          currentSlide: room.currentSlide,
          totalSlides: room.totalSlides,
          slides: room.slides,
          presenterName: room.presenter?.name ?? "Unknown",
          viewers,
        });
      }
    );

    socket.on(
      "slide-change",
      ({ roomId, slideIndex }: { roomId: string; slideIndex: number }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.presenter?.id !== socket.id) return;

        room.currentSlide = slideIndex;
        io.to(roomId).emit("slide-update", { slideIndex });
        console.log(`[WS] Room ${roomId}: slide → ${slideIndex}`);
      }
    );

    socket.on("end-session", ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.presenter?.id !== socket.id) return;

      io.to(roomId).emit("session-ended", {});
      rooms.delete(roomId);
      console.log(`[WS] Room ${roomId} ended by presenter`);
    });

    socket.on("disconnect", () => {
      const { roomId, name, role } = (socket.data ?? {}) as {
        roomId?: string;
        name?: string;
        role?: string;
      };
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      if (role === "viewer") {
        room.viewers.delete(socket.id);
        io.to(roomId).emit("viewer-left", { id: socket.id, name });
        console.log(`[WS] Viewer "${name}" left room ${roomId}`);
      } else if (role === "presenter") {
        io.to(roomId).emit("session-ended", {});
        rooms.delete(roomId);
        console.log(`[WS] Presenter disconnected — room ${roomId} closed`);
      }
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
