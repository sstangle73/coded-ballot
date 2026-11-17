// Getting pictures in: the phone camera (live, for receipts; a still, for counting) and image files from a scanner.
// Every image is redrawn on a canvas and saved again as JPEG before it is stored, which drops its metadata (a phone
// photo's location, for one).
import jsQR from 'jsqr';
import { sha256Hex, toGray, type GrayImage, type Point } from '@coded-ballot/core';

export interface Picture {
  gray: GrayImage;
  rgba: ImageData;
  /** The cleaned JPEG that gets stored, and its SHA-256. */
  jpeg: Blob;
  sha256: string;
}

export interface QrFound {
  text: string;
  centre: Point;
}

function qrAt(img: ImageData, scale: number): QrFound | null {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!r) return null;
  const l = r.location;
  const pts = [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner];
  return { text: r.data, centre: { x: pts.reduce((a, p) => a + p.x, 0) / 4 / scale, y: pts.reduce((a, p) => a + p.y, 0) / 4 / scale } };
}

/**
 * Find a QR code in a frame. jsQR misses some codes in large, slightly skewed photos that it reads once the image is
 * smaller, so it tries a few sizes. The centre is given in the full image's pixels.
 */
export function findQr(img: ImageData): QrFound | null {
  const found = qrAt(img, 1);
  if (found) return found;
  const full = document.createElement('canvas');
  full.width = img.width;
  full.height = img.height;
  full.getContext('2d')!.putImageData(img, 0, 0);
  for (const side of [1200, 900, 650]) {
    const k = side / Math.max(img.width, img.height);
    if (k >= 1) continue;
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(full, 0, 0, c.width, c.height);
    const r = qrAt(ctx.getImageData(0, 0, c.width, c.height), c.width / img.width);
    if (r) return r;
  }
  return null;
}

/** Draw any image source at no more than `maxSide` pixels on its long side. */
function draw(src: CanvasImageSource & { width: number; height: number }, w: number, h: number, maxSide: number) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

async function finish(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<Picture> {
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('Couldn’t save the image.'))), 'image/jpeg', 0.85));
  return { gray: toGray(rgba.data, rgba.width, rgba.height), rgba, jpeg, sha256: sha256Hex(new Uint8Array(await jpeg.arrayBuffer())) };
}

/** A scanner's image file or a photo picked from the phone. About 200 dpi is plenty for a letter sheet. */
export async function fromFile(file: File, maxSide = 2200): Promise<Picture> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { canvas, ctx } = draw(bmp, bmp.width, bmp.height, maxSide);
  bmp.close();
  return finish(canvas, ctx);
}

/** A still from the live camera. */
export async function fromVideo(video: HTMLVideoElement, maxSide = 2200): Promise<Picture> {
  const { canvas, ctx } = draw(video, video.videoWidth, video.videoHeight, maxSide);
  return finish(canvas, ctx);
}

/** The camera, rear-facing where there is one. Stop it with stopCamera. */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera here. The page must be opened over https.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null) {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

/** Read QR codes from the live camera until stopped; each new code (not seen in the last few seconds) is passed on. */
export function watchQr(video: HTMLVideoElement, onCode: (text: string) => Promise<void> | void): () => void {
  let stopped = false;
  let busy = false;
  const recent = new Map<string, number>();
  const { canvas, ctx } = draw(video, 1, 1, 1);
  const tick = async () => {
    if (stopped) return;
    if (!busy && video.videoWidth) {
      const k = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = findQr(ctx.getImageData(0, 0, canvas.width, canvas.height));
      const now = Date.now();
      if (found && (recent.get(found.text) ?? 0) < now - 4000) {
        recent.set(found.text, now);
        busy = true;
        try {
          await onCode(found.text);
        } finally {
          busy = false;
        }
      }
    }
    setTimeout(tick, 150);
  };
  tick();
  return () => {
    stopped = true;
  };
}
