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

    if (isHeader || (inBlock && isMusicLine)) {
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
    let abc = currentBlock.join('\n').trim();
    if (!abc.startsWith('X:')) abc = 'X:1\n' + abc;
    results.push({ abcString: abc });
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

  leftGroup.appendChild(playBtn);
  leftGroup.appendChild(stopBtn);
  leftGroup.appendChild(lcd);

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

  // Shortcuts Info Button (Icon with rich multi-line tooltip)
  const shortcutsBtn = document.createElement('button');
  shortcutsBtn.className = 'fl-btn fl-btn-icon';
  shortcutsBtn.innerHTML = '⌨';
  shortcutsBtn.title = 'Keyboard Shortcuts:\n• Space: Play / Pause\n• Ctrl + Wheel: Horizontal Zoom (Time)\n• Alt + Wheel: Vertical Zoom (Keys)\n• Shift + Wheel: Horizontal Scroll\n• Click/Drag: Pan & Seek';

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

  // Wire up audio playback callbacks
  synth.onProgress = (currentBeat, activePitches) => {
    pianoRoll.updatePlayback(currentBeat, activePitches);
  };

  synth.onEnded = () => {
    playBtn.innerHTML = '▶ Play';
    playBtn.classList.remove('is-playing');
    pianoRoll.seekTo(0);
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

      let startBeat = pianoRoll.currentBeat;
      if (startBeat >= (musicData.totalBeats - 0.05)) {
        startBeat = 0;
      }
      synth.play(musicData.notes, musicData.tempo, true, musicData.totalBeats, startBeat);
      playBtn.innerHTML = '⏸ Pause';
      playBtn.classList.add('is-playing');
    } else if (synth.isPaused) {
      synth.resume();
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
  return widget;
}

/**
 * Inspects a NotebookLM chat message and replaces ABC blocks in-place with Piano Roll widgets
 * @param {HTMLElement} messageNode
 * @param {boolean} immediate - If true, mounts full widget immediately; if false, mounts lazy placeholder
 */
function processNotebookLMMessage(messageNode, immediate = true) {
  if (!messageNode) return;

  // Circuit breaker: never process an already handled message
  if (messageNode.dataset.flProcessed === 'true') return;
  if (messageNode.querySelector('.fl-widget-container, .fl-lazy-placeholder')) {
    messageNode.dataset.flProcessed = 'true';
    return;
  }

  // 1. First: inspect all code blocks (<pre> elements)
  const preElements = Array.from(messageNode.querySelectorAll('pre'));
  for (const pre of preElements) {
    if (pre.dataset.flAttached === 'true') continue;
    if (pre.closest('.fl-widget-container, .fl-lazy-placeholder')) continue;

    const preText = pre.textContent || '';
    if (hasMusicContent(preText)) {
      const abcMatch = extractABC(preText);
      if (abcMatch) {
        const container = pre.closest('.code-block, .snippet-container, pre') || pre;
        const elem = immediate
          ? createPianoRollWidget(abcMatch.abcString, container)
          : createLazyPlaceholder(abcMatch.abcString, container);

        if (elem) {
          pre.dataset.flAttached = 'true';
          container.dataset.flAttached = 'true';
          container.style.display = 'none'; // Hide the ABC code block cleanly
          // Insert the Piano Roll widget in-place directly where the ABC code was!
          container.parentElement.insertBefore(elem, container);
        }
      }
    }
  }

  // 2. Second: inspect plain text paragraphs (ONLY those that do NOT contain or belong to code blocks)
  const textContainer = messageNode.querySelector('.message-text-content') || messageNode;
  const paragraphs = Array.from(textContainer.querySelectorAll('.paragraph.normal, paragraph-element-view, p'));

  for (const p of paragraphs) {
    if (p.dataset.flAttached === 'true') continue;
    if (p.closest('.fl-widget-container, .fl-lazy-placeholder, pre')) continue;
    if (p.querySelector('.fl-widget-container, .fl-lazy-placeholder, pre')) continue;

    const pText = p.textContent || '';
    if (hasMusicContent(pText)) {
      const allFound = extractAllABC(pText);
      for (const item of allFound) {
        const elem = immediate
          ? createPianoRollWidget(item.abcString, p)
          : createLazyPlaceholder(item.abcString, p);

        if (elem) {
          p.dataset.flAttached = 'true';
          p.style.display = 'none'; // Hide the raw ABC paragraph cleanly
          // Insert the Piano Roll widget in-place directly where the ABC text was!
          p.parentElement.insertBefore(elem, p);
        }
      }
    }
  }

  // Mark this message node as completely processed
  messageNode.dataset.flProcessed = 'true';
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

  start() {
    // Initial scan after page load
    this.scheduleScan(600);

    // MutationObserver watches ONLY for newly added chat message elements
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const m of mutations) {
        // If mutation occurred inside our own widgets, IGNORE
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
          if (m.target.closest?.('.fl-widget-container, .fl-lazy-placeholder')) {
            continue;
          }
        }

        // Check if any newly added node is a chat container
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Ignore our own added elements completely
            if (node.classList?.contains('fl-widget-container') ||
                node.classList?.contains('fl-lazy-placeholder') ||
                node.closest?.('.fl-widget-container, .fl-lazy-placeholder')) {
              continue;
            }

            if (node.matches?.('chat-message, .to-user-container, model-response') ||
                node.querySelector?.('chat-message, .to-user-container, model-response')) {
              shouldScan = true;
              break;
            }
          }
        }

        if (shouldScan) break;
      }

      if (shouldScan) {
        this.scheduleScan(400);
      }
    });

    // Observe document.body with childList ONLY (NEVER characterData!)
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  scheduleScan(delay = 400) {
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
      const messageNodes = Array.from(document.querySelectorAll('chat-message, .to-user-container, model-response'));
      if (messageNodes.length === 0) return;

      const candidateMessages = [];
      for (const msg of messageNodes) {
        if (msg.dataset.flProcessed === 'true') continue;
        if (msg.querySelector('.fl-widget-container, .fl-lazy-placeholder')) {
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
    createPianoRollWidget,
    createLazyPlaceholder,
    processNotebookLMMessage,
    NotebookLMWatcher
  };
}
