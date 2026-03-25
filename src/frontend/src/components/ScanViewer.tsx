import { useCallback, useEffect, useRef } from "react";

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Finding {
  name: string;
  confidence: number;
  bbox: BBox;
}

interface ScanViewerProps {
  imageUrl: string;
  findings: Finding[];
}

export function ScanViewer({ imageUrl, findings }: ScanViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const w = img.clientWidth;
    const h = img.clientHeight;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    for (const f of findings) {
      const x = (f.bbox.x / 100) * w;
      const y = (f.bbox.y / 100) * h;
      const bw = (f.bbox.w / 100) * w;
      const bh = (f.bbox.h / 100) * h;

      ctx.strokeStyle = "#FF4D4D";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, bw, bh);

      const label = `${f.name} ${f.confidence}%`;
      ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
      const textW = ctx.measureText(label).width + 8;
      ctx.fillStyle = "rgba(239, 68, 68, 0.85)";
      ctx.fillRect(x, y - 20, textW, 20);

      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(label, x + 4, y - 5);
    }
  }, [findings]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete) {
      drawBoxes();
    } else {
      img.onload = drawBoxes;
    }
  }, [drawBoxes]);

  useEffect(() => {
    const handleResize = () => drawBoxes();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawBoxes]);

  return (
    <div className="relative w-full" style={{ background: "#000" }}>
      <img
        ref={imgRef}
        src={imageUrl}
        alt="Medical scan"
        className="w-full h-auto block"
        style={{ maxHeight: "420px", objectFit: "contain" }}
        onLoad={drawBoxes}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
