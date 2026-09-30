/**
 * ABC Detection & DOM Injection Engine for Google NotebookLM
 * High-performance, zero-backtracking, virtualization-friendly engine.
 * Directly replaces ABC blocks in-place and hides raw notation.
 * Renders at most 5 active widgets from the bottom; older history is lazy-loaded on scroll.
 */

// Global volume and expression dynamics settings
let globalVolume = 0.7;
let globalExpression = 'balanced';
try {
  if (typeof localStorage !== 'undefined') {
    globalVolume = parseFloat(localStorage.getItem('nlm_fl_volume') || '0.7');
    globalExpression = localStorage.getItem('nlm_fl_expression') || 'balanced';
  }
} catch (e) {}

// Global IntersectionObserver for lazy-loading off-screen piano rolls in long chats
let lazyObserver = null;

function getLazyObserver() {
  if (!lazyObserver && typeof IntersectionObserver !== 'undefined') {
    lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const placeholder = entry.target;
          if (typeof placeholder.__hydrate === 'function') {
            lazyObserver.unobserve(placeholder);
            placeholder.__hydrate();
          }
        }
      }
    }, {
      rootMargin: '250px 0px',
      threshold: 0.01
    });
  }
  return lazyObserver;
}

/**
 * Checks whether an AI streaming generation is currently active in the page
 */
function isNotebookLMStreaming() {
  if (typeof document === 'undefined') return false;
  const stopBtn = document.querySelector(
    'button[aria-label*="Stop" i], ' +
    'button[aria-label*="Остановить" i], ' +
    'button[aria-label*="Cancel" i], ' +
    'button[title*="Stop" i], ' +
    'button[title*="Остановить" i], ' +
    '.stop-button, ' +
    '[data-streaming="true"], ' +
    '.streaming, ' +
    '.cursor-blink'
  );
  return !!stopBtn;
}

/**
 * Checks whether text contains an unclosed markdown code fence (``` or ~~~)
 */
