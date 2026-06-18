// ─── Redis-Backed Room Store ──────────────────────────────────────────────────
// Shared state across all processes and instances via Redis

import Redis from "ioredis";

export interface Participant {
  id: string;
  name: string;
  mode: "presenting" | "viewing";
  cursorX?: number;
  cursorY?: number;
}

export interface Room {
  slides: Buffer[]; // Store images as Buffers
  totalSlides: number;
  currentSlide: number;
  participants: Map<string, Participant>;
  activePresenter: string | null;
}

// Redis client singleton
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL environment variable is not set");
    }
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    console.log("[redis] Connected to Redis");
  }
  return redis;
}

// Helper to create a new room
export async function createRoom(roomId: string, slides: Buffer[]): Promise<Room> {
  const redis = getRedis();
  
  // Store each slide as a separate key for efficient retrieval
  const pipeline = redis.pipeline();
  
  slides.forEach((slide, index) => {
    pipeline.setex(
      `room:${roomId}:slide:${index}`,
      3600 * 24, // 24 hour TTL
      slide
    );
  });
  
  // Store room metadata
  const metadata = {
    totalSlides: slides.length,
    currentSlide: 0,
    activePresenter: null,
    createdAt: Date.now(),
  };
  
  pipeline.setex(
    `room:${roomId}:meta`,
    3600 * 24, // 24 hour TTL
    JSON.stringify(metadata)
  );
  
  await pipeline.exec();
  
  console.log(`[redis] Created room ${roomId} with ${slides.length} slides`);
  
  return {
    slides,
    totalSlides: slides.length,
    currentSlide: 0,
    participants: new Map(),
    activePresenter: null,
  };
}

// Helper to get a room's metadata
export async function getRoomMeta(roomId: string): Promise<{ totalSlides: number; currentSlide: number } | null> {
  const redis = getRedis();
  const metaJson = await redis.get(`room:${roomId}:meta`);
  
  if (!metaJson) {
    return null;
  }
  
  const meta = JSON.parse(metaJson);
  return {
    totalSlides: meta.totalSlides,
    currentSlide: meta.currentSlide,
  };
}

// Helper to get a specific slide
export async function getSlide(roomId: string, slideIndex: number): Promise<Buffer | null> {
  const redis = getRedis();
  const slideBuffer = await redis.getBuffer(`room:${roomId}:slide:${slideIndex}`);
  return slideBuffer;
}

// Helper to check if room exists
export async function roomExists(roomId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`room:${roomId}:meta`);
  return exists === 1;
}

// Helper to update current slide
export async function updateCurrentSlide(roomId: string, slideIndex: number): Promise<void> {
  const redis = getRedis();
  const metaJson = await redis.get(`room:${roomId}:meta`);
  
  if (metaJson) {
    const meta = JSON.parse(metaJson);
    meta.currentSlide = slideIndex;
    await redis.setex(`room:${roomId}:meta`, 3600 * 24, JSON.stringify(meta));
  }
}

// Helper to delete a room
export async function deleteRoom(roomId: string): Promise<void> {
  const redis = getRedis();
  
  // Get total slides to know how many keys to delete
  const metaJson = await redis.get(`room:${roomId}:meta`);
  if (!metaJson) return;
  
  const meta = JSON.parse(metaJson);
  const keys = [`room:${roomId}:meta`];
  
  for (let i = 0; i < meta.totalSlides; i++) {
    keys.push(`room:${roomId}:slide:${i}`);
  }
  
  await redis.del(...keys);
  console.log(`[redis] Deleted room ${roomId}`);
}

// In-memory participant tracking (WebSocket connections are process-local)
const participantsByRoom = new Map<string, Map<string, Participant>>();

export function addParticipant(roomId: string, participant: Participant): void {
  if (!participantsByRoom.has(roomId)) {
    participantsByRoom.set(roomId, new Map());
  }
  participantsByRoom.get(roomId)!.set(participant.id, participant);
}

export function removeParticipant(roomId: string, participantId: string): void {
  const participants = participantsByRoom.get(roomId);
  if (participants) {
    participants.delete(participantId);
    if (participants.size === 0) {
      participantsByRoom.delete(roomId);
    }
  }
}

export function getParticipants(roomId: string): Participant[] {
  const participants = participantsByRoom.get(roomId);
  return participants ? Array.from(participants.values()) : [];
}

export function updateParticipant(roomId: string, participant: Participant): void {
  const participants = participantsByRoom.get(roomId);
  if (participants) {
    participants.set(participant.id, participant);
  }
}
