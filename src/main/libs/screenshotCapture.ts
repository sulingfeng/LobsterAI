/**
 * Screenshot capture module for LobsterAI.
 *
 * Multi-display support:
 *   1. Capture each display via desktopCapturer (cross-platform, inherits app permissions)
 *   2. Show a frameless overlay window on EACH display with its screenshot as background
 *   3. User can draw/adjust selection on any display; confirm/cancel closes all overlays
 *   4. Crop the full-resolution image from the selected display and save
 */

import {
  BrowserWindow,
  desktopCapturer,
  screen,
  app,
  systemPreferences,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreenshotCaptureOptions {
  hideWindow?: boolean;
  cwd?: string;
}

export interface ScreenshotCaptureResult {
  success: boolean;
  filePath?: string;
  dataUrl?: string;
  fileName?: string;
  error?: string;
}

interface OverlaySelectionResult {
  confirmed: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  displayIndex?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCREENSHOT_DIR_NAME = 'screenshots';
const HIDE_WINDOW_DELAY_MS = 400;
const OVERLAY_JPEG_QUALITY = 80;

let captureInProgress = false;

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export function resolveScreenshotDir(cwd?: string): string {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return path.join(resolved, '.cowork-temp', SCREENSHOT_DIR_NAME);
      }
    } catch { /* fall through */ }
  }
  return path.join(app.getPath('temp'), 'lobsterai', SCREENSHOT_DIR_NAME);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function buildFilePath(dir: string): { filePath: string; fileName: string } {
  const fileName = `screenshot-${Date.now()}.png`;
  return { filePath: path.join(dir, fileName), fileName };
}

// ---------------------------------------------------------------------------
// Screen capture via desktopCapturer (cross-platform)
// ---------------------------------------------------------------------------

