const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 960,
    backgroundColor: '#222222',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile('index.html');
  
  // Open DevTools for debugging (remove in production)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============ Optimized FFmpeg Export System ============

let tempDir = null;
let frameCount = 0;

// Create temp directory for frames
ipcMain.handle('export:init', async (event, { width, height, fps }) => {
  tempDir = path.join(os.tmpdir(), `light-grid-export-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  frameCount = 0;
  console.log(`Export initialized: ${tempDir}, ${width}x${height} @ ${fps}fps`);
  return { tempDir };
});

// Save a BATCH of frames (optimized - parallel async writes)
ipcMain.handle('export:saveFrameBatch', async (event, { frames }) => {
  if (!tempDir) return { error: 'Export not initialized' };
  
  // Write all frames in parallel using async fs
  const writePromises = frames.map((dataUrl, i) => {
    return new Promise((resolve, reject) => {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const framePath = path.join(tempDir, `frame_${String(frameCount + i).padStart(6, '0')}.png`);
      
      fs.writeFile(framePath, base64Data, 'base64', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
  
  await Promise.all(writePromises);
  frameCount += frames.length;
  
  return { frameNumber: frameCount };
});

// Legacy single frame save
ipcMain.handle('export:saveFrame', async (event, { dataUrl }) => {
  if (!tempDir) return { error: 'Export not initialized' };
  
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
  const framePath = path.join(tempDir, `frame_${String(frameCount).padStart(6, '0')}.png`);
  
  await fs.promises.writeFile(framePath, base64Data, 'base64');
  frameCount++;
  
  return { frameNumber: frameCount };
});

// Save audio file
ipcMain.handle('export:saveAudio', async (event, { buffer }) => {
  if (!tempDir) return { error: 'Export not initialized' };
  
  const audioPath = path.join(tempDir, 'audio.webm');
  await fs.promises.writeFile(audioPath, Buffer.from(buffer));
  console.log(`Audio saved: ${audioPath}, size: ${buffer.byteLength} bytes`);
  return { audioPath };
});

// Run FFmpeg to assemble video
ipcMain.handle('export:finalize', async (event, { fps, hasAudio, outputFormat }) => {
  if (!tempDir) return { error: 'Export not initialized' };

  // Store tempDir locally so cleanup doesn't affect us
  const currentTempDir = tempDir;
  
  // Check how many frames we have
  const files = fs.readdirSync(currentTempDir).filter(f => f.endsWith('.png'));
  console.log(`Found ${files.length} frames in ${currentTempDir}`);
  
  if (files.length === 0) {
    cleanup();
    return { error: 'No frames were rendered. Export failed.' };
  }

  // Ask user where to save
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Exported Video',
    defaultPath: `light_grid_export.${outputFormat === 'prores' ? 'mov' : 'mp4'}`,
    filters: outputFormat === 'prores' 
      ? [{ name: 'QuickTime Movie', extensions: ['mov'] }]
      : [{ name: 'MP4 Video', extensions: ['mp4'] }]
  });

  if (canceled || !filePath) {
    cleanup();
    return { canceled: true };
  }

  // Try to find ffmpeg first
  const ffmpegPath = findFFmpeg();
  if (!ffmpegPath) {
    cleanup();
    return { error: 'FFmpeg not found. Please install FFmpeg:\n\nbrew install ffmpeg\n\nor download from https://ffmpeg.org' };
  }

  return new Promise((resolve) => {
    const inputPattern = path.join(currentTempDir, 'frame_%06d.png');
    const audioPath = path.join(currentTempDir, 'audio.webm');
    const audioExists = hasAudio && fs.existsSync(audioPath);
    
    // Use a temp output file, then move to final location
    const tempOutput = path.join(currentTempDir, 'output_temp.' + (outputFormat === 'prores' ? 'mov' : 'mp4'));
    
    let ffmpegArgs = [
      '-y', // Overwrite output
      '-framerate', String(fps),
      '-i', inputPattern
    ];

    // Add audio input if exists
    if (audioExists) {
      ffmpegArgs.push('-i', audioPath);
    }

    // Output settings based on format
    if (outputFormat === 'prores') {
      // ProRes 422 HQ for professional editing
      ffmpegArgs.push(
        '-c:v', 'prores_ks',
        '-profile:v', '3',
        '-pix_fmt', 'yuv422p10le',
        '-vendor', 'apl0'
      );
    } else {
      // H.264 for universal compatibility - write moov at end first, then move
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.1'
        // Note: movflags +faststart will be applied in second pass
      );
    }

    // Audio settings - re-encode for compatibility
    if (audioExists) {
      ffmpegArgs.push(
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-shortest'
      );
    } else {
      // No audio - ensure video-only output
      ffmpegArgs.push('-an');
    }

    ffmpegArgs.push(tempOutput);

    console.log('FFmpeg command:', ffmpegPath, ffmpegArgs.join(' '));
    console.log(`Processing ${files.length} frames...`);

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);

    let stderr = '';
    let lastProgress = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('FFmpeg:', data.toString().trim());
      
      const frameMatch = stderr.match(/frame=\s*(\d+)/g);
      if (frameMatch) {
        const lastFrameMatch = frameMatch[frameMatch.length - 1].match(/\d+/);
        if (lastFrameMatch && lastFrameMatch[0] !== lastProgress) {
          lastProgress = lastFrameMatch[0];
          mainWindow.webContents.send('export:progress', { 
            frame: parseInt(lastFrameMatch[0]),
            total: files.length
          });
        }
      }
    });

    ffmpeg.on('close', async (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      
      if (code === 0 && fs.existsSync(tempOutput)) {
        const tempStats = fs.statSync(tempOutput);
        console.log(`Temp output created: ${(tempStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        if (outputFormat !== 'prores') {
          // Apply faststart for MP4 - move moov atom to beginning
          console.log('Applying faststart (moving moov atom)...');
          
          const fastStartArgs = [
            '-y',
            '-i', tempOutput,
            '-c', 'copy',
            '-movflags', '+faststart',
            filePath
          ];
          
          const fastStart = spawn(ffmpegPath, fastStartArgs);
          let fastStartErr = '';
          
          fastStart.stderr.on('data', (data) => {
            fastStartErr += data.toString();
          });
          
          fastStart.on('close', (fsCode) => {
            // Clean up temp output
            try { fs.unlinkSync(tempOutput); } catch(e) {}
            
            if (fsCode === 0 && fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              console.log(`Final output: ${filePath}, size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
              cleanup();
              resolve({ success: true, outputPath: filePath, fileSize: stats.size });
            } else {
              console.error('Faststart failed:', fastStartErr);
              cleanup();
              resolve({ error: `Faststart failed (code ${fsCode})` });
            }
          });
        } else {
          // ProRes - just move the file
          fs.renameSync(tempOutput, filePath);
          const stats = fs.statSync(filePath);
          console.log(`Final output: ${filePath}, size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          cleanup();
          resolve({ success: true, outputPath: filePath, fileSize: stats.size });
        }
      } else {
        console.error('FFmpeg error (code ' + code + '):', stderr.slice(-1000));
        cleanup();
        resolve({ error: `FFmpeg failed (code ${code}).\n\nDetails:\n${stderr.slice(-500)}` });
      }
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      cleanup();
      resolve({ error: `Failed to run FFmpeg: ${err.message}` });
    });
  });
});

// Cancel and cleanup
ipcMain.handle('export:cancel', async () => {
  cleanup();
  return { canceled: true };
});

function cleanup() {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('Cleaned up temp directory');
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }
  tempDir = null;
  frameCount = 0;
}

function findFFmpeg() {
  const possiblePaths = [
    '/opt/homebrew/bin/ffmpeg', // Homebrew on Apple Silicon (most common on modern Macs)
    '/usr/local/bin/ffmpeg',    // Homebrew on Intel Macs
    '/usr/bin/ffmpeg',          // System install
    'ffmpeg'                    // In PATH
  ];

  for (const p of possiblePaths) {
    try {
      const result = require('child_process').spawnSync(p, ['-version'], { timeout: 5000 });
      if (result.status === 0) {
        console.log('Found FFmpeg at:', p);
        return p;
      }
    } catch (e) {
      // Continue searching
    }
  }
  
  console.error('FFmpeg not found in any standard location');
  return null;
}
