import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readdir, readFile, unlink } from "fs/promises";
import path from "path";
import { customAlphabet } from "nanoid";
import { createRoom } from "@/lib/room-store";

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

async function convertPdf(pdfPath: string, outDir: string): Promise<void> {
  // Use pdftoppm from poppler-utils (available in Docker)
  // -png: output format
  // -r 150: resolution (DPI) for better quality
  try {
    // pdftoppm outputs files as prefix-pagenum.png (e.g., page-1.png, page-2.png)
    await execAsync(
      `pdftoppm -png -r 150 "${pdfPath}" "${path.join(outDir, "page")}"`
    );
  } catch (error: any) {
    console.error("[convertPdf] Error:", error.message);
    throw new Error(`PDF conversion failed: ${error.message}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const isPdf = file.name.match(/\.pdf$/i);
    const isPptx = file.name.match(/\.pptx?$/i);

    if (!isPdf && !isPptx) {
      return NextResponse.json(
        { error: "Only .pptx and .pdf files are supported" },
        { status: 400 }
      );
    }

    const roomId = nanoid();
    const tmpDir = `/tmp/ppt-live-${roomId}`;

    await mkdir(tmpDir, { recursive: true });

    // Write uploaded file to disk (temporarily for conversion)
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = isPdf ? "pdf" : "pptx";
    const filePath = path.join(tmpDir, `presentation.${ext}`);
    await writeFile(filePath, buffer);

    // Convert to PNGs based on file type
    try {
      if (isPdf) {
        await convertPdf(filePath, tmpDir);
      } else {
        await convertPptx(filePath, tmpDir);
      }
    } catch (error) {
      const errorMsg = isPdf
        ? "PDF conversion failed. Please ensure the PDF is valid."
        : "LibreOffice is required to convert slides. Install it with: brew install --cask libreoffice";
      
      return NextResponse.json(
        {
          error: errorMsg,
          libreofficeRequired: !isPdf,
        },
        { status: 500 }
      );
    }

    // Load generated PNGs into memory
    const allFiles = await readdir(tmpDir);
    const pngs = allFiles
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pngs.length === 0) {
      return NextResponse.json(
        { error: `Conversion produced no slides. Is the file a valid ${isPdf ? "PDF" : "PPTX"}?` },
        { status: 500 }
      );
    }

    // Read all slides into memory as Buffers
    const slideBuffers: Buffer[] = [];
    for (const png of pngs) {
      const pngPath = path.join(tmpDir, png);
      const imageBuffer = await readFile(pngPath);
      slideBuffers.push(imageBuffer);
      await unlink(pngPath); // Clean up immediately after reading
    }

    // Store room in Redis (accessible from all processes/instances)
    await createRoom(roomId, slideBuffers);

    console.log(`[upload] Room ${roomId} created with ${slideBuffers.length} slides`);

    // Clean up temp directory
    await unlink(filePath).catch(() => {}); // Clean up source file

    return NextResponse.json({ 
      roomId, 
      totalSlides: slideBuffers.length,
      slides: slideBuffers.length, // Just return count
    });
  } catch (err) {
    console.error("[upload]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