async function captureAllDisplays(
  displays: Electron.Display[],
): Promise<(Electron.NativeImage | null)[]> {
  // Request a large enough thumbnail to cover the highest-res display.
  // desktopCapturer caps each source at its actual screen resolution.
  const maxPhysW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxPhysH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxPhysW, height: maxPhysH },
  });

  console.log(`[Screenshot] ${displays.length} displays, ${sources.length} sources, requested ${maxPhysW}x${maxPhysH}`);
  for (let si = 0; si < sources.length; si++) {
    const sz = sources[si].thumbnail.getSize();
    console.log(`[Screenshot]   source[${si}]: id=${sources[si].display_id}, name=${sources[si].name}, thumbnail=${sz.width}x${sz.height}, empty=${sources[si].thumbnail.isEmpty()}`);
  }
  for (let di = 0; di < displays.length; di++) {
    const d = displays[di];
    console.log(`[Screenshot]   display[${di}]: id=${d.id}, bounds=${JSON.stringify(d.bounds)}, workArea=${JSON.stringify(d.workArea)}, scaleFactor=${d.scaleFactor}`);
  }

  const result: (Electron.NativeImage | null)[] = new Array(displays.length).fill(null);
  const usedSourceIdx = new Set<number>();

  // Pass 1: match by display_id (reliable on most setups)
  for (let di = 0; di < displays.length; di++) {
    const si = sources.findIndex(
      (s, i) => !usedSourceIdx.has(i) && s.display_id === String(displays[di].id),
    );
    if (si >= 0) {
      result[di] = sources[si].thumbnail;
      usedSourceIdx.add(si);
    }
  }

  // Pass 2: match unmatched displays by thumbnail physical size
  // (works when displays have different resolutions)
  for (let di = 0; di < displays.length; di++) {
    if (result[di]) continue;
    const d = displays[di];
    const physW = Math.round(d.size.width * d.scaleFactor);
    const physH = Math.round(d.size.height * d.scaleFactor);
    const si = sources.findIndex((s, i) => {
      if (usedSourceIdx.has(i)) return false;
      const sz = s.thumbnail.getSize();
      return Math.abs(sz.width - physW) < 50 && Math.abs(sz.height - physH) < 50;
    });
    if (si >= 0) {
      result[di] = sources[si].thumbnail;
      usedSourceIdx.add(si);
    }
  }

  // Pass 3: assign remaining sources to remaining displays by order
  for (let di = 0; di < displays.length; di++) {
    if (result[di]) continue;
    for (let si = 0; si < sources.length; si++) {
      if (!usedSourceIdx.has(si)) {
        result[di] = sources[si].thumbnail;
        usedSourceIdx.add(si);
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Multi-display overlay
// ---------------------------------------------------------------------------

function showOverlaysOnAllDisplays(
  displays: Electron.Display[],
  bgDataUrls: string[],
  activeDisplayIndex: number,
  overlayBounds: Electron.Rectangle[],
): Promise<OverlaySelectionResult> {
  return new Promise((resolve) => {
    const windows: BrowserWindow[] = [];
    const tmpHtmlPaths: string[] = [];
    let settled = false;
    let loadedCount = 0;

    const closeAll = (result: OverlaySelectionResult) => {
      if (settled) return;
      settled = true;
      for (const w of windows) {
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }
      // Clean up temp HTML files
      for (const p of tmpHtmlPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
      resolve(result);
    };

    // Called each time a window finishes loading; once all are loaded,
    // show them all at once (showInactive) then focus the active one.
    const onWindowReady = () => {
      loadedCount++;
      if (loadedCount !== displays.length) return;
      if (settled) return;

      // Show all overlays without stealing focus / switching Spaces
      for (const w of windows) {
        if (!w.isDestroyed()) w.showInactive();
      }
      // Then focus the overlay on the display where the app lives,
      // so the user can immediately start drawing there.
      const activeWin = windows[activeDisplayIndex];
      if (activeWin && !activeWin.isDestroyed()) {
        activeWin.focus();
      }
    };

    for (let i = 0; i < displays.length; i++) {
      const { x, y, width, height } = overlayBounds[i];
      const isMac = process.platform === 'darwin';

      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        // No kiosk/fullscreen on any platform:
        //   macOS: conflicts with Spaces across multiple displays.
        //   Windows: kiosk forces all windows to the primary display.
        // Instead: frameless + alwaysOnTop + correct bounds per display.
        // On Windows, overlayBounds = workArea (excludes taskbar).
        // On macOS, overlayBounds = bounds (full screen).
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        hasShadow: false,
        enableLargerThanScreen: isMac,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      win.setAlwaysOnTop(true, 'screen-saver');
      if (isMac) {
        // macOS only: prevent creating a new Space for the window
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } else {
        // Windows: force bounds after creation to ensure correct positioning
        // on extended displays with potentially different DPI settings.
        // The constructor bounds may be interpreted in the primary display's DPI.
        win.setBounds({ x, y, width, height });
      }
      windows.push(win);

      const displayIndex = i;

      win.on('page-title-updated', (_event, title) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(title) as OverlaySelectionResult;
          closeAll({ ...parsed, displayIndex });
        } catch { /* ignore non-JSON */ }
      });

      win.on('closed', () => {
        if (!settled) closeAll({ confirmed: false });
      });

      const html = buildOverlayHtml(bgDataUrls[i]);
      const tmpHtmlPath = path.join(app.getPath('temp'), `lobsterai-overlay-${Date.now()}-${i}.html`);
      fs.writeFileSync(tmpHtmlPath, html, 'utf-8');
      tmpHtmlPaths.push(tmpHtmlPath);
      console.log(`[Screenshot] overlay[${i}] loading from temp file: ${tmpHtmlPath} (${html.length} bytes)`);

      // Capture console output from overlay for debugging
      win.webContents.on('console-message', (_event, level, message) => {
        console.log(`[Screenshot] overlay[${displayIndex}] console[${level}]: ${message}`);
      });

      win.loadFile(tmpHtmlPath).catch((err) => {
        console.error(`[Screenshot] overlay[${displayIndex}] loadFile failed:`, err);
      });

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.error(`[Screenshot] overlay[${displayIndex}] did-fail-load: code=${errorCode}, desc=${errorDescription}`);
      });

      win.webContents.on('did-finish-load', () => {
        if (!settled && !win.isDestroyed()) {
          onWindowReady();
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function captureScreenshot(
  mainWindow: BrowserWindow | null,
  options: ScreenshotCaptureOptions = {},
): Promise<ScreenshotCaptureResult> {
  if (captureInProgress) {
    return { success: false, error: 'Screenshot capture already in progress' };
  }
  captureInProgress = true;

  const { hideWindow = false, cwd } = options;

  try {
    // 0. Check macOS screen recording permission
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      console.log(`[Screenshot] macOS screen permission: ${status}`);
      if (status !== 'granted') {
        return { success: false, error: 'screen_permission_denied' };
      }
    }

    // 1. Hide main window if requested
    if (hideWindow && mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
      await sleep(HIDE_WINDOW_DELAY_MS);
    }

    // 2. Prepare output path
    const dir = resolveScreenshotDir(cwd);
    ensureDir(dir);
    const { filePath, fileName } = buildFilePath(dir);

    // 3. Capture every display via desktopCapturer (cross-platform)
    const displays = screen.getAllDisplays();
    console.log(`[Screenshot] platform=${process.platform}, displays=${displays.length}`);
    const images = await captureAllDisplays(displays);

    if (images.every((img) => !img || img.isEmpty())) {
      console.error('[Screenshot] All display captures failed or returned empty images');
      return { success: false, error: 'Failed to capture screen' };
    }

    // Log capture results
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img && !img.isEmpty()) {
        const sz = img.getSize();
        // Save a small debug JPEG to verify the capture is not all-black
        const debugJpeg = img.resize({ width: Math.round(sz.width / 4), height: Math.round(sz.height / 4) }).toJPEG(50);
        console.log(`[Screenshot] display[${i}] image: ${sz.width}x${sz.height}, debugJpeg=${debugJpeg.length} bytes`);
        try {
          const debugPath = path.join(app.getPath('temp'), `lobsterai-debug-${i}.jpg`);
          fs.writeFileSync(debugPath, debugJpeg);
          console.log(`[Screenshot] debug image saved: ${debugPath}`);
        } catch { /* ignore */ }
      } else {
        console.warn(`[Screenshot] display[${i}] image: null or empty`);
      }
    }

    // 4. Compute overlay bounds per display.
    //    Windows: use workArea (excludes taskbar) — avoids taskbar coverage issues
    //             and kiosk mode that forces all windows to the primary display.
    //    macOS:   use full bounds (overlay covers entire screen including menu bar).
    const isWindows = process.platform === 'win32';
    const overlayBounds: Electron.Rectangle[] = displays.map((d) =>
      isWindows ? d.workArea : d.bounds,
    );

    // 5. Downscale each display to a JPEG data URL for overlay background.
    //    Use logical resolution (not Retina physical) to keep data size manageable.
    //    On Windows, crop to workArea portion so background matches the overlay exactly.
    const bgUrls: string[] = displays.map((d, i) => {
      const img = images[i];
      if (!img || img.isEmpty()) {
        return 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
      }
      const { width: lw, height: lh } = d.size; // logical bounds size
      console.log(`[Screenshot] bgUrl[${i}] resize to ${lw}x${lh}, overlay bounds=${JSON.stringify(overlayBounds[i])}`);
      const resized = img.resize({ width: lw, height: lh });

      if (isWindows) {
        // Crop out the taskbar region — keep only the workArea portion
        const ob = overlayBounds[i];
        const b = d.bounds;
        const waCropped = resized.crop({
          x: ob.x - b.x,
          y: ob.y - b.y,
          width: ob.width,
          height: ob.height,
        });
        const jpegBuf = waCropped.toJPEG(OVERLAY_JPEG_QUALITY);
        console.log(`[Screenshot] bgUrl[${i}] JPEG bytes: ${jpegBuf.length}, cropped to ${ob.width}x${ob.height}`);
        return `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
      }

      const jpegUrl = `data:image/jpeg;base64,${resized.toJPEG(OVERLAY_JPEG_QUALITY).toString('base64')}`;
      console.log(`[Screenshot] bgUrl[${i}] length: ${jpegUrl.length}`);
      return jpegUrl;
    });

    // 6. Determine which display the main window is on
    let activeDisplayIndex = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const appDisplay = screen.getDisplayMatching(mainWindow.getBounds());
      const idx = displays.findIndex((d) => d.id === appDisplay.id);
      if (idx >= 0) activeDisplayIndex = idx;
    }

    // 7. Show overlays on ALL displays
    const result = await showOverlaysOnAllDisplays(displays, bgUrls, activeDisplayIndex, overlayBounds);

    // 8. Restore main window
    if (hideWindow && mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }

    if (!result.confirmed || !result.rect || result.displayIndex == null) {
      return { success: false, error: 'cancelled' };
    }

    const { x: rx, y: ry, width: rw, height: rh } = result.rect;
    if (rw < 1 || rh < 1) {
      return { success: false, error: 'cancelled' };
    }

    // 9. Release NativeImages for non-selected displays to reduce peak memory
    const fullImg = images[result.displayIndex];
    for (let i = 0; i < images.length; i++) {
      if (i !== result.displayIndex) images[i] = null;
    }
    if (!fullImg || fullImg.isEmpty()) {
      return { success: false, error: 'Failed to capture selected display' };
    }

    // 10. Crop from full-resolution image.
    //     The overlay sends raw CSS coordinates relative to the overlay window.
    //     Compute scale from actual capture image size vs overlay (display) bounds,
    //     because desktopCapturer thumbnail resolution may not match display.bounds * scaleFactor
    //     (e.g. non-Retina external display connected to a Retina MacBook).
    const imgSize = fullImg.getSize();
    const ob = overlayBounds[result.displayIndex];
    const scaleX = imgSize.width / ob.width;
    const scaleY = imgSize.height / ob.height;
    console.log(`[Screenshot] crop: imgSize=${imgSize.width}x${imgSize.height}, overlayBounds=${ob.width}x${ob.height}, scale=${scaleX.toFixed(3)}x${scaleY.toFixed(3)}`);

    let cssX = rx;
    let cssY = ry;
    if (isWindows) {
      // On Windows, overlay covers workArea; offset to full capture image coordinates
      const d = displays[result.displayIndex];
      cssX += d.workArea.x - d.bounds.x;
      cssY += d.workArea.y - d.bounds.y;
    }
    const finalX = Math.round(cssX * scaleX);
    const finalY = Math.round(cssY * scaleY);
    const finalW = Math.round(rw * scaleX);
    const finalH = Math.round(rh * scaleY);
    console.log(`[Screenshot] crop: css=(${cssX},${cssY},${rw},${rh}) -> final=(${finalX},${finalY},${finalW},${finalH})`);
    const cropped = fullImg.crop({ x: finalX, y: finalY, width: finalW, height: finalH });
    const pngBuf = cropped.toPNG();
    fs.writeFileSync(filePath, pngBuf);

    const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
    return { success: true, filePath, dataUrl, fileName };
  } catch (error) {
    if (hideWindow && mainWindow && !mainWindow.isVisible()) {
      try { mainWindow.show(); mainWindow.focus(); } catch { /* ignore */ }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Screenshot failed',
    };
  } finally {
    console.log('[Screenshot] captureScreenshot finished');
    captureInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Overlay HTML — the interactive selection UI rendered inside each overlay
// ---------------------------------------------------------------------------

function buildOverlayHtml(bgDataUrl: string): string {
  const bg = JSON.stringify(bgDataUrl);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title></title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000;user-select:none;-webkit-user-select:none;cursor:crosshair}
canvas{position:absolute;top:0;left:0;width:100%;height:100%}
.tb{position:absolute;display:none;gap:4px;z-index:10}
.tb button{width:32px;height:32px;border:none;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.tb button svg{width:18px;height:18px}
.ok{background:#3b82f6;color:#fff}.ok:hover{background:#2563eb}
.no{background:rgba(255,255,255,.9);color:#374151}.no:hover{background:#fff}
.hd{position:absolute;width:8px;height:8px;background:#fff;border:1px solid #3b82f6;border-radius:1px;z-index:5;display:none}
.nw{cursor:nw-resize}.ne{cursor:ne-resize}.sw{cursor:sw-resize}.se{cursor:se-resize}
.nn{cursor:n-resize}.ss{cursor:s-resize}.ww{cursor:w-resize}.ee{cursor:e-resize}
.sl{position:absolute;background:rgba(0,0,0,.7);color:#fff;font-size:11px;font-family:system-ui;padding:2px 6px;border-radius:3px;white-space:nowrap;z-index:10;display:none}
</style></head><body>
<canvas id="c"></canvas>
<div class="sl" id="sl"></div>
<div class="tb" id="tb">
  <button class="no" id="bc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 18L18 6M6 6l12 12"/></svg></button>
  <button class="ok" id="bk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 13l4 4L19 7"/></svg></button>
</div>
<div class="hd nw" id="h0"></div><div class="hd ne" id="h1"></div>
<div class="hd sw" id="h2"></div><div class="hd se" id="h3"></div>
<div class="hd nn" id="h4"></div><div class="hd ss" id="h5"></div>
<div class="hd ww" id="h6"></div><div class="hd ee" id="h7"></div>
<script>
(function(){
var C=document.getElementById('c'),X=C.getContext('2d'),
    T=document.getElementById('tb'),S=document.getElementById('sl'),
    BK=document.getElementById('bk'),BC=document.getElementById('bc');
var HN=['nw','ne','sw','se','n','s','w','e'],H=[];
for(var i=0;i<8;i++)H[i]=document.getElementById('h'+i);
var D=window.devicePixelRatio||1,W=window.innerWidth,HH=window.innerHeight;
var sel=null,ph='idle',ds=null,ms=null,rh=null,ro=null,bg=null;

function ic(){C.width=W*D;C.height=HH*D;C.style.width=W+'px';C.style.height=HH+'px';X.setTransform(D,0,0,D,0,0)}
function nm(r){var x=r.x,y=r.y,w=r.w,h=r.h;if(w<0){x+=w;w=-w}if(h<0){y+=h;h=-h}return{x:x,y:y,w:w,h:h}}

function draw(){
  X.clearRect(0,0,W,HH);
  if(bg)X.drawImage(bg,0,0,W,HH);
  X.fillStyle='rgba(0,0,0,0.4)';X.fillRect(0,0,W,HH);
  if(!sel)return;
  var n=nm(sel);
  X.save();X.beginPath();X.rect(n.x,n.y,n.w,n.h);X.clip();
  if(bg)X.drawImage(bg,0,0,W,HH);
  X.restore();
  X.strokeStyle='#3b82f6';X.lineWidth=1;X.strokeRect(n.x+.5,n.y+.5,n.w-1,n.h-1);
  S.textContent=Math.round(n.w*D)+' \\u00d7 '+Math.round(n.h*D);
  S.style.display='block';S.style.left=n.x+'px';S.style.top=Math.max(0,n.y-22)+'px';
  if(ph==='done'||ph==='move'||ph==='rsz'){showH(n);showTB(n)}
}

function showH(n){
  var s=8,o=4,p=[[n.x-o,n.y-o],[n.x+n.w-o,n.y-o],[n.x-o,n.y+n.h-o],[n.x+n.w-o,n.y+n.h-o],
    [n.x+n.w/2-o,n.y-o],[n.x+n.w/2-o,n.y+n.h-o],[n.x-o,n.y+n.h/2-o],[n.x+n.w-o,n.y+n.h/2-o]];
  for(var i=0;i<8;i++){H[i].style.display='block';H[i].style.left=p[i][0]+'px';H[i].style.top=p[i][1]+'px'}
}

function showTB(n){
  T.style.display='flex';
  var tw=72,l=n.x+n.w-tw,t=n.y+n.h+8;
  if(t+36>HH)t=n.y-40;
  l=Math.max(4,Math.min(l,W-tw-4));t=Math.max(4,t);
  T.style.left=l+'px';T.style.top=t+'px'
}

function hideUI(){T.style.display='none';S.style.display='none';for(var i=0;i<8;i++)H[i].style.display='none'}

function hitH(mx,my){
  if(!sel)return-1;var n=nm(sel),m=6,
  pts=[[n.x,n.y],[n.x+n.w,n.y],[n.x,n.y+n.h],[n.x+n.w,n.y+n.h],
    [n.x+n.w/2,n.y],[n.x+n.w/2,n.y+n.h],[n.x,n.y+n.h/2],[n.x+n.w,n.y+n.h/2]];
  for(var i=0;i<8;i++)if(Math.abs(mx-pts[i][0])<=m&&Math.abs(my-pts[i][1])<=m)return i;
  return-1
}

function inside(mx,my){if(!sel)return false;var n=nm(sel);return mx>=n.x&&mx<=n.x+n.w&&my>=n.y&&my<=n.y+n.h}

function out(r){document.title=JSON.stringify(r)}

// ---- KEY FIX: prevent toolbar/handle mousedowns from resetting selection ----
T.addEventListener('mousedown',function(e){e.stopPropagation()});
// Handles: stopPropagation to prevent new-draw, but also initiate resize directly
for(var j=0;j<8;j++)(function(idx){
  H[idx].addEventListener('mousedown',function(e){
    e.stopPropagation();
    if(ph==='done'&&sel){
      ph='rsz';rh=idx;var n=nm(sel);ro={x:n.x,y:n.y,w:n.w,h:n.h,mx:e.clientX,my:e.clientY};
    }
  });
})(j);

document.addEventListener('mousedown',function(e){
  if(e.button===2){out({confirmed:false});return}
  if(e.button!==0)return;
  var mx=e.clientX,my=e.clientY;
  if(ph==='done'){
    var hi=hitH(mx,my);
    if(hi>=0){ph='rsz';rh=hi;var n=nm(sel);ro={x:n.x,y:n.y,w:n.w,h:n.h,mx:mx,my:my};return}
    if(inside(mx,my)){ph='move';ms={mx:mx,my:my,sx:sel.x,sy:sel.y};C.style.cursor='move';return}
  }
  ph='draw';hideUI();ds={x:mx,y:my};sel={x:mx,y:my,w:0,h:0};C.style.cursor='crosshair';draw()
});

document.addEventListener('mousemove',function(e){
  var mx=e.clientX,my=e.clientY;
  if(ph==='draw'&&ds){sel.w=mx-ds.x;sel.h=my-ds.y;draw();return}
  if(ph==='move'&&ms){sel.x=ms.sx+(mx-ms.mx);sel.y=ms.sy+(my-ms.my);draw();return}
  if(ph==='rsz'&&ro){
    var dx=mx-ro.mx,dy=my-ro.my;
    switch(rh){
      case 3:sel.w=ro.w+dx;sel.h=ro.h+dy;break;
      case 2:sel.x=ro.x+dx;sel.w=ro.w-dx;sel.h=ro.h+dy;break;
      case 1:sel.w=ro.w+dx;sel.y=ro.y+dy;sel.h=ro.h-dy;break;
      case 0:sel.x=ro.x+dx;sel.y=ro.y+dy;sel.w=ro.w-dx;sel.h=ro.h-dy;break;
      case 4:sel.y=ro.y+dy;sel.h=ro.h-dy;break;
      case 5:sel.h=ro.h+dy;break;
      case 6:sel.x=ro.x+dx;sel.w=ro.w-dx;break;
      case 7:sel.w=ro.w+dx;break;
    }
    draw();return
  }
  if(ph==='done'&&sel){
    var hi=hitH(mx,my);
    if(hi>=0){var cs=['nw-resize','ne-resize','sw-resize','se-resize','n-resize','s-resize','w-resize','e-resize'];C.style.cursor=cs[hi]}
    else if(inside(mx,my))C.style.cursor='move';
    else C.style.cursor='crosshair'
  }
});

document.addEventListener('mouseup',function(){
  if(ph==='draw'){
    var n=nm(sel);
    if(n.w>3&&n.h>3){sel=n;ph='done';C.style.cursor='default';draw()}
    else{sel=null;ph='idle';hideUI();draw()}
    ds=null;return
  }
  if(ph==='move'){sel=nm(sel);ph='done';C.style.cursor='default';ms=null;draw();return}
  if(ph==='rsz'){sel=nm(sel);ph='done';C.style.cursor='default';rh=null;ro=null;draw();return}
});

document.addEventListener('keydown',function(e){
  if(e.key==='Escape')out({confirmed:false});
  else if(e.key==='Enter'&&ph==='done')doOK()
});
document.addEventListener('contextmenu',function(e){e.preventDefault()});

BK.addEventListener('click',function(){doOK()});
BC.addEventListener('click',function(){out({confirmed:false})});

function doOK(){
  if(!sel||ph!=='done'){out({confirmed:false});return}
  var n=nm(sel);
  // Send raw CSS coordinates — main process will scale using actual image dimensions
  out({confirmed:true,rect:{x:Math.round(n.x),y:Math.round(n.y),width:Math.round(n.w),height:Math.round(n.h)}})
}

ic();
console.log('[overlay] init D='+D+' W='+W+' HH='+HH+' canvas='+C.width+'x'+C.height);
bg=new Image();
bg.onload=function(){console.log('[overlay] bg loaded: '+bg.naturalWidth+'x'+bg.naturalHeight);draw()};
bg.onerror=function(e){console.error('[overlay] bg load FAILED',e)};
bg.src=${bg};
console.log('[overlay] bg.src set, length='+(bg.src?bg.src.length:0));
window.addEventListener('resize',function(){W=window.innerWidth;HH=window.innerHeight;ic();draw()});
})();
</script></body></html>`;
}