function hasUnclosedFence(text) {
  if (!text) return false;
  const backtickMatches = text.match(/```/g);
  if (backtickMatches && backtickMatches.length % 2 !== 0) return true;
  const tildeMatches = text.match(/~~~/g);
  if (tildeMatches && tildeMatches.length % 2 !== 0) return true;
  return false;
}

/**
 * Validates that body contains musical elements (notes and barlines)
 */
function hasMusicContent(text) {
  if (!text || (!text.includes('|') && !text.includes(':'))) return false;
  const noteMatches = text.match(/[A-Ga-g]/g);
  return !!(noteMatches && noteMatches.length >= 4);
}

/**
 * High-performance, zero-backtracking linear ABC scanner.
 * Guarantees O(N) execution time, eliminating any possibility of ReDoS or browser freezing.
 * @param {string} text
 * @returns {Array<object>} Array of { abcString }
 */
function extractAllABC(text) {
  if (!text || text.length < 15) return [];

  const results = [];
  const lines = text.split(/\r?\n/);
  let currentBlock = [];
  let inBlock = false;
  let inFence = false;
  let hasK = false;
  let hasBars = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Markdown code fence boundaries (```abc ... ``` or ~~~abc ... ~~~)
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (inFence) {
        // Closing fence
        if (currentBlock.length > 0 && hasMusicContent(currentBlock.join('\n'))) {
          let abc = currentBlock.join('\n').trim();
          if (!abc.startsWith('X:')) abc = 'X:1\n' + abc;
          results.push({ abcString: abc });
        }
        currentBlock = [];
        inFence = false;
        inBlock = false;
        hasK = false;
        hasBars = false;
      } else {
        // Opening fence
        inFence = true;
        inBlock = true;
        currentBlock = [];
        hasK = false;
        hasBars = false;
      }
      continue;
    }

    if (inFence) {
      if (line.length > 0) {
        if (/^K:\s*[A-Ga-g]/i.test(line)) hasK = true;
        if (line.includes('|')) hasBars = true;
        currentBlock.push(rawLine);
      }
      continue;
    }

    // Unformatted text lines
    const isHeader = /^[A-Za-z]:\s*.+/.test(line);
    const isMusicLine = line.includes('|') && /[A-Ga-g]/.test(line);
    const isComment = line.startsWith('%');
    const isVoiceDirective = /^\[V:[^\]]+\]/.test(line);

    if (isHeader || (inBlock && (isMusicLine || isComment || isVoiceDirective))) {
      if (!inBlock) {
        // Potential start of an unformatted ABC score
        if (/^[XMTK]:/i.test(line)) {
          inBlock = true;
          currentBlock = [rawLine];
          hasK = /^K:\s*[A-Ga-g]/i.test(line);
          hasBars = isMusicLine;
        }
      } else {
        if (/^K:\s*[A-Ga-g]/i.test(line)) hasK = true;
        if (isMusicLine) hasBars = true;
        currentBlock.push(rawLine);
      }
    } else if (inBlock) {
      // Empty line or regular sentence ends the unformatted ABC block
      if (line === '' || /^\p{L}/u.test(line)) {
        if (currentBlock.length > 0 && hasMusicContent(currentBlock.join('\n'))) {
          let abc = currentBlock.join('\n').trim();
          if (!abc.startsWith('X:')) abc = 'X:1\n' + abc;
          results.push({ abcString: abc });
        }
        currentBlock = [];
        inBlock = false;
        hasK = false;
        hasBars = false;
      }
    }
  }

  if (currentBlock.length > 0 && hasMusicContent(currentBlock.join('\n'))) {
    // Only accept trailing unclosed block if streaming is complete or was not a code fence
    if (!inFence || !isNotebookLMStreaming()) {
      let abc = currentBlock.join('\n').trim();
      if (!abc.startsWith('X:')) abc = 'X:1\n' + abc;
      results.push({ abcString: abc });
    }
  }

  return results;
}

/**
 * Convenience single-match extractor
 * @param {string} text
 * @returns {object|null}
 */
function extractABC(text) {
  const all = extractAllABC(text);
  return all.length > 0 ? all[0] : null;
}

/**
 * Creates a lightweight placeholder for historical messages off-screen.
 * Replaces itself with a full FL Studio Piano Roll when scrolled into view or clicked.
 */
function createLazyPlaceholder(abcString, originalHostElement) {
  const musicData = parseABC(abcString);
  const placeholder = document.createElement('div');
  placeholder.className = 'fl-lazy-placeholder';
  placeholder.dataset.flLazy = 'true';
  placeholder.dataset.abcSnippet = abcString.slice(0, 40).replace(/\s+/g, '_');

  const key = musicData ? musicData.key : 'C';
  const meter = musicData ? musicData.meter : '4/4';
  const tempo = musicData ? musicData.tempo : 120;
  const title = (musicData && musicData.title) ? musicData.title : 'Piano Roll';

  placeholder.innerHTML = `
    <div class="fl-lazy-left">
      <span class="fl-lazy-icon">🎹</span>
      <div class="fl-lcd" style="height:21px; padding:1px 6px;">
        <span class="fl-lcd-key">${escapeHtml(key)}</span>
        <span class="fl-lcd-sep"></span>
        <span class="fl-lcd-meter">${escapeHtml(meter)}</span>
        <span class="fl-lcd-sep"></span>
        <span class="fl-lcd-bpm">${tempo}<small>BPM</small></span>
      </div>
      <span class="fl-lazy-title">${escapeHtml(title)}</span>
      <span class="fl-lazy-sub">• Scroll or click to load</span>
    </div>
    <button class="fl-lazy-btn">⚡ Load</button>
  `;

  let isHydrated = false;
  const hydrate = () => {
    if (isHydrated) return;
    isHydrated = true;
    if (lazyObserver) {
      lazyObserver.unobserve(placeholder);
    }
    const realWidget = createPianoRollWidget(abcString, originalHostElement);
    if (realWidget && placeholder.parentElement) {
      placeholder.parentElement.replaceChild(realWidget, placeholder);
    }
  };

  placeholder.__hydrate = hydrate;
  placeholder.onclick = (e) => {
    e.stopPropagation();
    hydrate();
  };

  const observer = getLazyObserver();
  if (observer) {
    observer.observe(placeholder);
  }

  return placeholder;
}

/**
 * Creates an interactive FL Studio Piano Roll widget element with compact toolbar
 */
function createPianoRollWidget(abcString, originalHostElement) {
  const musicData = parseABC(abcString);
  if (!musicData || !musicData.notes || musicData.notes.length === 0) {
    return null;
  }

  const widget = document.createElement('div');
  widget.className = 'fl-widget-container';
  widget.dataset.attachedAbc = 'true';
  widget.dataset.abcSnippet = abcString.slice(0, 40).replace(/\s+/g, '_');

  // Compact Single-Row Toolbar (Ultra-clean DAW transport bar)
  const toolbar = document.createElement('div');
  toolbar.className = 'fl-toolbar';

  // Left Section: Playback controls + FL Studio Recessed LCD display
  const leftGroup = document.createElement('div');
  leftGroup.className = 'fl-toolbar-left';

  const playBtn = document.createElement('button');
  playBtn.className = 'fl-btn fl-btn-play';
  playBtn.innerHTML = '▶ Play';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'fl-btn fl-btn-stop';
  stopBtn.innerHTML = '⏹';
  stopBtn.title = 'Stop and rewind to beginning';

  const lcd = document.createElement('div');
  lcd.className = 'fl-lcd';
  lcd.title = `Key: ${musicData.key} | Meter: ${musicData.meter} | Tempo: ${musicData.tempo} BPM`;
  lcd.innerHTML = `
    <span class="fl-lcd-key">${escapeHtml(musicData.key)}</span>
    <span class="fl-lcd-sep"></span>
    <span class="fl-lcd-meter">${escapeHtml(musicData.meter)}</span>
    <span class="fl-lcd-sep"></span>
    <span class="fl-lcd-bpm">${musicData.tempo}<small>BPM</small></span>
  `;

  const copyToPianoBtn = document.createElement('button');
  copyToPianoBtn.className = 'fl-btn fl-btn-copy-to-piano';
  copyToPianoBtn.innerHTML = '🎹 Copy to Piano';
  copyToPianoBtn.title = 'Copy notes directly into your editable Piano Roll (replaces existing notes)';
  copyToPianoBtn.onclick = () => {
    if (synth && synth.isPlaying) {
      synth.pause();
    }
    if (!activeComposer) {
      activeComposer = new NotebookLMComposer();
      const container = findNotebookLMInputContainer() || document.body;
      activeComposer.init(container);
    }
    activeComposer.loadScore(musicData);

    const oldHtml = copyToPianoBtn.innerHTML;
    copyToPianoBtn.innerHTML = '✔ Copied!';
    setTimeout(() => {
      copyToPianoBtn.innerHTML = oldHtml;
    }, 1200);
  };

  leftGroup.appendChild(playBtn);
  leftGroup.appendChild(stopBtn);
  leftGroup.appendChild(lcd);
  leftGroup.appendChild(copyToPianoBtn);

  // Right Section: Expression pill + Volume pill + Shortcuts info
  const rightGroup = document.createElement('div');
  rightGroup.className = 'fl-toolbar-right';

  // Expression Dynamics Pill (Soft Velvet / Balanced / Bright)
  const exprPill = document.createElement('div');
  exprPill.className = 'fl-tool-pill';
  exprPill.title = 'Piano Expression Dynamics (Hammer Velocity)';
  exprPill.innerHTML = `
    <span class="fl-tool-icon">🎹</span>
    <select class="fl-expr-select" title="Expression & Dynamics">
      <option value="soft" ${globalExpression === 'soft' ? 'selected' : ''}>Soft (Velvet)</option>
      <option value="balanced" ${globalExpression === 'balanced' ? 'selected' : ''}>Balanced</option>
      <option value="bright" ${globalExpression === 'bright' ? 'selected' : ''}>Bright</option>
    </select>
  `;
  const exprSelect = exprPill.querySelector('.fl-expr-select');

  // Volume Pill
  const volPill = document.createElement('div');
  volPill.className = 'fl-tool-pill';
  volPill.title = 'Master Volume';
  volPill.innerHTML = `
    <span class="fl-tool-icon">🔊</span>
    <input type="range" class="fl-vol-slider" min="0" max="1" step="0.05" value="${globalVolume}" title="Master Volume">
  `;
  const volSlider = volPill.querySelector('.fl-vol-slider');

  // Vertical Zoom Pill (↕ Zoom buttons)
  const zoomPill = document.createElement('div');
  zoomPill.className = 'fl-tool-pill fl-zoom-pill';
  zoomPill.title = 'Vertical Zoom (Key Height)\n• Click − / + to scale\n• Or scroll wheel over the piano keys!';
  zoomPill.innerHTML = `
    <span class="fl-tool-icon">↕</span>
    <button type="button" class="fl-btn-mini fl-zoom-btn-out" title="Make keys smaller (−)">−</button>
    <button type="button" class="fl-btn-mini fl-zoom-btn-in" title="Make keys taller (+)">+</button>
  `;
  zoomPill.querySelector('.fl-zoom-btn-out').onclick = (e) => {
    e.stopPropagation();
    pianoRoll.setZoomY(-2);
  };
  zoomPill.querySelector('.fl-zoom-btn-in').onclick = (e) => {
    e.stopPropagation();
    pianoRoll.setZoomY(2);
  };

  // Shortcuts Info Button (Icon with rich multi-line tooltip)
  const shortcutsBtn = document.createElement('button');
  shortcutsBtn.className = 'fl-btn fl-btn-icon';
  shortcutsBtn.innerHTML = '⌨';
  shortcutsBtn.title = 'Navigation & Shortcuts:\n• Wheel over Keys: Vertical Zoom (Key height)\n• Wheel over Ruler: Horizontal Zoom (Time)\n• Wheel over Grid: Vertical Scroll\n• Ctrl + Wheel: Horizontal Zoom\n• Shift + Wheel: Horizontal Scroll\n• Drag bottom bar: Resize height\n• Space: Play / Pause';

  rightGroup.appendChild(zoomPill);
  rightGroup.appendChild(exprPill);
  rightGroup.appendChild(volPill);
  rightGroup.appendChild(shortcutsBtn);

  toolbar.appendChild(leftGroup);
  toolbar.appendChild(rightGroup);

  // Canvas Wrapper
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'fl-canvas-wrap';

  widget.appendChild(toolbar);
  widget.appendChild(canvasWrap);

  // Initialize Synth and Canvas (Zero upfront Web Audio allocations)
  const synth = new PianoRollSynth({
    volume: globalVolume,
    expression: globalExpression
  });
  synth.setVolume(globalVolume);
  synth.setExpression(globalExpression);

  const pianoRoll = new FLPianoRoll(canvasWrap, {
    height: 280,
    synth: synth
  });
  pianoRoll.setData(musicData);

  // Bottom Resize Handle (drag to adjust height)
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'fl-resize-handle';
  resizeHandle.title = 'Drag to resize piano roll height | Double-click to reset (280px)';

  let isResizingH = false;
  let startResizeY = 0;
  let startH = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizingH = true;
    startResizeY = e.clientY;
    startH = pianoRoll.options.height || 280;
    document.body.style.cursor = 'ns-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizingH) return;
    const dy = e.clientY - startResizeY;
    const newH = Math.max(180, Math.min(750, startH + dy));
    pianoRoll.setHeight(newH);
  });

  window.addEventListener('mouseup', () => {
    if (isResizingH) {
      isResizingH = false;
      document.body.style.cursor = '';
    }
  });

  resizeHandle.addEventListener('dblclick', () => {
    pianoRoll.setHeight(280);
  });

  widget.appendChild(resizeHandle);

  // Wire up audio playback callbacks
  synth.onProgress = (currentBeat, activePitches) => {
    pianoRoll.updatePlayback(currentBeat, activePitches);
  };

  synth.onEnded = () => {
    playBtn.innerHTML = '▶ Play';
    playBtn.classList.remove('is-playing');
    pianoRoll.seekTo(synth.playOriginBeat !== undefined ? synth.playOriginBeat : 0);
  };

  // Link Spacebar play/pause toggle
  pianoRoll.togglePlay = () => {
    playBtn.click();
  };

  // Button actions (AudioContext and samples loaded strictly on-demand on user click)
  playBtn.onclick = async () => {
    await synth.ensureResumed();
    if (!synth.isPlaying) {
      // Stop any other currently playing piano roll on the page
      if (typeof registeredRolls !== 'undefined') {
        for (const roll of registeredRolls) {
          if (roll !== pianoRoll && roll.synth && roll.synth.isPlaying) {
            roll.synth.stop(true);
          }
        }
      }

      let startBeat = (synth.playOriginBeat !== undefined) ? synth.playOriginBeat : pianoRoll.currentBeat;
      if (startBeat >= (musicData.totalBeats - 0.05)) {
        startBeat = 0;
      }
      synth.play(musicData.notes, musicData.tempo, true, musicData.totalBeats, startBeat);
      playBtn.innerHTML = '⏸ Pause';
      playBtn.classList.add('is-playing');
    } else {
      synth.pause();
      playBtn.innerHTML = '▶ Play';
      playBtn.classList.remove('is-playing');
    }
  };

  stopBtn.onclick = () => {
    synth.stop(true);
    pianoRoll.seekTo(0);
  };

  volSlider.oninput = (e) => {
    const val = parseFloat(e.target.value);
    globalVolume = val;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('nlm_fl_volume', val.toString());
      }
    } catch (err) {}
    synth.setVolume(val);
  };

  exprSelect.onchange = (e) => {
    const val = e.target.value;
    globalExpression = val;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('nlm_fl_expression', val);
      }
    } catch (err) {}
    synth.setExpression(val);
  };

  // Intercept middle-click (wheel click) on widget to prevent browser page autoscroll
  widget.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  widget.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  widget.synth = synth;
  widget.pianoRoll = pianoRoll;

  // Live dynamic update method for streaming tokens
  widget.updateData = (newAbc) => {
    try {
      const parsed = ABCParser.parse(newAbc);
      if (parsed && parsed.notes && parsed.notes.length > 0) {
        musicData = parsed;
        pianoRoll.setData(parsed);
        if (lcd) {
          lcd.title = `Key: ${parsed.key} | Meter: ${parsed.meter} | Tempo: ${parsed.tempo} BPM`;
          const keyEl = lcd.querySelector('.fl-lcd-key');
          if (keyEl) keyEl.textContent = parsed.key;
          const meterEl = lcd.querySelector('.fl-lcd-meter');
          if (meterEl) meterEl.textContent = parsed.meter;
          const bpmEl = lcd.querySelector('.fl-lcd-bpm');
          if (bpmEl) bpmEl.innerHTML = `${parsed.tempo}<small>BPM</small>`;
        }
      }
    } catch (err) {
      console.warn('Live ABC update error:', err);
    }
  };

  return widget;
}

/**
 * Inspects a NotebookLM chat message and replaces ABC blocks in-place with Piano Roll widgets.
 * Fully supports live streaming updates so widgets continuously sync with streamed tokens.
 * @param {HTMLElement} messageNode
 * @param {boolean} immediate - If true, mounts full widget immediately; if false, mounts lazy placeholder
 */
function processNotebookLMMessage(messageNode, immediate = true) {
  if (!messageNode) return;

  const fullText = messageNode.textContent || '';
  const isStreaming = isNotebookLMStreaming();
  const unclosed = hasUnclosedFence(fullText);

  // Circuit breaker: only skip if message has already been finalized and is not streaming
  if (messageNode.dataset.flProcessed === 'true') return;

  // 1. First: inspect all code blocks (<pre> elements)
  const preElements = Array.from(messageNode.querySelectorAll('pre'));
  for (const pre of preElements) {
    if (pre.closest('.fl-widget-container, .fl-lazy-placeholder')) continue;

    const preText = pre.textContent || '';
    if (hasMusicContent(preText)) {
      const abcMatch = extractABC(preText);
      if (abcMatch) {
        const container = pre.closest('.code-block, .snippet-container, pre') || pre;

        // If widget already attached to this container, update its notes in real-time as tokens stream
        if (container._flWidget && typeof container._flWidget.updateData === 'function') {
          if (container.dataset.flLastAbc !== abcMatch.abcString) {
            container._flWidget.updateData(abcMatch.abcString);
            container.dataset.flLastAbc = abcMatch.abcString;
          }
          continue;
        }

        if (pre.dataset.flAttached === 'true') continue;

        const elem = immediate
          ? createPianoRollWidget(abcMatch.abcString, container)
          : createLazyPlaceholder(abcMatch.abcString, container);

        if (elem) {
          pre.dataset.flAttached = 'true';
          container.dataset.flAttached = 'true';
          container._flWidget = elem;
          container.dataset.flLastAbc = abcMatch.abcString;
          container.style.display = 'none'; // Hide the ABC code block cleanly
          // Insert the Piano Roll widget in-place directly where the ABC code was!
          container.parentElement.insertBefore(elem, container);
        }
      }
    }
  }

  // 2. Second: inspect all text blocks across the message
  if (hasMusicContent(fullText)) {
    const allFound = extractAllABC(fullText);
    for (const item of allFound) {
      const snippetId = item.abcString.slice(0, 40).replace(/\s+/g, '_');
      if (messageNode.querySelector(`[data-abc-snippet="${snippetId}"]`)) {
        continue;
      }

      // Find candidate elements in messageNode
      const candidates = Array.from(messageNode.querySelectorAll('p, div, paragraph-element-view, [class*="paragraph"]'));
      const firstLine = item.abcString.split('\n')[0].trim();
      let targetEl = null;

      for (const el of candidates) {
        if (el.closest('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer')) continue;
        if (el.textContent && el.textContent.includes(firstLine)) {
          targetEl = el;
          break;
        }
      }

      // Fallback: look for music line with barline
      if (!targetEl) {
        const musicLine = item.abcString.split('\n').find(l => l.includes('|') && /[A-Ga-g]/.test(l));
        if (musicLine) {
          for (const el of candidates) {
            if (el.closest('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer')) continue;
            if (el.textContent && el.textContent.includes(musicLine.trim())) {
              targetEl = el;
              break;
            }
          }
        }
      }

      if (!targetEl) {
        targetEl = messageNode.querySelector('.message-text-content, .message-content') || messageNode;
      }

      const hostContainer = targetEl.closest('.paragraph, [class*="paragraph"], p, pre, .code-block, paragraph-element-view') || targetEl;

      // If widget already attached, update its notes in real-time
      if (hostContainer._flWidget && typeof hostContainer._flWidget.updateData === 'function') {
        if (hostContainer.dataset.flLastAbc !== item.abcString) {
          hostContainer._flWidget.updateData(item.abcString);
          hostContainer.dataset.flLastAbc = item.abcString;
        }
        continue;
      }

      const elem = immediate
        ? createPianoRollWidget(item.abcString, hostContainer)
        : createLazyPlaceholder(item.abcString, hostContainer);

      if (elem) {
        hostContainer._flWidget = elem;
        hostContainer.dataset.flLastAbc = item.abcString;
        if (hostContainer !== messageNode && hostContainer.parentElement) {
          hostContainer.style.display = 'none';
          hostContainer.parentElement.insertBefore(elem, hostContainer);
        } else {
          targetEl.style.display = 'none';
          targetEl.parentElement.insertBefore(elem, targetEl);
        }
      }
    }
  }

  // Mark this message node as completely processed ONLY when streaming has finished and no unclosed fences remain
  if (!isStreaming && !unclosed) {
    if (messageNode.querySelector('.fl-widget-container, .fl-lazy-placeholder') || !hasMusicContent(fullText)) {
      messageNode.dataset.flProcessed = 'true';
    }
  }
}

/**
 * Converts note array into standard ABC notation with measure-aware accidentals.
 * In ABC standard, accidentals persist until the end of the measure for that letter.
 * If a note in the same measure is natural after a sharp/flat, it MUST explicitly be preceded by '='.
 */
function midiToABCPitch(midiPitch, measureAccs = {}) {
  const PITCH_MAP = [
    { name: 'C', acc: 0 },
    { name: 'C', acc: 1 },
    { name: 'D', acc: 0 },
    { name: 'D', acc: 1 },
    { name: 'E', acc: 0 },
    { name: 'F', acc: 0 },
    { name: 'F', acc: 1 },
    { name: 'G', acc: 0 },
    { name: 'G', acc: 1 },
    { name: 'A', acc: 0 },
    { name: 'A', acc: 1 },
    { name: 'B', acc: 0 }
  ];

  const octave = Math.floor(midiPitch / 12) - 1;
  const semitone = ((midiPitch % 12) + 12) % 12;
  const p = PITCH_MAP[semitone];
  const baseLetter = p.name;

  let prefix = '';
  const currentAlter = (measureAccs[baseLetter] !== undefined) ? measureAccs[baseLetter] : 0;

  if (p.acc === 1) {
    prefix = '^';
    measureAccs[baseLetter] = 1;
  } else {
    if (currentAlter !== 0) {
      prefix = '=';
      measureAccs[baseLetter] = 0;
    }
  }

  let noteStr = prefix;
  if (octave >= 5) {
    noteStr += p.name.toLowerCase();
    const ticks = octave - 5;
    if (ticks > 0) noteStr += "'".repeat(ticks);
  } else if (octave === 4) {
    noteStr += p.name;
  } else {
    noteStr += p.name;
    const commas = 4 - octave;
    noteStr += ",".repeat(commas);
  }
  return noteStr;
}

function quantize(val, step = 0.25) {
  return Math.round(Math.round(val / step) * step * 10000) / 10000;
}

function formatABCDuration(durationInBeats) {
  const qBeats = quantize(durationInBeats, 0.25);
  const unitsTimes2 = Math.round(qBeats * 4); // each 0.25 beat = 0.5 unit in L:1/8
  if (unitsTimes2 === 2) return '';           // 0.5 beats = 1 unit
  if (unitsTimes2 === 1) return '/2';         // 0.25 beats = 0.5 unit
  if (unitsTimes2 % 2 === 0) {
    return (unitsTimes2 / 2).toString();      // Integer units e.g. 2, 3, 4, 6, 8
  }
  return `${unitsTimes2}/2`;                  // Fractional units e.g. 3/2, 5/2, 7/2
}

function formatABCRest(restInBeats) {
  let qBeats = quantize(restInBeats, 0.25);
  let out = '';

  while (qBeats >= 0.24) {
    if (qBeats >= 4.0) {
      out += 'z8 ';
      qBeats -= 4.0;
    } else if (qBeats >= 3.0) {
      out += 'z6 ';
      qBeats -= 3.0;
    } else if (qBeats >= 2.0) {
      out += 'z4 ';
      qBeats -= 2.0;
    } else if (qBeats >= 1.5) {
      out += 'z3 ';
      qBeats -= 1.5;
    } else if (qBeats >= 1.0) {
      out += 'z2 ';
      qBeats -= 1.0;
    } else if (qBeats >= 0.5) {
      out += 'z ';
      qBeats -= 0.5;
    } else if (qBeats >= 0.25) {
      out += 'z/2 ';
      qBeats -= 0.25;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Formats a single voice's notes as an ABC music body string.
 * Strictly adheres to ABC 2.1 standard:
 * 1. Notes crossing measure barlines are cleanly split and tied across the barline (- |).
 * 2. Chords are formatted cleanly without internal spaces: [CEGBd].
 * 3. Every measure is mathematically padded with exact rests to match beatsPerMeasure.
 */
function formatSingleVoiceABC(notes, totalBeats, beatsPerMeasure) {
  // Step 1: Slice notes that cross barline boundaries and add ties
  const slicedNotes = [];
  for (const n of notes) {
    let curBeat = Math.max(0, quantize(n.startBeat, 0.25));
    let remDur = Math.max(0.25, quantize(n.duration, 0.25));
    while (remDur > 0.01) {
      const nextBar = (Math.floor(curBeat / beatsPerMeasure) + 1) * beatsPerMeasure;
      const chunkDur = quantize(Math.min(remDur, nextBar - curBeat), 0.25);
      const isTied = remDur > chunkDur + 0.01;
      slicedNotes.push({
        pitch: n.pitch,
        startBeat: curBeat,
        duration: chunkDur,
        hasTie: isTied
      });
      curBeat = quantize(curBeat + chunkDur, 0.25);
      remDur = quantize(remDur - chunkDur, 0.25);
    }
  }

  // Step 2: Group notes by startBeat into chord groups
  const groups = [];
  for (const n of slicedNotes) {
    let g = groups.find(x => Math.abs(x.startBeat - n.startBeat) < 0.05);
    if (!g) {
      g = { startBeat: n.startBeat, duration: n.duration, pitches: [], hasTie: n.hasTie };
      groups.push(g);
    }
    if (!g.pitches.includes(n.pitch)) {
      g.pitches.push(n.pitch);
    }
    if (n.hasTie) g.hasTie = true;
  }
  groups.sort((a, b) => a.startBeat - b.startBeat || b.pitches[0] - a.pitches[0]);

  // Step 3: Emit measure by measure with exact barlines and rests
  const numMeasures = Math.max(1, Math.ceil(totalBeats / beatsPerMeasure));
  let body = '| ';

  for (let m = 0; m < numMeasures; m++) {
    const measureStart = m * beatsPerMeasure;
    const measureEnd = (m + 1) * beatsPerMeasure;
    let curBeat = measureStart;
    const measureAccs = {}; // Reset accidentals per measure!

    const measureGroups = groups.filter(g => g.startBeat >= measureStart - 0.01 && g.startBeat < measureEnd - 0.01);

    for (const g of measureGroups) {
      if (g.startBeat > curBeat + 0.01) {
        const restDur = quantize(g.startBeat - curBeat, 0.25);
        body += formatABCRest(restDur);
        curBeat = g.startBeat;
      }

      const tieSuffix = g.hasTie ? '-' : '';
      if (g.pitches.length === 1) {
        body += midiToABCPitch(g.pitches[0], measureAccs) + formatABCDuration(g.duration) + tieSuffix + ' ';
      } else {
        const notesStr = g.pitches.map(p => midiToABCPitch(p, measureAccs)).join('');
        body += `[${notesStr}]${formatABCDuration(g.duration)}${tieSuffix} `;
      }
      curBeat = quantize(curBeat + g.duration, 0.25);
    }

    if (curBeat < measureEnd - 0.01) {
      const restDur = quantize(measureEnd - curBeat, 0.25);
      body += formatABCRest(restDur);
      curBeat = measureEnd;
    }

    body += (m === numMeasures - 1) ? '||' : '| ';
  }

  return body.trim();
}

/**
 * Partitions notes into voice layers where each voice contains
 * only non-overlapping notes (or same-start same-duration chords).
 */
function partitionNotesIntoVoices(notes) {
  const voices = [];

  for (const n of notes) {
    let placed = false;
    for (const v of voices) {
      // Check if any note in this voice starts at the same beat
      const sameStart = v.filter(vn => Math.abs(vn.startBeat - n.startBeat) < 0.05);
      if (sameStart.length > 0) {
        // Can only join this voice if duration matches (forms a chord)
        if (Math.abs(sameStart[0].duration - n.duration) < 0.05) {
          v.push(n);
          placed = true;
          break;
        }
        // Different duration at same beat -> must go to another voice
      } else {
        // Check for time overlap with any existing note in this voice
        const overlaps = v.some(vn => {
          const vEnd = vn.startBeat + vn.duration;
          const nEnd = n.startBeat + n.duration;
          return (n.startBeat < vEnd - 0.05) && (nEnd > vn.startBeat + 0.05);
        });
        if (!overlaps) {
          v.push(n);
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      voices.push([n]);
    }
  }
  return voices;
}

function notesToABC(notes, options = {}) {
  const key = options.key || 'C';
  const meter = options.meter || '4/4';
  const tempo = options.tempo || 120;
  let beatsPerMeasure = 4;
  if (meter) {
    const parts = meter.split('/');
    if (parts.length === 2) {
      const num = parseInt(parts[0], 10);
      const den = parseInt(parts[1], 10);
      if (num && den) {
        beatsPerMeasure = (num / den) * 4;
      }
    }
  }

  const header = `X:1\nT:Melody\nM:${meter}\nL:1/8\nQ:1/4=${tempo}\nK:${key}\n`;
  if (!notes || notes.length === 0) {
    return header + '| z8 | z8 ||\n';
  }

  // Strictly quantize all note timings to clean musical fractions
  const cleanNotes = notes.map(n => ({
    pitch: n.pitch,
    startBeat: Math.max(0, quantize(n.startBeat, 0.25)),
    duration: Math.max(0.25, quantize(n.duration, 0.25))
  })).sort((a, b) => a.startBeat - b.startBeat || b.pitch - a.pitch);

  // Partition notes into non-overlapping voice layers
  // Notes at the same startBeat with same duration form chords within one voice
  // Notes at the same startBeat with different durations go to separate voices
  const voices = partitionNotesIntoVoices(cleanNotes);

  // Find total length (pad to full measures)
  let maxBeat = 0;
  for (const n of cleanNotes) {
    maxBeat = Math.max(maxBeat, n.startBeat + n.duration);
  }
  const paddedTotal = Math.max(beatsPerMeasure, Math.ceil(maxBeat / beatsPerMeasure) * beatsPerMeasure);

  if (voices.length === 1) {
    // Single voice: no V: directives needed
    return header + formatSingleVoiceABC(voices[0], paddedTotal, beatsPerMeasure) + '\n';
  }

  // Multiple voices: use V: directives
  let body = '';
  voices.forEach((v, idx) => {
    body += `V:${idx + 1}\n` + formatSingleVoiceABC(v, paddedTotal, beatsPerMeasure) + '\n';
  });
  return header + body;
}

/**
 * Finds the exact NotebookLM query textarea from user's DOM
 */
function findNotebookLMTextarea() {
  return (
    document.querySelector('textarea.query-box-input') ||
    document.querySelector('textarea[aria-label="Query box"]') ||
    document.querySelector('textarea[placeholder*="Ask a question"]') ||
    document.querySelector('.query-box-input-wrapper textarea') ||
    document.querySelector('form.form textarea') ||
    document.querySelector('query-box textarea') ||
    document.querySelector('textarea')
  );
}

/**
 * Finds NotebookLM input prompt container
 */
function findNotebookLMInputContainer() {
  const textarea = findNotebookLMTextarea();
  if (textarea) {
    const form = textarea.closest('form.form, form, .message-container, query-box, .query-box');
    if (form) return form;
  }

  const selectors = [
    'form.form:has(textarea.query-box-input)',
    'form:has(.query-box-input)',
    '.message-container',
    '.query-box-input-wrapper',
    'query-box',
    '.query-box'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (e) {}
  }

  return null;
}

/**
 * Bulletproof prompt text inserter supporting textarea and contenteditable
 */
function insertTextIntoNotebookLM(textToInsert) {
  const input = findNotebookLMTextarea();
  if (!input) {
    if (navigator.clipboard) navigator.clipboard.writeText(textToInsert);
    return false;
  }

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const curVal = input.value || '';
    const start = input.selectionStart ?? curVal.length;
    const end = input.selectionEnd ?? curVal.length;

    const before = curVal.substring(0, start);
    const after = curVal.substring(end);

    const prefix = (before.length > 0 && !before.endsWith('\n')) ? '\n\n' : '';
    const newText = before + prefix + textToInsert + '\n' + after;

    const proto = window.HTMLTextAreaElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (valueSetter) {
      valueSetter.call(input, newText);
    } else {
      input.value = newText;
    }

    const newPos = (before + prefix + textToInsert + '\n').length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;

    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: textToInsert
      }));
    } catch (e) {}

    // Enable NotebookLM submit button
    const form = input.closest('form');
    if (form) {
      const submitBtn = form.querySelector('nb-icon-button.submit-button button, button[aria-label="Submit"]');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute('disabled');
        submitBtn.classList.remove('mat-mdc-button-disabled');
      }
      const nbBtn = form.querySelector('nb-icon-button.submit-button');
      if (nbBtn) {
        nbBtn.classList.remove('nb-button-disabled');
      }
    }
  } else if (input.isContentEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(textToInsert + '\n');
      range.insertNode(node);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      input.textContent += '\n' + textToInsert + '\n';
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return true;
}

let activeComposer = null;

class NotebookLMComposer {
  constructor() {
    this.drawer = null;
    this.pianoRoll = null;
    this.synth = null;
    this.isOpen = false;
    this.toggleBtn = null;
    this.currentContainer = null;
    this.lcdNotes = null;
  }

  init(inputContainer) {
    if (this.currentContainer === inputContainer && this.drawer && document.body.contains(this.drawer)) {
      return;
    }
    this.currentContainer = inputContainer;

    // 1. Create or attach the Toggle Button in the input bar
    if (!this.toggleBtn) {
      this.toggleBtn = document.createElement('button');
      this.toggleBtn.className = 'fl-input-composer-btn';
      this.toggleBtn.type = 'button';
      this.toggleBtn.innerHTML = '🎹 Piano Roll';
      this.toggleBtn.title = 'Open interactive FL Studio Piano Roll composer';
      this.toggleBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      };
    }

    // Place toggleBtn in .bottom-right-container or input bar
    const bottomRight = inputContainer.querySelector('.bottom-right-container');
    if (bottomRight) {
      const selectedNum = bottomRight.querySelector('.selected-num-container');
      if (selectedNum && !bottomRight.contains(this.toggleBtn)) {
        bottomRight.insertBefore(this.toggleBtn, selectedNum);
      } else if (!bottomRight.contains(this.toggleBtn)) {
        bottomRight.prepend(this.toggleBtn);
      }
    } else {
      const btnRow = inputContainer.querySelector('.buttons, .actions, .controls, .bottom-row, .leading-actions') || inputContainer;
      if (!btnRow.contains(this.toggleBtn)) {
        btnRow.appendChild(this.toggleBtn);
      }
    }

    // 2. Create Modal Overlay if not created yet
    if (!this.drawer) {
      this.drawer = document.createElement('div');
      this.drawer.className = 'fl-composer-modal-overlay';
      this.drawer.style.display = 'none';

      const modalWindow = document.createElement('div');
      modalWindow.className = 'fl-composer-modal-window';

      // Header with Title and Close button
      const modalHeader = document.createElement('div');
      modalHeader.className = 'fl-modal-header';
      modalHeader.innerHTML = `
        <div class="fl-modal-title-group">
          <span class="fl-modal-title">🎹 FL Studio Piano Roll</span>
          <span class="fl-modal-subtitle">Left click: draw / move | Right edge: resize | 🧲 Snap</span>
        </div>
        <button type="button" class="fl-modal-close-btn" title="Close (Esc)">✕</button>
      `;
      modalHeader.querySelector('.fl-modal-close-btn').onclick = () => this.toggle(false);

      // Toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'fl-toolbar';

      // Left section: transport + clear + LCD
      const leftGroup = document.createElement('div');
      leftGroup.className = 'fl-toolbar-left';

      const playBtn = document.createElement('button');
      playBtn.className = 'fl-btn fl-btn-play';
      playBtn.type = 'button';
      playBtn.innerHTML = '▶ Play';

      const stopBtn = document.createElement('button');
      stopBtn.className = 'fl-btn fl-btn-stop';
      stopBtn.type = 'button';
      stopBtn.innerHTML = '⏹';
      stopBtn.title = 'Stop and rewind';

      const clearBtn = document.createElement('button');
      clearBtn.className = 'fl-btn fl-btn-icon fl-btn-clear';
      clearBtn.type = 'button';
      clearBtn.innerHTML = '🗑 Clear';
      clearBtn.title = 'Clear piano roll notes';

      const loadMidiBtn = document.createElement('button');
      loadMidiBtn.className = 'fl-btn fl-btn-load-midi';
      loadMidiBtn.type = 'button';
      loadMidiBtn.innerHTML = '📁 Load MIDI';
      loadMidiBtn.title = 'Import standard MIDI file (.mid, .midi) with strict musical quantization';

      const midiFileInput = document.createElement('input');
      midiFileInput.type = 'file';
      midiFileInput.accept = '.mid,.midi,audio/midi';
      midiFileInput.style.display = 'none';

      loadMidiBtn.onclick = () => {
        midiFileInput.click();
      };

      midiFileInput.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const buffer = ev.target.result;
            const quantStep = (this.pianoRoll && this.pianoRoll.snapStep) ? this.pianoRoll.snapStep : 0.25;
            const parsedData = (typeof MIDIParser !== 'undefined' && MIDIParser.parse)
              ? MIDIParser.parse(buffer, { quantizeStep: quantStep })
              : (typeof parseMIDI === 'function' ? parseMIDI(buffer, { quantizeStep: quantStep }) : null);

            if (!parsedData || !parsedData.notes || parsedData.notes.length === 0) {
              alert('No musical notes found in this MIDI file.');
              return;
            }

            this.loadScore(parsedData);

            const oldHtml = loadMidiBtn.innerHTML;
            loadMidiBtn.innerHTML = '✔ Loaded!';
            setTimeout(() => { loadMidiBtn.innerHTML = oldHtml; }, 1500);
          } catch (err) {
            console.error('MIDI parse error:', err);
            alert('Failed to parse MIDI file: ' + (err.message || err));
          }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
      };

      const lcd = document.createElement('div');
      lcd.className = 'fl-lcd';
      lcd.innerHTML = `
        <span class="fl-lcd-key">C</span>
        <span class="fl-lcd-sep"></span>
        <span class="fl-lcd-meter">4/4</span>
        <span class="fl-lcd-sep"></span>
        <span class="fl-lcd-bpm">120<small>BPM</small></span>
        <span class="fl-lcd-sep"></span>
        <span class="fl-lcd-notes" style="color:#a5b4fc;">0 notes</span>
      `;
      this.lcdKey = lcd.querySelector('.fl-lcd-key');
      this.lcdMeter = lcd.querySelector('.fl-lcd-meter');
      this.lcdBpm = lcd.querySelector('.fl-lcd-bpm');
      this.lcdNotes = lcd.querySelector('.fl-lcd-notes');

      leftGroup.appendChild(playBtn);
      leftGroup.appendChild(stopBtn);
      leftGroup.appendChild(clearBtn);
      leftGroup.appendChild(loadMidiBtn);
      leftGroup.appendChild(midiFileInput);
      leftGroup.appendChild(lcd);

      // Right section: Snap + Expression + Volume
      const rightGroup = document.createElement('div');
      rightGroup.className = 'fl-toolbar-right';

      const snapPill = document.createElement('div');
      snapPill.className = 'fl-tool-pill';
      snapPill.title = 'Grid Snap (FL Studio Magnet)';
      snapPill.innerHTML = `
        <span class="fl-tool-icon">🧲</span>
        <select class="fl-snap-select" title="Grid Snap Step">
          <option value="0.25" selected>1/4 Step</option>
          <option value="0.5">1/2 Beat</option>
          <option value="1">1 Beat</option>
          <option value="0.125">1/8 Fine</option>
          <option value="4">1 Bar</option>
        </select>
      `;
      const snapSelect = snapPill.querySelector('.fl-snap-select');
      snapSelect.onchange = (e) => {
        const val = parseFloat(e.target.value);
        if (this.pianoRoll) {
          this.pianoRoll.snapStep = val;
          this.pianoRoll.render();
        }
      };

      const exprPill = document.createElement('div');
      exprPill.className = 'fl-tool-pill';
      exprPill.title = 'Piano Expression Dynamics';
      exprPill.innerHTML = `
        <span class="fl-tool-icon">🎹</span>
        <select class="fl-expr-select">
          <option value="soft" ${globalExpression === 'soft' ? 'selected' : ''}>Soft</option>
          <option value="balanced" ${globalExpression === 'balanced' ? 'selected' : ''}>Balanced</option>
          <option value="bright" ${globalExpression === 'bright' ? 'selected' : ''}>Bright</option>
        </select>
      `;

      const volPill = document.createElement('div');
      volPill.className = 'fl-tool-pill';
      volPill.title = 'Master Volume';
      volPill.innerHTML = `
        <span class="fl-tool-icon">🔊</span>
        <input type="range" class="fl-vol-slider" min="0" max="1" step="0.05" value="${globalVolume}">
      `;

      const zoomPill = document.createElement('div');
      zoomPill.className = 'fl-tool-pill fl-zoom-pill';
      zoomPill.title = 'Vertical Zoom (Key Height)\n• Click − / + to scale\n• Or scroll wheel over the piano keys!';
      zoomPill.innerHTML = `
        <span class="fl-tool-icon">↕</span>
        <button type="button" class="fl-btn-mini fl-zoom-btn-out" title="Make keys smaller (−)">−</button>
        <button type="button" class="fl-btn-mini fl-zoom-btn-in" title="Make keys taller (+)">+</button>
      `;
      zoomPill.querySelector('.fl-zoom-btn-out').onclick = (e) => {
        e.stopPropagation();
        if (this.pianoRoll) this.pianoRoll.setZoomY(-2);
      };
      zoomPill.querySelector('.fl-zoom-btn-in').onclick = (e) => {
        e.stopPropagation();
        if (this.pianoRoll) this.pianoRoll.setZoomY(2);
      };

      rightGroup.appendChild(zoomPill);
      rightGroup.appendChild(snapPill);
      rightGroup.appendChild(exprPill);
      rightGroup.appendChild(volPill);

      toolbar.appendChild(leftGroup);
      toolbar.appendChild(rightGroup);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'fl-canvas-wrap fl-composer-canvas-wrap';
      canvasWrap.style.flex = '1 1 auto';
      canvasWrap.style.height = '100%';
      canvasWrap.style.minHeight = '0';
      canvasWrap.style.position = 'relative';
      canvasWrap.style.overflow = 'hidden';

      // Modal Footer with Cancel & Apply buttons
      const modalFooter = document.createElement('div');
      modalFooter.className = 'fl-modal-footer';
      modalFooter.innerHTML = `
        <div class="fl-modal-footer-info">FL Studio Engine • Strict Quantization</div>
        <div class="fl-modal-footer-actions">
          <button type="button" class="fl-btn-modal-cancel">✕ Cancel</button>
          <button type="button" class="fl-btn-modal-apply">✔ Apply & Insert to Chat</button>
        </div>
      `;

      const cancelBtn = modalFooter.querySelector('.fl-btn-modal-cancel');
      cancelBtn.onclick = () => this.toggle(false);

      const applyBtn = modalFooter.querySelector('.fl-btn-modal-apply');
      applyBtn.onclick = () => {
        const notes = (this.pianoRoll.musicData && this.pianoRoll.musicData.notes) || [];
        if (notes.length === 0) {
          this.toggle(false);
          return;
        }
        const abc = notesToABC(notes, {
          tempo: this.pianoRoll.musicData?.tempo || 120,
          key: this.pianoRoll.musicData?.key || 'C',
          meter: this.pianoRoll.musicData?.meter || '4/4'
        });
        const markdown = '```abc\n' + abc.trim() + '\n```';
        insertTextIntoNotebookLM(markdown);
        this.toggle(false);
      };

      modalWindow.appendChild(modalHeader);
      modalWindow.appendChild(toolbar);
      modalWindow.appendChild(canvasWrap);
      modalWindow.appendChild(modalFooter);
      this.drawer.appendChild(modalWindow);

      // Close on backdrop click
      this.drawer.onclick = (e) => {
        if (e.target === this.drawer) {
          this.toggle(false);
        }
      };

      // Close on Escape key
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) {
          this.toggle(false);
        }
      });

      this.synth = new PianoRollSynth({
        volume: globalVolume,
        expression: globalExpression
      });

      this.pianoRoll = new FLPianoRoll(canvasWrap, {
        height: 400,
        fitContainer: true,
        editable: true,
        synth: this.synth,
        onNotesChange: (notes) => {
          if (this.lcdNotes) {
            const count = (notes && notes.length) || 0;
            this.lcdNotes.textContent = `${count} note${count === 1 ? '' : 's'}`;
          }
        }
      });

      this.synth.onProgress = (currentBeat, activePitches) => {
        this.pianoRoll.updatePlayback(currentBeat, activePitches);
      };

      this.synth.onEnded = () => {
        playBtn.innerHTML = '▶ Play';
        playBtn.classList.remove('is-playing');
        this.pianoRoll.seekTo(this.synth.playOriginBeat !== undefined ? this.synth.playOriginBeat : 0);
      };

      this.pianoRoll.togglePlay = () => {
        playBtn.click();
      };

      playBtn.onclick = async () => {
        await this.synth.ensureResumed();
        if (!this.synth.isPlaying) {
          if (typeof registeredRolls !== 'undefined') {
            for (const roll of registeredRolls) {
              if (roll !== this.pianoRoll && roll.synth && roll.synth.isPlaying) {
                roll.synth.stop(true);
              }
            }
          }
          const notes = (this.pianoRoll.musicData && this.pianoRoll.musicData.notes) || [];
          if (notes.length === 0) return;
          const tempo = this.pianoRoll.musicData.tempo || 120;
          const totalBeats = this.pianoRoll.musicData.totalBeats || 16;
          let startBeat = (this.synth.playOriginBeat !== undefined) ? this.synth.playOriginBeat : this.pianoRoll.currentBeat;
          if (startBeat >= totalBeats - 0.05) startBeat = 0;

          this.synth.play(notes, tempo, true, totalBeats, startBeat);
          playBtn.innerHTML = '⏸ Pause';
          playBtn.classList.add('is-playing');
        } else {
          this.synth.pause();
          playBtn.innerHTML = '▶ Play';
          playBtn.classList.remove('is-playing');
        }
      };

      stopBtn.onclick = () => {
        this.synth.stop(true);
        this.pianoRoll.seekTo(0);
      };

      clearBtn.onclick = () => {
        this.pianoRoll.clearNotes();
        if (this.lcdNotes) this.lcdNotes.textContent = '0 notes';
      };

      exprPill.querySelector('.fl-expr-select').onchange = (e) => {
        const val = e.target.value;
        globalExpression = val;
        try { localStorage.setItem('nlm_fl_expression', val); } catch (err) {}
        this.synth.setExpression(val);
      };

      volPill.querySelector('.fl-vol-slider').oninput = (e) => {
        const val = parseFloat(e.target.value);
        globalVolume = val;
        try { localStorage.setItem('nlm_fl_volume', val.toString()); } catch (err) {}
        this.synth.setVolume(val);
      };
    }

    if (!document.body.contains(this.drawer)) {
      document.body.appendChild(this.drawer);
    }
  }

  toggle(forceState) {
    this.isOpen = (forceState !== undefined) ? forceState : !this.isOpen;
    if (this.drawer) {
      this.drawer.style.display = this.isOpen ? 'flex' : 'none';
    }
    if (this.toggleBtn) {
      this.toggleBtn.classList.toggle('is-active', this.isOpen);
    }
    if (this.isOpen && this.pianoRoll) {
      activeRollForKeyboard = this.pianoRoll;
      requestAnimationFrame(() => {
        this.pianoRoll.updateCanvasDimensions();
        this.pianoRoll.clampScroll();
        this.pianoRoll.render();
      });
    } else if (!this.isOpen && this.synth && this.synth.isPlaying) {
      this.synth.stop(true);
    }
  }

  /**
   * Loads score notes directly into the composer, replacing any existing notes
   */
  loadScore(musicData) {
    if (!this.drawer || !this.pianoRoll) {
      const container = findNotebookLMInputContainer() || document.body;
      this.init(container);
    }

    if (!musicData) return;

    // Deep clone notes so editing in composer doesn't mutate widget score
    const clonedNotes = (musicData.notes || []).map(n => ({
      pitch: n.pitch,
      name: n.name || '',
      startBeat: n.startBeat,
      duration: n.duration,
      velocity: (n.velocity !== undefined) ? n.velocity : 80
    }));

    const clonedData = {
      title: musicData.title || 'Composition',
      key: musicData.key || 'C',
      meter: musicData.meter || '4/4',
      tempo: musicData.tempo || 120,
      beatsPerMeasure: musicData.beatsPerMeasure || 4,
      totalBeats: Math.max(16, musicData.totalBeats || 16),
      minPitch: (typeof musicData.minPitch === 'number') ? musicData.minPitch : 21,
      maxPitch: (typeof musicData.maxPitch === 'number') ? musicData.maxPitch : 108,
      notes: clonedNotes
    };

    if (this.synth && this.synth.isPlaying) {
      this.synth.stop(true);
    }

    if (this.pianoRoll) {
      this.pianoRoll.setData(clonedData);
      if (this.lcdNotes) {
        const count = clonedNotes.length;
        this.lcdNotes.textContent = `${count} note${count === 1 ? '' : 's'}`;
      }
      if (this.lcdKey && clonedData.key) {
        this.lcdKey.textContent = clonedData.key;
      }
      if (this.lcdMeter && clonedData.meter) {
        this.lcdMeter.textContent = clonedData.meter;
      }
      if (this.lcdBpm && clonedData.tempo) {
        this.lcdBpm.innerHTML = `${clonedData.tempo}<small>BPM</small>`;
      }
    }

    this.toggle(true);
  }
}

/**
 * Loop-immune, single-timer debounced scanner for NotebookLM DOM
 */
class NotebookLMWatcher {
  constructor() {
    this.scanTimer = null;
    this.observer = null;
    this.maxImmediateWidgets = 5;
    this.isScanning = false;
  }

  initComposer() {
    try {
      const container = findNotebookLMInputContainer();
      if (container) {
        if (!activeComposer) {
          activeComposer = new NotebookLMComposer();
        }
        activeComposer.init(container);
      }
    } catch (e) {
      console.warn('Composer init error:', e);
    }
  }

  start() {
    // Initial scan after page load
    this.scheduleScan(400);
    this.initComposer();

    // Safety polling timer: catches any streamed responses even if DOM mutations were skipped
    if (!this.safetyInterval) {
      this.safetyInterval = setInterval(() => {
        this.scan();
      }, 1500);
    }

    // MutationObserver watches for any newly added nodes or text changes in document
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const m of mutations) {
        // If mutation occurred inside our own widgets, IGNORE
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
          if (m.target.closest?.('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer')) {
            continue;
          }
        }

        if (m.type === 'characterData') {
          shouldScan = true;
          break;
        }

        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('fl-widget-container') ||
                node.classList?.contains('fl-lazy-placeholder') ||
                node.classList?.contains('fl-composer-modal-overlay') ||
                node.classList?.contains('fl-composer-drawer') ||
                node.closest?.('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer')) {
              continue;
            }

            shouldScan = true;
            break;
          }
        }

        if (shouldScan) break;
      }

      if (shouldScan) {
        this.scheduleScan(250);
      }
    });

    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  scheduleScan(delay = 250) {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, delay);
  }

  scan() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      this.initComposer();

      const candidateSelectors = [
        'chat-message',
        '.chat-message',
        '.to-user-container',
        'model-response',
        '.model-response',
        'conversation-turn',
        '.conversation-turn',
        '.chat-turn',
        '.message-container'
      ];
      let messageNodes = Array.from(document.querySelectorAll(candidateSelectors.join(', ')));

      // Also discover any other turn or message containers containing unprocessed ABC music
      const allDivs = document.querySelectorAll('div, section, article');
      for (const el of allDivs) {
        if (el.closest('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer, form')) continue;
        if (el.dataset?.flProcessed === 'true') continue;
        if (el.querySelector('.fl-widget-container, .fl-lazy-placeholder')) continue;
        const txt = el.textContent || '';
        if (txt.length > 20 && txt.includes('|') && /[A-Ga-g]/.test(txt) && hasMusicContent(txt)) {
          if (!messageNodes.some(m => m === el || m.contains(el))) {
            if (!el.parentElement || !hasMusicContent(el.parentElement.textContent || '')) {
              messageNodes.push(el);
            }
          }
        }
      }

      if (messageNodes.length === 0) return;

      const candidateMessages = [];
      for (const msg of messageNodes) {
        if (msg.dataset.flProcessed === 'true') continue;
        const isMsgStreaming = isNotebookLMStreaming() || hasUnclosedFence(msg.textContent || '');
        if (!isMsgStreaming && msg.querySelector('.fl-widget-container, .fl-lazy-placeholder')) {
          msg.dataset.flProcessed = 'true';
          continue;
        }

        const text = msg.textContent || '';
        if (text.length > 20 && text.includes('|') && /[A-Ga-g]/.test(text) && hasMusicContent(text)) {
          candidateMessages.push(msg);
        }
      }

      if (candidateMessages.length === 0) return;

      // Only the last 5 messages render immediately; earlier ones are lazy placeholders
      const totalCandidates = candidateMessages.length;
      const immediateCutoff = Math.max(0, totalCandidates - this.maxImmediateWidgets);

      candidateMessages.forEach((msg, idx) => {
        const immediate = idx >= immediateCutoff;
        processNotebookLMMessage(msg, immediate);
      });
    } catch (err) {
      console.warn('NotebookLM scan error:', err);
    } finally {
      this.isScanning = false;
    }
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractAllABC,
    extractABC,
    isNotebookLMStreaming,
    hasUnclosedFence,
    notesToABC,
    partitionNotesIntoVoices,
    formatSingleVoiceABC,
    midiToABCPitch,
    formatABCDuration,
    NotebookLMComposer,
    createPianoRollWidget,
    createLazyPlaceholder,
    processNotebookLMMessage,
    NotebookLMWatcher
  };
}

