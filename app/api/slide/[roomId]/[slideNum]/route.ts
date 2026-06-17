import { NextRequest, NextResponse } from "next/server";
import { getSlide, roomExists } from "@/lib/room-store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string; slideNum: string }> }
) {
  try {
    const { roomId, slideNum } = await params;
    
    // Validate inputs
    if (!roomId || !slideNum) {
      return new NextResponse("Invalid parameters", { status: 400 });
    }

    // Check if room exists in Redis
    const exists = await roomExists(roomId);
    if (!exists) {
      return new NextResponse("Room not found", { status: 404 });
    }

    const slideIndex = parseInt(slideNum, 10) - 1; // Convert to 0-indexed
    if (isNaN(slideIndex) || slideIndex < 0) {
      return new NextResponse("Invalid slide number", { status: 404 });
    }

    // Get slide from Redis
    const slideBuffer = await getSlide(roomId, slideIndex);
    
    if (!slideBuffer) {
      return new NextResponse("Slide not found", { status: 404 });
    }

    // Return the image - convert Buffer to Uint8Array for NextResponse
    return new NextResponse(new Uint8Array(slideBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[slide-api] Error:", error);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
