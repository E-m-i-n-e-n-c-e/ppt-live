import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readdir, copyFile, unlink } from "fs/promises";
import path from "path";
import { customAlphabet } from "nanoid";

const execAsync = promisify(exec);
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

// Try LibreOffice in several known locations
const LIBRE_OFFICE_PATHS = [
  "libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/libreoffice",
];

async function convertPptx(pptxPath: string, outDir: string): Promise<void> {
  for (const bin of LIBRE_OFFICE_PATHS) {
    try {
      await execAsync(`"${bin}" --headless --convert-to png --outdir "${outDir}" "${pptxPath}"`);
      return;
    } catch {
      // try next path
    }
  }
  throw new Error("LibreOffice not found");
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!file.name.match(/\.pptx?$/i)) {
      return NextResponse.json({ error: "Only .pptx files are supported" }, { status: 400 });
    }

    const roomId = nanoid();
    const tmpDir = `/tmp/ppt-live-${roomId}`;
    const publicDir = path.join(process.cwd(), "public", "rooms", roomId);

    await mkdir(tmpDir, { recursive: true });
    await mkdir(publicDir, { recursive: true });

    // Write uploaded file to disk
    const buffer = Buffer.from(await file.arrayBuffer());
    const pptxPath = path.join(tmpDir, "presentation.pptx");
    await writeFile(pptxPath, buffer);

    // Convert to PNGs
    try {
      await convertPptx(pptxPath, tmpDir);
    } catch {
      return NextResponse.json(
        {
          error:
            "LibreOffice is required to convert slides. Install it with: brew install --cask libreoffice",
          libreofficeRequired: true,
        },
        { status: 500 }
      );
    }

    // Move generated PNGs to public/rooms/[roomId]/
    const allFiles = await readdir(tmpDir);
    const pngs = allFiles
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pngs.length === 0) {
      return NextResponse.json(
        { error: "Conversion produced no slides. Is the file a valid PPTX?" },
        { status: 500 }
      );
    }

    const slides: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const src = path.join(tmpDir, pngs[i]);
      const dest = path.join(publicDir, `slide-${i + 1}.png`);
      // Use copyFile instead of rename for cross-device compatibility
      await copyFile(src, dest);
      await unlink(src); // Clean up temp file after copying
      slides.push(`/rooms/${roomId}/slide-${i + 1}.png`);
    }

    // Write manifest so server.ts can lazy-load this room
    const manifest = { roomId, slides, totalSlides: slides.length, currentSlide: 0 };
    await writeFile(path.join(publicDir, "manifest.json"), JSON.stringify(manifest));

    return NextResponse.json({ roomId, slides, totalSlides: slides.length });
  } catch (err) {
    console.error("[upload]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
