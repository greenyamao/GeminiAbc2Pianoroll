/**
 * FL Studio Style Piano Roll Renderer
 * HTML5 Canvas 2D component matching FL Studio aesthetics:
 * 
 * Fixes & Improvements:
 * - Exact sub-pixel mouse coordinate mapping (solves cursor drift & DPI scale offset).
 * - Compact FL Studio proportions (rowHeight: 16px, zoomX: 38px) — no more over-stretched keys or giant notes.
 * - Musical grid snapping on seek (snaps to 1/4 beat / 16th note steps like in FL Studio).
 * - Fixed ruler hover ghost line: eliminates duplicate/offset orange markers.
 * - Isolated wheel navigation: pure vertical scroll, pure horizontal scroll with Shift, pure zoom with Ctrl.
 * - ResizeObserver for 100% responsive layout sync.
 */

// Global persistent scale and registry across all piano rolls on the page
let globalZoomX = 38;
let globalRowHeight = 16;
try {
  if (typeof localStorage !== 'undefined') {
    const sZoomX = localStorage.getItem('fl_global_zoom_x');
    const sRowH = localStorage.getItem('fl_global_row_height');
    if (sZoomX) globalZoomX = Math.max(18, Math.min(140, parseFloat(sZoomX)));
    if (sRowH) globalRowHeight = Math.max(10, Math.min(36, parseFloat(sRowH)));
  }
} catch (e) {}

const registeredRolls = new Set();
let activeRollForKeyboard = null;

function broadcastGlobalZoom(newZoomX, newRowHeight) {
  if (newZoomX !== undefined) {
    globalZoomX = Math.max(18, Math.min(140, newZoomX));
    try { localStorage.setItem('fl_global_zoom_x', globalZoomX.toString()); } catch (e) {}
  }
  if (newRowHeight !== undefined) {
    globalRowHeight = Math.max(8, Math.min(36, newRowHeight));
    try { localStorage.setItem('fl_global_row_height', globalRowHeight.toString()); } catch (e) {}
  }
  for (const roll of registeredRolls) {
    roll.applyGlobalZoom(globalZoomX, globalRowHeight);
  }
}

// Global Spacebar listener for Play / Stop
if (typeof window !== 'undefined' && !window.__flSpacebarBound) {
  window.__flSpacebarBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      const target = e.target;
      const isInput = target && (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable || 
        target.closest?.('[contenteditable="true"]')
      );
      if (isInput) return; // Allow normal space typing in textareas and inputs

      // Find candidate piano roll to toggle
      let targetRoll = activeRollForKeyboard;
      if (!targetRoll || !registeredRolls.has(targetRoll)) {
        // Fallback: active/playing roll, or the most recent one
        targetRoll = Array.from(registeredRolls).reverse().find(r => r.synth && r.synth.isPlaying) ||
                     Array.from(registeredRolls).reverse()[0];
      }

      if (targetRoll && typeof targetRoll.togglePlay === 'function') {
        e.preventDefault(); // Prevent page scrolling down
        targetRoll.togglePlay();
      }
    }
  });
}

class FLPianoRoll {
  constructor(container, options = {}) {
    this.container = container;
    this.options = Object.assign({
      height: 280,
      zoomX: globalZoomX,
      rowHeight: globalRowHeight,
      keyboardWidth: 58,
      rulerHeight: 22,
      scrollbarHeight: 8,
      verticalScrollbarWidth: 8,
      autoScroll: false,
      editable: false,
      onNoteClick: null,
      onKeyClick: null,
      onSeek: null,
      onNotesChange: null
    }, options);

    this.musicData = null;
    this.synth = options.synth || null;
    this.editable = !!this.options.editable;
    this.lastNoteDuration = 1.0; // FL Studio sticky note length
    this.snapStep = (this.options.snapStep !== undefined) ? this.options.snapStep : 0.25;
    this.isResizingNote = false;
    this.resizingNote = null;
    this.isMovingNote = false;
    this.movingNote = null;
    this.moveStartMouseX = 0;
    this.moveStartMouseY = 0;
    this.moveStartBeat = 0;
    this.moveStartPitch = 60;
    this.hasMovedNote = false;
    this.hoverGrid = null;
    this.onNotesChange = this.options.onNotesChange || null;
    
    // Viewport state
    this.scrollX = 0;
    this.scrollY = 0;
    this.zoomX = globalZoomX;
    this.rowHeight = globalRowHeight;
    this.minPitch = 21;
    this.maxPitch = 108;
    this.pitchRange = 88;

    // Register instance for global sync
    registeredRolls.add(this);
    activeRollForKeyboard = this;

    // Playback state
    this.currentBeat = 0;
    this.playOriginBeat = 0; // FL Studio-style start marker
    this.activePitches = new Set();
    this.hoveredNote = null;

    // Scrubbing / Seeking state
    this.isScrubbing = false;
    this.wasPlayingBeforeScrub = false;
    this.hoveredRulerX = null;

    // Horizontal scrollbar dragging state
    this.isDraggingScrollbar = false;
    this.scrollbarDragStartX = 0;
    this.scrollbarStartScrollX = 0;

    // Vertical scrollbar dragging state
    this.isDraggingVerticalScrollbar = false;
    this.verticalDragStartY = 0;
    this.verticalStartScrollY = 0;

    // Grid Drag / Pan state
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartScrollX = 0;
    this.dragStartScrollY = 0;

    // FL Studio Color Palette
    this.colors = {
      bgDark: '#1a242c',
      bgLight: '#212d37',
      gridMeasureLine: '#3a4a58',
      gridBeatLine: '#273440',
      gridSubLine: '#1e2832',
      rulerBg: '#151e25',
      rulerBorder: '#2c3c4a',
      rulerText: '#8fa2b3',
      rulerHover: 'rgba(255, 133, 27, 0.35)',
      scrollbarBg: '#11171d',
      scrollbarThumb: '#2d3e4e',
      scrollbarThumbHover: '#42586e',
      keyWhite: '#d8dee4',
      keyWhiteBorder: '#9da7b0',
      keyBlack: '#23282e',
      keyBlackBorder: '#14171a',
      keyActive: '#ff851b', // FL Studio warm orange active highlight
      keyActiveText: '#ffffff',
      keyLabel: '#556270',
      noteBg: '#8fe3a2', // FL Studio mint green
      noteBorder: '#489d5f',
      noteText: '#13391d',
      noteHover: '#b5f5c4',
      playhead: '#ffffff',
      playheadGlow: 'rgba(255, 133, 27, 0.7)'
    };

    this.initDOM();
    this.bindEvents();

    if (this.editable && !this.musicData) {
      this.initEmptyScore();
    }
  }

  initDOM() {
    this.container.innerHTML = '';
    this.container.classList.add('fl-pianoroll-root');

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fl-pianoroll-canvas';
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = `${this.options.height}px`;
    this.canvas.style.cursor = 'default';

    this.canvas.addEventListener('mouseenter', () => {
      activeRollForKeyboard = this;
    });

    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.updateCanvasDimensions();

    // Auto-sync dimensions if container resizes
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateCanvasDimensions();
        this.clampScroll();
        this.render();
      });
      this.resizeObserver.observe(this.canvas);
    }
  }

  updateCanvasDimensions() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || this.container.clientWidth || 600;
    this.height = (this.container.clientHeight && this.container.clientHeight > 100) 
      ? this.container.clientHeight 
      : this.options.height;

    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Translates mouse event client coordinates to exact canvas context coordinates
   * Accounting for browser zoom, High-DPI scaling, and element bounding rect.
   */
  getCanvasMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    // Exact scale factor between canvas internal coordinate space and client rect
    const scaleX = rect.width > 0 ? (this.width / rect.width) : 1;
    const scaleY = rect.height > 0 ? (this.height / rect.height) : 1;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  setData(musicData) {
    this.musicData = musicData;
    if (!musicData || !musicData.notes || musicData.notes.length === 0) {
      if (this.editable) {
        this.initEmptyScore();
        return;
      }
      this.renderEmpty();
      return;
    }

    // Full standard 88-key piano range (A0 = 21 to C8 = 108)
    // Always provides full octave navigation across all 7+ octaves
    const noteMin = (musicData && typeof musicData.minPitch === 'number') ? musicData.minPitch : 60;
    const noteMax = (musicData && typeof musicData.maxPitch === 'number') ? musicData.maxPitch : 60;
    this.minPitch = Math.min(21, Math.max(12, noteMin - 2));
    this.maxPitch = Math.max(108, Math.min(127, noteMax + 2));
    this.pitchRange = this.maxPitch - this.minPitch + 1;

    // Apply current global zoom
    this.rowHeight = globalRowHeight;
    this.zoomX = globalZoomX;

    // Maintain configured height or default comfortably
    if (!this.options.height) {
      this.options.height = 280;
    }
    this.canvas.style.height = `${this.options.height}px`;
    this.updateCanvasDimensions();

    const availableGridH = this.height - this.options.rulerHeight - this.options.scrollbarHeight;
    const totalGridHeight = this.pitchRange * this.rowHeight;
    const maxScrollY = Math.max(0, totalGridHeight - availableGridH);

    // Auto-center vertical scroll on the center of musical pitches so both bass and soprano are visible
    const avgPitch = (musicData.minPitch + musicData.maxPitch) / 2;
    const centerRow = this.maxPitch - avgPitch;
    const centerPixelY = centerRow * this.rowHeight;
    this.scrollY = Math.max(0, Math.min(maxScrollY, centerPixelY - (availableGridH / 2)));

    this.scrollX = 0;
    this.currentBeat = 0;
    this.playOriginBeat = 0;
    this.activePitches.clear();

    this.render();
    if (this.onNotesChange && this.musicData) {
      this.onNotesChange(this.musicData.notes);
    }
  }

  initEmptyScore() {
    this.musicData = {
      title: 'Composition',
      key: 'C',
      meter: '4/4',
      tempo: 120,
      beatsPerMeasure: 4,
      totalBeats: 16,
      minPitch: 21,
      maxPitch: 108,
      notes: []
    };
    this.minPitch = 21; // A0 (88-key standard piano bottom)
    this.maxPitch = 108; // C8 (88-key standard piano top)
    this.pitchRange = 88;
    this.currentBeat = 0;
    this.activePitches.clear();
    this.scrollX = 0;

    // Center view on Middle C (C4, MIDI 60)
    const availableGridH = (this.container && this.container.clientHeight && this.container.clientHeight > 100 ? this.container.clientHeight : this.options.height) - this.options.rulerHeight - this.options.scrollbarHeight;
    const centerRow = this.maxPitch - 60;
    const centerPixelY = centerRow * this.rowHeight;
    this.scrollY = Math.max(0, centerPixelY - (availableGridH / 2));

    this.clampScroll();
    this.render();
  }

  clearNotes() {
    if (!this.musicData) {
      this.initEmptyScore();
      return;
    }
    this.musicData.notes = [];
    this.musicData.totalBeats = 16;
    this.currentBeat = 0;
    this.activePitches.clear();
    if (this.synth) this.synth.stop(true);
    this.render();
    if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
  }

  midiToNoteName(pitch) {
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(pitch / 12) - 1;
    return NOTE_NAMES[((pitch % 12) + 12) % 12] + octave;
  }

  quantizeBeat(val, step = (this.snapStep || 0.25)) {
    if (!step || step <= 0) step = 0.25;
    const snapped = Math.round(val / step) * step;
    return Math.round(snapped * 10000) / 10000;
  }

  isNearNoteRightEdge(note, x, y) {
    const nx = this.xAtBeat(note.startBeat);
    const nw = Math.max(8, (note.duration * this.zoomX) - 1.5);
    const ny = this.yAtPitch(note.pitch);
    const nh = this.rowHeight;
    if (y >= ny && y <= ny + nh) {
      const rightEdge = nx + nw;
      return (x >= rightEdge - 8 && x <= rightEdge + 5);
    }
    return false;
  }

  fitToWidth() {
    if (!this.musicData) return;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const gridWidth = this.width - this.options.keyboardWidth - vsw - 25;
    const totalBeats = Math.max(4, this.musicData.totalBeats);
    const fitZoom = gridWidth / totalBeats;
    this.zoomX = Math.max(24, Math.min(90, fitZoom));
    this.scrollX = 0;
  }

  setZoom(delta) {
    broadcastGlobalZoom(globalZoomX + delta, undefined);
  }

  setZoomY(delta) {
    broadcastGlobalZoom(undefined, globalRowHeight + delta);
  }

  applyGlobalZoom(zX, rH) {
    if (zX !== undefined) this.zoomX = zX;
    if (rH !== undefined) this.rowHeight = rH;
    this.clampScroll();
    this.render();
  }

  setHeight(newHeight) {
    newHeight = Math.max(180, Math.min(750, newHeight));
    this.options.height = newHeight;
    if (this.canvas) {
      this.canvas.style.height = `${newHeight}px`;
      this.updateCanvasDimensions();
    }
    this.clampScroll();
    this.render();
  }

  clampScroll() {
    if (!this.musicData) return;
    const vsw = this.options.verticalScrollbarWidth || 8;
    // Horizontal clamp
    const totalGridWidth = this.musicData.totalBeats * this.zoomX;
    const maxScrollX = Math.max(0, totalGridWidth - (this.width - this.options.keyboardWidth - vsw - 40));
    this.scrollX = Math.max(0, Math.min(maxScrollX, this.scrollX));

    // Vertical clamp
    const totalGridHeight = this.pitchRange * this.rowHeight;
    const availableGridH = this.height - this.options.rulerHeight - this.options.scrollbarHeight;
    const maxScrollY = Math.max(0, totalGridHeight - availableGridH);
    this.scrollY = Math.max(0, Math.min(maxScrollY, this.scrollY));
  }

  /**
   * Convert pixel X to musical beat with grid snapping
   * @param {number} x
   * @param {'round'|'floor'|'none'} mode - Snapping mode: 'floor' for cell placement, 'round' for seek/move
   */
  beatAtX(x, mode = 'round') {
    const kw = this.options.keyboardWidth;
    const rawBeat = Math.max(0, (x - kw + this.scrollX) / this.zoomX);
    if (mode === 'none' || mode === false) return rawBeat;
    
    const step = this.snapStep || 0.25;
    if (step <= 0) return rawBeat;

    if (mode === 'floor') {
      return Math.round(Math.floor(rawBeat / step) * step * 10000) / 10000;
    }
    return Math.round(Math.round(rawBeat / step) * step * 10000) / 10000;
  }

  seekTo(beat) {
    if (!this.musicData) return;
    const maxBeat = Math.max(this.musicData.totalBeats, 4);
    const clampedBeat = Math.max(0, Math.min(maxBeat, beat));
    this.currentBeat = clampedBeat;
    this.playOriginBeat = clampedBeat;

    // Update active pitches for key lighting
    const activePitches = new Set();
    for (const n of this.musicData.notes) {
      if (clampedBeat >= n.startBeat && clampedBeat < (n.startBeat + n.duration)) {
        activePitches.add(n.pitch);
      }
    }
    this.activePitches = activePitches;

    if (this.synth) {
      this.synth.seek(clampedBeat);
    }

    if (this.options.onSeek) {
      this.options.onSeek(clampedBeat);
    }

    this.render();
  }

  bindEvents() {
    // MOUSE DOWN
    this.canvas.addEventListener('mousedown', (e) => {
      const pos = this.getCanvasMousePos(e);
      const x = pos.x;
      const y = pos.y;

      // 0a. Right Click on existing note in editable mode -> Delete Note (FL Studio behavior)
      if (e.button === 2 && this.editable && this.musicData && this.musicData.notes) {
        const noteToDelete = this.findNoteAt(x, y);
        if (noteToDelete) {
          e.preventDefault();
          e.stopPropagation();
          const idx = this.musicData.notes.indexOf(noteToDelete);
          if (idx !== -1) {
            this.musicData.notes.splice(idx, 1);
            if (this.hoveredNote === noteToDelete) this.hoveredNote = null;
            this.render();
            if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
          }
          return;
        }
      }

      // 0b. Intercept Middle Click or Right Click on empty space -> Hand Pan/Drag Grid
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartScrollX = this.scrollX;
        this.dragStartScrollY = this.scrollY;
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      const kw = this.options.keyboardWidth;
      const rh = this.options.rulerHeight;
      const sh = this.options.scrollbarHeight;
      const sbY = this.height - sh;

      // 1. Bottom Scrollbar click/drag
      if (y >= sbY && x > kw) {
        const thumb = this.getScrollbarThumbRect();
        if (x >= thumb.x && x <= thumb.x + thumb.w) {
          this.isDraggingScrollbar = true;
          this.scrollbarDragStartX = x;
          this.scrollbarStartScrollX = this.scrollX;
        } else {
          // Jump scrollbar to click
          const trackWidth = this.width - kw - (this.options.verticalScrollbarWidth || 8);
          const ratio = (x - kw) / trackWidth;
          const totalWidth = (this.musicData ? this.musicData.totalBeats : 16) * this.zoomX;
          this.scrollX = ratio * totalWidth;
          this.clampScroll();
          this.render();
        }
        return;
      }

      // 1b. Right Vertical Scrollbar click/drag
      const vsw = this.options.verticalScrollbarWidth || 8;
      if (x >= this.width - vsw && y >= rh && y <= sbY) {
        const thumb = this.getVerticalScrollbarThumbRect();
        if (y >= thumb.y && y <= thumb.y + thumb.h) {
          this.isDraggingVerticalScrollbar = true;
          this.verticalDragStartY = y;
          this.verticalStartScrollY = this.scrollY;
        } else {
          // Jump vertical scroll
          const gridH = this.height - rh - sh;
          const ratio = (y - rh) / gridH;
          const totalGridHeight = this.pitchRange * this.rowHeight;
          const maxScrollY = Math.max(0, totalGridHeight - gridH);
          this.scrollY = ratio * maxScrollY;
          this.clampScroll();
          this.render();
        }
        return;
      }

      // 2. Click on Timeline Ruler -> Seek/Scrub playhead!
      if (y <= rh && x > kw) {
        this.isScrubbing = true;
        this.hoveredRulerX = null; // Hide hover ghost line while scrubbing
        this.wasPlayingBeforeScrub = this.synth ? (this.synth.isPlaying && !this.synth.isPaused) : false;
        
        // Pause audio voices during scrubbing so it doesn't glitch sound
        if (this.wasPlayingBeforeScrub && this.synth) {
          this.synth.pause(false);
        }

        const beat = this.beatAtX(x, true);
        this.seekTo(beat);
        this.canvas.style.cursor = 'ew-resize';
        return;
      }

      // 3. Click on Left Piano Keyboard -> Play preview
      if (x <= kw && y > rh && y < sbY) {
        const pitch = this.pitchAtY(y);
        if (pitch !== null) {
          this.activePitches.add(pitch);
          this.render();
          if (this.options.onKeyClick) this.options.onKeyClick(pitch);
          else if (this.synth) this.synth.playNotePreview(pitch);
        }
        return;
      }

      // 4. Click on a Note in the grid
      const clickedNote = this.findNoteAt(x, y);
      if (clickedNote) {
        if (this.editable) {
          // Check right edge resize handle
          if (this.isNearNoteRightEdge(clickedNote, x, y)) {
            this.isResizingNote = true;
            this.resizingNote = clickedNote;
            this.lastNoteDuration = clickedNote.duration; // Remember duration
            this.canvas.style.cursor = 'ew-resize';
            return;
          }

          // Clicked note body: start moving note in FL Studio style!
          this.isMovingNote = true;
          this.movingNote = clickedNote;
          this.moveStartMouseX = x;
          this.moveStartMouseY = y;
          this.moveStartBeat = clickedNote.startBeat;
          this.moveStartPitch = clickedNote.pitch;
          this.hasMovedNote = false;
          this.lastNoteDuration = clickedNote.duration; // Remember duration
          this.canvas.style.cursor = 'move';
          if (this.synth) this.synth.playNotePreview(clickedNote.pitch);
          if (this.options.onNoteClick) this.options.onNoteClick(clickedNote);
          this.render();
          return;
        }

        if (this.options.onNoteClick) this.options.onNoteClick(clickedNote);
        else if (this.synth) this.synth.playNotePreview(clickedNote.pitch);
        return;
      }

      // 5. Left Click on empty grid area
      if (this.editable && x > kw && x < this.width - vsw && y > rh && y < sbY) {
        // Draw note immediately in FL Studio style with cell snapping and strict quantization!
        const pitch = this.pitchAtY(y);
        const step = this.snapStep || 0.25;
        const beat = this.beatAtX(x, 'floor');
        if (pitch !== null && beat >= 0) {
          if (!this.musicData) {
            this.initEmptyScore();
          }
          const duration = Math.max(step, this.quantizeBeat(this.lastNoteDuration || 1.0, step));
          const newNote = {
            pitch: pitch,
            name: this.midiToNoteName(pitch),
            startBeat: beat,
            duration: duration,
            velocity: 80
          };
          this.musicData.notes.push(newNote);
          // Keep vertical range visible if user places notes outside standard 88 keys
          this.minPitch = Math.min(this.minPitch, Math.max(12, pitch - 2));
          this.maxPitch = Math.max(this.maxPitch, Math.min(127, pitch + 2));
          this.pitchRange = this.maxPitch - this.minPitch + 1;
          this.musicData.totalBeats = Math.max(16, Math.max(this.musicData.totalBeats, beat + duration + 4));

          if (this.synth) this.synth.playNotePreview(pitch);
          this.render();
          if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
          return;
        }
      }

      // If not editable or clicked elsewhere, seek playhead directly to clicked beat
      this.isScrubbing = true;
      this.hoveredRulerX = null;
      this.wasPlayingBeforeScrub = this.synth ? (this.synth.isPlaying && !this.synth.isPaused) : false;
      if (this.wasPlayingBeforeScrub && this.synth) {
        this.synth.pause(false);
      }

      const beat = this.beatAtX(x, 'round');
      this.seekTo(beat);
      this.canvas.style.cursor = 'ew-resize';
    });

    // MOUSE MOVE
    window.addEventListener('mousemove', (e) => {
      const pos = this.getCanvasMousePos(e);
      const x = pos.x;
      const y = pos.y;

      const kw = this.options.keyboardWidth;
      const rh = this.options.rulerHeight;
      const sh = this.options.scrollbarHeight;
      const sbY = this.height - sh;

      // Active timeline scrubbing
      if (this.isScrubbing) {
        this.hoveredRulerX = null;
        const beat = this.beatAtX(x, true);
        const maxBeat = this.musicData ? this.musicData.totalBeats : 16;
        const clampedBeat = Math.min(maxBeat, beat);
        this.currentBeat = clampedBeat;

        // Update active pitches
        if (this.musicData) {
          const activePitches = new Set();
          for (const n of this.musicData.notes) {
            if (clampedBeat >= n.startBeat && clampedBeat < (n.startBeat + n.duration)) {
              activePitches.add(n.pitch);
            }
          }
          this.activePitches = activePitches;
        }

        this.render();
        return;
      }

      // Active horizontal scrollbar dragging
      if (this.isDraggingScrollbar) {
        const vsw = this.options.verticalScrollbarWidth || 8;
        const dx = x - this.scrollbarDragStartX;
        const trackWidth = this.width - kw - vsw;
        const totalWidth = (this.musicData ? this.musicData.totalBeats : 16) * this.zoomX;
        const scrollDelta = (dx / trackWidth) * totalWidth;
        this.scrollX = this.scrollbarStartScrollX + scrollDelta;
        this.clampScroll();
        this.render();
        return;
      }

      // Active vertical scrollbar dragging
      if (this.isDraggingVerticalScrollbar) {
        const dy = y - this.verticalDragStartY;
        const gridH = this.height - rh - sh;
        const totalGridHeight = this.pitchRange * this.rowHeight;
        const maxScrollY = Math.max(0, totalGridHeight - gridH);
        const thumb = this.getVerticalScrollbarThumbRect();
        const availableTrack = gridH - thumb.h;
        if (availableTrack > 0) {
          const scrollDelta = (dy / availableTrack) * maxScrollY;
          this.scrollY = this.verticalStartScrollY + scrollDelta;
          this.clampScroll();
          this.render();
        }
        return;
      }

      // Active grid panning
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        this.scrollX = this.dragStartScrollX - dx;
        this.scrollY = this.dragStartScrollY - dy;
        this.clampScroll();
        this.render();
        return;
      }

      // Hover cursors and highlights
      const vsw = this.options.verticalScrollbarWidth || 8;
      if (y >= 0 && y <= rh && x > kw && x < this.width - vsw) {
        this.canvas.style.cursor = 'ew-resize';
        // Snap hover preview line to nearest 1/4 beat as well!
        const previewBeat = this.beatAtX(x, true);
        this.hoveredRulerX = this.xAtBeat(previewBeat);
        this.render();
      } else {
        if (this.hoveredRulerX !== null) {
          this.hoveredRulerX = null;
          this.render();
        }
        if (x >= this.width - vsw && y >= rh && y <= sbY) {
          this.canvas.style.cursor = 'default';
        } else if (x <= kw && y > rh && y < sbY) {
          this.canvas.style.cursor = 'pointer';
        } else if (y >= sbY) {
          this.canvas.style.cursor = 'pointer';
        } else {
          this.canvas.style.cursor = 'grab';
        }
      }

      // Active note dragging / moving (FL Studio note movement with pitch and beat snapping)
      if (this.isMovingNote && this.movingNote) {
        const dx = x - this.moveStartMouseX;
        const deltaBeats = dx / this.zoomX;
        const step = this.snapStep || 0.25;
        let newBeat = Math.max(0, this.quantizeBeat(this.moveStartBeat + deltaBeats, step));
        const newPitch = this.pitchAtY(y);

        let changed = false;
        if (newBeat !== this.movingNote.startBeat) {
          this.movingNote.startBeat = newBeat;
          this.hasMovedNote = true;
          changed = true;
        }
        if (newPitch !== null && newPitch >= 21 && newPitch <= 108 && newPitch !== this.movingNote.pitch) {
          this.movingNote.pitch = newPitch;
          this.movingNote.name = this.midiToNoteName(newPitch);
          this.hasMovedNote = true;
          changed = true;
          if (this.synth) this.synth.playNotePreview(newPitch);
        }

        if (changed) {
          if (this.musicData) {
            this.musicData.totalBeats = Math.max(16, Math.max(this.musicData.totalBeats, newBeat + this.movingNote.duration + 4));
            this.minPitch = Math.min(this.minPitch, Math.max(21, this.movingNote.pitch - 2));
            this.maxPitch = Math.max(this.maxPitch, Math.min(108, this.movingNote.pitch + 2));
            this.pitchRange = this.maxPitch - this.minPitch + 1;
          }
          this.render();
          if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
        }
        this.canvas.style.cursor = 'move';
        return;
      }

      // Active note resizing (FL Studio right-edge drag with snapping)
      if (this.isResizingNote && this.resizingNote) {
        const step = this.snapStep || 0.25;
        const currentRawBeat = (x - kw + this.scrollX) / this.zoomX;
        const targetEndBeat = Math.max(this.resizingNote.startBeat + step, this.quantizeBeat(currentRawBeat, step));
        let newDuration = Math.max(step, this.quantizeBeat(targetEndBeat - this.resizingNote.startBeat, step));

        if (newDuration !== this.resizingNote.duration) {
          this.resizingNote.duration = newDuration;
          this.lastNoteDuration = newDuration; // Remember duration
          if (this.musicData) {
            this.musicData.totalBeats = Math.max(16, Math.max(this.musicData.totalBeats, this.resizingNote.startBeat + newDuration + 4));
          }
          this.render();
          if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
        }
        this.canvas.style.cursor = 'ew-resize';
        return;
      }

      // Hover note detection and cursor
      if (x > kw && x < this.width - vsw && y > rh && y < sbY) {
        const note = this.findNoteAt(x, y);
        if (note !== this.hoveredNote) {
          this.hoveredNote = note;
        }

        if (this.editable) {
          if (note) {
            this.hoverGrid = null;
            if (this.isNearNoteRightEdge(note, x, y)) {
              this.canvas.style.cursor = 'ew-resize';
            } else {
              this.canvas.style.cursor = 'move';
            }
          } else {
            // Empty grid: update ghost note snapped position
            const ghostBeat = this.beatAtX(x, 'floor');
            const ghostPitch = this.pitchAtY(y);
            this.hoverGrid = { beat: ghostBeat, pitch: ghostPitch };
            this.canvas.style.cursor = 'crosshair';
          }
          this.render();
        } else {
          this.render();
        }
      } else {
        if (this.hoveredNote || this.hoverGrid) {
          this.hoveredNote = null;
          this.hoverGrid = null;
          this.render();
        }
      }
    });

    // Clear hover indicators on canvas leave
    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoverGrid || this.hoveredNote) {
        this.hoverGrid = null;
        this.hoveredNote = null;
        this.render();
      }
    });

    // MOUSE UP
    window.addEventListener('mouseup', () => {
      if (this.isMovingNote) {
        this.isMovingNote = false;
        this.movingNote = null;
        this.canvas.style.cursor = 'default';
        if (this.hasMovedNote) {
          this.render();
          if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
        }
      }

      if (this.isResizingNote) {
        this.isResizingNote = false;
        this.resizingNote = null;
        this.canvas.style.cursor = 'default';
        this.render();
        if (this.onNotesChange) this.onNotesChange(this.musicData.notes);
      }
      // End scrubbing
      if (this.isScrubbing) {
        this.isScrubbing = false;
        this.canvas.style.cursor = 'default';
        this.playOriginBeat = this.currentBeat;

        if (this.wasPlayingBeforeScrub && this.synth && this.musicData) {
          // Seamlessly resume playback from this scrubbed beat!
          this.synth.play(
            this.musicData.notes,
            this.musicData.tempo,
            this.synth.loop,
            this.musicData.totalBeats,
            this.currentBeat
          );
        } else if (this.synth) {
          this.synth.seek(this.currentBeat);
        }
        this.render();
      }

      if (this.isDraggingScrollbar) {
        this.isDraggingScrollbar = false;
      }

      if (this.isDraggingVerticalScrollbar) {
        this.isDraggingVerticalScrollbar = false;
      }

      if (this.isDragging) {
        this.isDragging = false;
        this.canvas.style.cursor = 'default';
      }

      if (this.activePitches.size > 0 && (!this.synth || !this.synth.isPlaying)) {
        this.activePitches.clear();
        this.render();
      }
    });

    // WHEEL SCROLLING & ZOOMING (FL Studio behavior)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pos = this.getCanvasMousePos(e);
      const kw = this.options.keyboardWidth;
      const rh = this.options.rulerHeight;

      // 1. Wheel over Piano Keyboard on the left -> Vertical Zoom (FL Studio behavior!)
      if (pos.x <= kw) {
        const delta = e.deltaY < 0 ? 2 : -2;
        this.setZoomY(delta);
        return;
      }

      // 2. Wheel over Timeline Ruler at top -> Horizontal Zoom (FL Studio behavior!)
      if (pos.y <= rh && pos.x > kw) {
        const delta = e.deltaY < 0 ? 6 : -6;
        this.setZoom(delta);
        return;
      }

      // 3. Modifier combinations
      if (e.altKey || (e.ctrlKey && e.shiftKey)) {
        // Alt + Wheel or Ctrl + Shift + Wheel = Vertical Zoom!
        const delta = e.deltaY < 0 ? 2 : -2;
        this.setZoomY(delta);
      } else if (e.ctrlKey) {
        // Ctrl + Wheel = Horizontal Zoom!
        this.setZoom(e.deltaY < 0 ? 6 : -6);
      } else if (e.shiftKey) {
        // Shift + Wheel = Horizontal Scroll
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scrollX += delta * 0.8;
        this.clampScroll();
        this.render();
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Touchpad horizontal swipe
        this.scrollX += e.deltaX * 0.8;
        this.clampScroll();
        this.render();
      } else {
        // Standard Wheel over grid = Vertical Scroll
        this.scrollY += Math.sign(e.deltaY) * (this.rowHeight * 1.5);
        this.clampScroll();
        this.render();
      }
    }, { passive: false });

    // Intercept middle-click auxclick so Windows/Chromium never triggers page auto-scroll
    this.canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Prevent context menu on canvas so right-drag pan works smoothly
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  pitchAtY(y) {
    const rh = this.options.rulerHeight;
    const sbY = this.height - this.options.scrollbarHeight;
    if (y < rh || y > sbY) return null;
    const relY = y - rh + this.scrollY;
    const row = Math.floor(relY / this.rowHeight);
    const pitch = this.maxPitch - row;
    if (pitch >= this.minPitch && pitch <= this.maxPitch) {
      return pitch;
    }
    return null;
  }

  yAtPitch(pitch) {
    const row = this.maxPitch - pitch;
    return this.options.rulerHeight + (row * this.rowHeight) - this.scrollY;
  }

  xAtBeat(beat) {
    return this.options.keyboardWidth + (beat * this.zoomX) - this.scrollX;
  }

  findNoteAt(x, y) {
    if (!this.musicData || !this.musicData.notes) return null;
    const kw = this.options.keyboardWidth;
    const rh = this.options.rulerHeight;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const sbY = this.height - this.options.scrollbarHeight;
    if (x <= kw || x >= this.width - vsw || y <= rh || y >= sbY) return null;

    for (const n of this.musicData.notes) {
      const nx = this.xAtBeat(n.startBeat);
      const nw = Math.max(8, n.duration * this.zoomX);
      const ny = this.yAtPitch(n.pitch);
      const nh = this.rowHeight;

      if (x >= nx && x <= (nx + nw) && y >= ny && y <= (ny + nh)) {
        return n;
      }
    }
    return null;
  }

  isBlackKey(pitch) {
    const semitone = pitch % 12;
    return [1, 3, 6, 8, 10].includes(semitone);
  }

  getScrollbarThumbRect() {
    const kw = this.options.keyboardWidth;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const trackWidth = this.width - kw - vsw;
    const totalWidth = (this.musicData ? this.musicData.totalBeats : 16) * this.zoomX;
    const visibleWidth = trackWidth;

    const thumbW = Math.max(30, Math.min(trackWidth, (visibleWidth / totalWidth) * trackWidth));
    const maxScroll = Math.max(1, totalWidth - trackWidth);
    const ratio = Math.max(0, Math.min(1, this.scrollX / maxScroll));
    const thumbX = kw + (ratio * (trackWidth - thumbW));

    return { x: thumbX, y: this.height - this.options.scrollbarHeight, w: thumbW, h: this.options.scrollbarHeight };
  }

  updatePlayback(currentBeat, activePitches) {
    if (this.isScrubbing) return;

    this.currentBeat = currentBeat;
    this.activePitches = activePitches || new Set();

    // Auto-scroll follow playhead (disabled by default so view doesn't jump disorientingly)
    if (this.options.autoScroll) {
      const playheadX = this.xAtBeat(currentBeat);
      const gridRight = this.width - 60;
      if (playheadX > gridRight) {
        this.scrollX += (playheadX - gridRight) + 50;
        this.clampScroll();
      } else if (playheadX < this.options.keyboardWidth) {
        this.scrollX = Math.max(0, (currentBeat * this.zoomX) - 20);
        this.clampScroll();
      }
    }

    this.render();
  }

  renderEmpty() {
    this.ctx.fillStyle = this.colors.bgDark;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = '#6e7f8e';
    this.ctx.font = '12px system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('No musical notes found to display', this.width / 2, this.height / 2);
  }

  render() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);

    const kw = this.options.keyboardWidth;
    const rh = this.options.rulerHeight;
    const sh = this.options.scrollbarHeight;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const gridH = this.height - rh - sh;

    // 1. Grid Background and Semitone Rows
    this.drawGridBackground(kw, rh, gridH);

    // 2. Measure and Beat Grid Lines
    this.drawGridLines(kw, rh, gridH);

    // 2b. Ghost Note preview on hover (FL Studio pencil snap indicator)
    this.drawGhostNote(kw, rh, gridH);

    // 3. Notes
    this.drawNotes(kw, rh, gridH);

    // 4. Playhead
    this.drawPlayhead(kw, rh, gridH);

    // 5. Left Piano Keyboard
    this.drawKeyboard(kw, rh, gridH);

    // 6. Top Ruler (Timeline measures and seek scrubber)
    this.drawRuler(kw, rh);

    // 7. Bottom Scrollbar
    this.drawScrollbar(kw, this.height - sh, sh);

    // 8. Right Vertical Scrollbar (FL Studio vertical overview)
    this.drawVerticalScrollbar(vsw, rh, gridH);
  }

  drawGridBackground(kw, rh, gridH) {
    const vsw = this.options.verticalScrollbarWidth || 8;
    const bottomY = rh + gridH;

    for (let p = this.maxPitch; p >= this.minPitch; p--) {
      const y = this.yAtPitch(p);
      if (y + this.rowHeight < rh || y > bottomY) continue;

      const isBlack = this.isBlackKey(p);
      this.ctx.fillStyle = isBlack ? this.colors.bgDark : this.colors.bgLight;
      this.ctx.fillRect(kw, y, this.width - kw - vsw, this.rowHeight);

      // Distinct octave line for C notes
      const isC = (p % 12 === 0);
      if (isC) {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
        this.ctx.lineWidth = 1.5;
      } else {
        this.ctx.strokeStyle = this.colors.gridSubLine;
        this.ctx.lineWidth = 1;
      }
      this.ctx.beginPath();
      this.ctx.moveTo(kw, y + this.rowHeight);
      this.ctx.lineTo(this.width - vsw, y + this.rowHeight);
      this.ctx.stroke();
    }
  }

  drawGridLines(kw, rh, gridH) {
    if (!this.musicData) return;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const beatsPerMeasure = this.musicData.beatsPerMeasure || 4;
    const totalBeats = Math.max(this.musicData.totalBeats, beatsPerMeasure * 4) + 8;
    const bottomY = rh + gridH;

    for (let b = 0; b <= totalBeats; b++) {
      const x = this.xAtBeat(b);
      if (x >= kw && x <= this.width - vsw) {
        const isMeasure = (b % beatsPerMeasure === 0);
        this.ctx.beginPath();
        this.ctx.moveTo(x, rh);
        this.ctx.lineTo(x, bottomY);

        if (isMeasure) {
          this.ctx.strokeStyle = this.colors.gridMeasureLine;
          this.ctx.lineWidth = 1.5;
        } else {
          this.ctx.strokeStyle = this.colors.gridBeatLine;
          this.ctx.lineWidth = 1;
        }
        this.ctx.stroke();
      }

      // Draw FL Studio sub-beat 8th and 16th step lines
      if (b < totalBeats && this.zoomX >= 22) {
        // 1/4 step (16th note)
        const x1 = this.xAtBeat(b + 0.25);
        if (x1 >= kw && x1 <= this.width - vsw && this.zoomX >= 36) {
          this.ctx.beginPath();
          this.ctx.moveTo(x1, rh);
          this.ctx.lineTo(x1, bottomY);
          this.ctx.strokeStyle = 'rgba(39, 52, 64, 0.45)';
          this.ctx.lineWidth = 0.5;
          this.ctx.stroke();
        }

        // 1/2 step (8th note)
        const x2 = this.xAtBeat(b + 0.5);
        if (x2 >= kw && x2 <= this.width - vsw) {
          this.ctx.beginPath();
          this.ctx.moveTo(x2, rh);
          this.ctx.lineTo(x2, bottomY);
          this.ctx.strokeStyle = this.colors.gridSubLine;
          this.ctx.lineWidth = 0.75;
          this.ctx.stroke();
        }

        // 3/4 step
        const x3 = this.xAtBeat(b + 0.75);
        if (x3 >= kw && x3 <= this.width - vsw && this.zoomX >= 36) {
          this.ctx.beginPath();
          this.ctx.moveTo(x3, rh);
          this.ctx.lineTo(x3, bottomY);
          this.ctx.strokeStyle = 'rgba(39, 52, 64, 0.45)';
          this.ctx.lineWidth = 0.5;
          this.ctx.stroke();
        }
      }
    }
  }

  drawGhostNote(kw, rh, gridH) {
    if (!this.editable || !this.hoverGrid || this.isMovingNote || this.isResizingNote || this.isDragging || this.isScrubbing) {
      return;
    }
    const { beat, pitch } = this.hoverGrid;
    if (pitch === null || beat === null) return;

    const x = this.xAtBeat(beat);
    const w = Math.max(6, (this.lastNoteDuration * this.zoomX) - 1.5);
    const y = this.yAtPitch(pitch) + 1;
    const h = this.rowHeight - 2;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const bottomY = rh + gridH;

    if (x + w < kw || x > this.width - vsw || y + h < rh || y > bottomY) return;

    this.ctx.save();
    this.ctx.fillStyle = 'rgba(143, 227, 162, 0.28)';
    this.ctx.strokeStyle = 'rgba(143, 227, 162, 0.75)';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([3, 2]);
    this.roundRect(this.ctx, x, y, w, h, 2.5, true, true);

    const noteLabel = this.midiToNoteName(pitch);
    if (w > 16 && h >= 10) {
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      this.ctx.font = 'bold 9.5px system-ui, sans-serif';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(noteLabel, x + 4, y + (h / 2));
    }
    this.ctx.restore();
  }

  drawNotes(kw, rh, gridH) {
    if (!this.musicData || !this.musicData.notes) return;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const bottomY = rh + gridH;

    for (const n of this.musicData.notes) {
      const x = this.xAtBeat(n.startBeat);
      const w = Math.max(6, (n.duration * this.zoomX) - 1.5);
      const y = this.yAtPitch(n.pitch) + 1;
      const h = this.rowHeight - 2;

      // Skip offscreen notes
      if (x + w < kw || x > this.width - vsw || y + h < rh || y > bottomY) continue;

      const isBeingMoved = (this.isMovingNote && this.movingNote === n);
      const isHovered = (this.hoveredNote === n);
      const isSounding = this.activePitches.has(n.pitch) && 
        (this.currentBeat >= n.startBeat && this.currentBeat < (n.startBeat + n.duration));

      // Note body
      this.ctx.fillStyle = isBeingMoved ? '#fde047' : (isSounding ? '#c7ffb0' : (isHovered ? this.colors.noteHover : this.colors.noteBg));
      this.roundRect(this.ctx, x, y, w, h, 2.5, true, false);

      // Note border
      this.ctx.strokeStyle = isBeingMoved ? '#eab308' : (isSounding ? '#2e7d32' : this.colors.noteBorder);
      this.ctx.lineWidth = isBeingMoved ? 1.5 : 1;
      this.roundRect(this.ctx, x, y, w, h, 2.5, false, true);

      // Pitch label inside the note (e.g. "F#6", "D#6", "C2", "G3")
      const noteLabel = n.name || this.midiToNoteName(n.pitch);
      if (w > 16 && h >= 10) {
        this.ctx.fillStyle = this.colors.noteText;
        this.ctx.font = 'bold 9.5px system-ui, sans-serif';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(noteLabel, x + 4, y + (h / 2));
      }


    }
  }

  drawPlayhead(kw, rh, gridH) {
    const vsw = this.options.verticalScrollbarWidth || 8;
    const x = this.xAtBeat(this.currentBeat);
    if (x < kw || x > this.width - vsw) return;
    const bottomY = rh + gridH;

    // Glowing playhead vertical line
    this.ctx.save();
    this.ctx.shadowColor = this.colors.playheadGlow;
    this.ctx.shadowBlur = 8;
    this.ctx.strokeStyle = this.colors.playhead;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x, rh);
    this.ctx.lineTo(x, bottomY);
    this.ctx.stroke();

    // Playhead arrow marker on ruler
    this.ctx.fillStyle = '#ff851b';
    this.ctx.beginPath();
    this.ctx.moveTo(x - 5, rh - 1);
    this.ctx.lineTo(x + 5, rh - 1);
    this.ctx.lineTo(x, rh + 5);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  drawKeyboard(kw, rh, gridH) {
    this.ctx.save();
    const bottomY = rh + gridH;

    for (let p = this.maxPitch; p >= this.minPitch; p--) {
      const y = this.yAtPitch(p);
      if (y + this.rowHeight < rh || y > bottomY) continue;

      const isBlack = this.isBlackKey(p);
      const isActive = this.activePitches.has(p);

      if (isBlack) {
        // Black key (width: 65% of kw)
        const blackW = Math.round(kw * 0.65);
        if (isActive) {
          // FL Studio: ONLY the black key itself lights up in orange!
          this.ctx.fillStyle = this.colors.keyActive;
          this.ctx.fillRect(0, y, blackW, this.rowHeight);
          this.ctx.strokeStyle = '#d35400';
          this.ctx.lineWidth = 1;
          this.ctx.strokeRect(0, y, blackW, this.rowHeight);
        } else {
          this.ctx.fillStyle = this.colors.keyBlack;
          this.ctx.fillRect(0, y, blackW, this.rowHeight);
          this.ctx.strokeStyle = this.colors.keyBlackBorder;
          this.ctx.lineWidth = 1;
          this.ctx.strokeRect(0, y, blackW, this.rowHeight);
        }

        // White key extension behind the black key remains normal white key color!
        this.ctx.fillStyle = '#b0b8c0';
        this.ctx.fillRect(blackW, y, kw - blackW, this.rowHeight);
      } else {
        // White key (full width kw)
        if (isActive) {
          this.ctx.fillStyle = '#ffaa5a'; // Warm amber-orange for white key
          this.ctx.fillRect(0, y, kw, this.rowHeight);
          this.ctx.strokeStyle = '#e67e22';
          this.ctx.lineWidth = 1;
          this.ctx.strokeRect(0, y, kw, this.rowHeight);
        } else {
          this.ctx.fillStyle = this.colors.keyWhite;
          this.ctx.fillRect(0, y, kw, this.rowHeight);
          this.ctx.strokeStyle = this.colors.keyWhiteBorder;
          this.ctx.lineWidth = 1;
          this.ctx.strokeRect(0, y, kw, this.rowHeight);
        }
      }

      // Key pitch name labels (e.g. C2, C3, C4, C5, C6...)
      const semitone = p % 12;
      const noteName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][semitone];
      const octave = Math.floor(p / 12) - 1;
      const isC = (semitone === 0);

      this.ctx.fillStyle = isActive ? this.colors.keyActiveText : (isC ? '#00e676' : (isBlack ? '#99aab5' : this.colors.keyLabel));
      this.ctx.font = isC ? 'bold 10px system-ui, sans-serif' : '9px system-ui, sans-serif';
      this.ctx.textAlign = 'right';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${noteName}${octave}`, kw - 4, y + (this.rowHeight / 2));
    }

    // Right border of keyboard
    this.ctx.strokeStyle = '#141b22';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(kw, rh);
    this.ctx.lineTo(kw, bottomY);
    this.ctx.stroke();

    this.ctx.restore();
  }

  drawRuler(kw, rh) {
    this.ctx.save();

    // Ruler bar background
    this.ctx.fillStyle = this.colors.rulerBg;
    this.ctx.fillRect(0, 0, this.width, rh);

    this.ctx.strokeStyle = this.colors.rulerBorder;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, rh);
    this.ctx.lineTo(this.width, rh);
    this.ctx.stroke();

    // Keyboard corner block
    this.ctx.fillStyle = '#11171d';
    this.ctx.fillRect(0, 0, kw, rh);
    this.ctx.strokeStyle = this.colors.rulerBorder;
    this.ctx.strokeRect(0, 0, kw, rh);

    // Hover seek preview line on ruler (only if NOT scrubbing)
    if (!this.isScrubbing && this.hoveredRulerX && this.hoveredRulerX > kw) {
      this.ctx.fillStyle = this.colors.rulerHover;
      this.ctx.fillRect(this.hoveredRulerX - 2, 0, 4, rh);
    }

    // Measure numbers (1, 2, 3, 4...)
    if (this.musicData) {
      const beatsPerMeasure = this.musicData.beatsPerMeasure || 4;
      const totalBeats = Math.max(this.musicData.totalBeats, beatsPerMeasure * 4) + 8;

      this.ctx.fillStyle = this.colors.rulerText;
      this.ctx.font = 'bold 10px system-ui, sans-serif';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'middle';

      for (let b = 0; b <= totalBeats; b += beatsPerMeasure) {
        const x = this.xAtBeat(b);
        if (x < kw || x > this.width) continue;

        const measureNumber = Math.floor(b / beatsPerMeasure) + 1;
        this.ctx.fillText(`${measureNumber}`, x + 5, rh / 2);

        // Small tick on ruler
        this.ctx.beginPath();
        this.ctx.moveTo(x, rh - 6);
        this.ctx.lineTo(x, rh);
        this.ctx.strokeStyle = this.colors.gridMeasureLine;
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      }
    }

    this.ctx.restore();
  }

  drawScrollbar(kw, sbY, sh) {
    this.ctx.save();
    const vsw = this.options.verticalScrollbarWidth || 8;

    // Background track
    this.ctx.fillStyle = this.colors.scrollbarBg;
    this.ctx.fillRect(0, sbY, this.width - vsw, sh);

    this.ctx.strokeStyle = '#222f3b';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, sbY);
    this.ctx.lineTo(this.width - vsw, sbY);
    this.ctx.stroke();

    // Draggable thumb
    const thumb = this.getScrollbarThumbRect();
    this.ctx.fillStyle = this.isDraggingScrollbar ? this.colors.scrollbarThumbHover : this.colors.scrollbarThumb;
    this.roundRect(this.ctx, thumb.x, thumb.y + 1, thumb.w, sh - 2, 2.5, true, false);

    this.ctx.restore();
  }

  drawVerticalScrollbar(vsw, rh, gridH) {
    this.ctx.save();
    const x = this.width - vsw;

    // Background track
    this.ctx.fillStyle = this.colors.scrollbarBg;
    this.ctx.fillRect(x, rh, vsw, gridH);

    // Left border divider
    this.ctx.strokeStyle = '#222f3b';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, rh);
    this.ctx.lineTo(x, rh + gridH);
    this.ctx.stroke();

    // Draggable thumb
    const thumb = this.getVerticalScrollbarThumbRect();
    this.ctx.fillStyle = this.isDraggingVerticalScrollbar ? this.colors.scrollbarThumbHover : this.colors.scrollbarThumb;
    this.roundRect(this.ctx, thumb.x + 1, thumb.y, vsw - 2, thumb.h, 2.5, true, false);

    this.ctx.restore();
  }

  getVerticalScrollbarThumbRect() {
    const rh = this.options.rulerHeight;
    const sh = this.options.scrollbarHeight;
    const vsw = this.options.verticalScrollbarWidth || 8;
    const gridH = this.height - rh - sh;

    const totalGridHeight = (this.pitchRange || 24) * this.rowHeight;
    const visibleH = gridH;

    const thumbH = Math.max(22, Math.min(gridH, (visibleH / totalGridHeight) * gridH));
    const maxScroll = Math.max(1, totalGridHeight - gridH);
    const ratio = Math.max(0, Math.min(1, this.scrollY / maxScroll));
    const thumbY = rh + (ratio * (gridH - thumbH));

    return { x: this.width - vsw, y: thumbY, w: vsw, h: thumbH };
  }

  roundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FLPianoRoll };
}
