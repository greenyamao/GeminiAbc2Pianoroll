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
 * Converts note array into standard ABC notation
 */
function midiToABCPitch(midiPitch) {
  const PITCH_MAP = [
    { name: 'C', acc: '' },
    { name: 'C', acc: '^' },
    { name: 'D', acc: '' },
    { name: 'D', acc: '^' },
    { name: 'E', acc: '' },
    { name: 'F', acc: '' },
    { name: 'F', acc: '^' },
    { name: 'G', acc: '' },
    { name: 'G', acc: '^' },
    { name: 'A', acc: '' },
    { name: 'A', acc: '^' },
    { name: 'B', acc: '' }
  ];

  const octave = Math.floor(midiPitch / 12) - 1;
  const semitone = ((midiPitch % 12) + 12) % 12;
  const p = PITCH_MAP[semitone];

  let noteStr = '';
  if (octave >= 5) {
    noteStr = p.acc + p.name.toLowerCase();
    const ticks = octave - 5;
    if (ticks > 0) noteStr += "'".repeat(ticks);
  } else if (octave === 4) {
    noteStr = p.acc + p.name;
  } else {
    noteStr = p.acc + p.name;
    const commas = 4 - octave;
    noteStr += ",".repeat(commas);
  }
  return noteStr;
}

function formatABCDuration(durationInBeats) {
  const units = Math.round(durationInBeats * 4) / 2; // L:1/8 -> 0.5 beat = 1 unit
  if (units === 1) return '';
  if (units === 0.5) return '/2';
  if (units === 0.25) return '/4';
  if (Number.isInteger(units) && units > 0) return units.toString();
  return Math.max(1, Math.round(units)).toString();
}

function notesToABC(notes, options = {}) {
  const key = options.key || 'C';
  const meter = options.meter || '4/4';
  const tempo = options.tempo || 120;
  const beatsPerMeasure = 4;

  const header = `X:1\nT:Melody\nM:${meter}\nL:1/8\nQ:1/4=${tempo}\nK:${key}\n`;
  if (!notes || notes.length === 0) {
    return header + '| z8 | z8 |\n';
  }

  // Sort notes by startBeat, then pitch
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);

  // Group notes into simultaneous time steps
  const groups = [];
  let currentGroup = null;

  for (const n of sorted) {
    const roundedBeat = Math.round(n.startBeat * 4) / 4;
    if (!currentGroup || Math.abs(currentGroup.startBeat - roundedBeat) > 0.05) {
      currentGroup = {
        startBeat: roundedBeat,
        notes: [n]
      };
      groups.push(currentGroup);
    } else {
      currentGroup.notes.push(n);
    }
  }

  let body = '| ';
  let currentBeat = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    // Check for rest before this group
    while (group.startBeat > currentBeat + 0.05) {
      const nextBarBeat = (Math.floor(currentBeat / beatsPerMeasure) + 1) * beatsPerMeasure;
      const restDuration = Math.min(group.startBeat - currentBeat, nextBarBeat - currentBeat);

      const restUnits = Math.round(restDuration * 2);
      if (restUnits > 0) {
        body += (restUnits === 1 ? 'z ' : `z${restUnits} `);
      }
      currentBeat += restDuration;

      if (Math.abs(currentBeat - nextBarBeat) < 0.05) {
        body += '| ';
      }
    }

    // Format single note or chord
    if (group.notes.length === 1) {
      const n = group.notes[0];
      body += midiToABCPitch(n.pitch) + formatABCDuration(n.duration) + ' ';
    } else {
      const maxDur = Math.max(...group.notes.map(n => n.duration));
      const durStr = formatABCDuration(maxDur);
      const notesStr = group.notes.map(n => midiToABCPitch(n.pitch)).join(' ');
      body += `[${notesStr}]${durStr} `;
    }

    const groupDur = Math.max(...group.notes.map(n => n.duration));
    currentBeat += groupDur;

    // Check measure boundary
    const measureRem = currentBeat % beatsPerMeasure;
    if (Math.abs(measureRem) < 0.05 && i < groups.length - 1) {
      body += '| ';
    }
  }

  if (!body.trim().endsWith('|')) {
    body += '|';
  }

  return header + body + '\n';
}

/**
 * Finds NotebookLM input prompt container
 */
function findNotebookLMInputContainer() {
  const selectors = [
    'query-box',
    '.query-box',
    '.query-bar',
    '.chat-input-area',
    '.chat-input-container',
    '.input-box-container',
    'form:has(textarea)',
    'div:has(> textarea)',
    'form:has([contenteditable])',
    'div:has(> [contenteditable="true"])'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (e) {}
  }

  const input = document.querySelector('textarea, [contenteditable="true"]');
  if (input) {
    return input.closest('form, .input-area, .chat-bar, .query-container') || input.parentElement;
  }

  return null;
}

/**
 * Bulletproof prompt text inserter supporting textarea and contenteditable
 */
function insertTextIntoNotebookLM(textToInsert) {
  const input = document.querySelector('query-box textarea, .query-box textarea, textarea, [contenteditable="true"]');
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

    const valueSetter = Object.getOwnPropertyDescriptor(input, 'value')?.set;
    const prototype = Object.getPrototypeOf(input);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(input, newText);
    } else if (valueSetter) {
      valueSetter.call(input, newText);
    } else {
      input.value = newText;
    }

    const newPos = (before + prefix + textToInsert + '\n').length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
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

    const btnRow = inputContainer.querySelector('.buttons, .actions, .controls, .bottom-row, .leading-actions') || inputContainer;
    if (!btnRow.contains(this.toggleBtn)) {
      btnRow.appendChild(this.toggleBtn);
    }

    // 2. Create Drawer if not created yet
    if (!this.drawer) {
      this.drawer = document.createElement('div');
      this.drawer.className = 'fl-composer-drawer';
      this.drawer.style.display = 'none';

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
      this.lcdNotes = lcd.querySelector('.fl-lcd-notes');

      leftGroup.appendChild(playBtn);
      leftGroup.appendChild(stopBtn);
      leftGroup.appendChild(clearBtn);
      leftGroup.appendChild(lcd);

      // Right section: Snap + Expression + Volume + Insert + Close
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

      const insertBtn = document.createElement('button');
      insertBtn.className = 'fl-btn fl-btn-insert';
      insertBtn.type = 'button';
      insertBtn.innerHTML = '➤ Insert to Prompt';
      insertBtn.title = 'Convert notes to ABC code and insert into chat prompt';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'fl-btn fl-btn-icon';
      closeBtn.type = 'button';
      closeBtn.innerHTML = '✕';
      closeBtn.title = 'Close Piano Roll (notes will be preserved)';
      closeBtn.onclick = () => this.toggle(false);

      rightGroup.appendChild(snapPill);
      rightGroup.appendChild(exprPill);
      rightGroup.appendChild(volPill);
      rightGroup.appendChild(insertBtn);
      rightGroup.appendChild(closeBtn);

      toolbar.appendChild(leftGroup);
      toolbar.appendChild(rightGroup);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'fl-canvas-wrap';

      this.drawer.appendChild(toolbar);
      this.drawer.appendChild(canvasWrap);

      this.synth = new PianoRollSynth({
        volume: globalVolume,
        expression: globalExpression
      });

      this.pianoRoll = new FLPianoRoll(canvasWrap, {
        height: 260,
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
        this.pianoRoll.seekTo(0);
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
          let startBeat = this.pianoRoll.currentBeat;
          if (startBeat >= totalBeats - 0.05) startBeat = 0;

          this.synth.play(notes, tempo, true, totalBeats, startBeat);
          playBtn.innerHTML = '⏸ Pause';
          playBtn.classList.add('is-playing');
        } else if (this.synth.isPaused) {
          this.synth.resume();
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

      insertBtn.onclick = () => {
        const notes = (this.pianoRoll.musicData && this.pianoRoll.musicData.notes) || [];
        const abc = notesToABC(notes, {
          tempo: this.pianoRoll.musicData?.tempo || 120,
          key: 'C',
          meter: '4/4'
        });
        const markdown = '```abc\n' + abc.trim() + '\n```';
        insertTextIntoNotebookLM(markdown);

        insertBtn.innerHTML = '✔ Inserted!';
        insertBtn.style.background = '#285e3a';
        setTimeout(() => {
          insertBtn.innerHTML = '➤ Insert to Prompt';
          insertBtn.style.background = '';
        }, 1500);
      };
    }

    if (this.drawer.parentElement !== inputContainer.parentElement) {
      inputContainer.parentElement.insertBefore(this.drawer, inputContainer);
    }
  }

  toggle(forceState) {
    this.isOpen = (forceState !== undefined) ? forceState : !this.isOpen;
    if (this.drawer) {
      this.drawer.style.display = this.isOpen ? 'block' : 'none';
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
    this.scheduleScan(600);
    this.initComposer();

    // MutationObserver watches for new chat messages and query box
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const m of mutations) {
        // If mutation occurred inside our own widgets, IGNORE
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
          if (m.target.closest?.('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-drawer')) {
            continue;
          }
        }

        // Check if any newly added node is a chat container or query box
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('fl-widget-container') ||
                node.classList?.contains('fl-lazy-placeholder') ||
                node.classList?.contains('fl-composer-drawer') ||
                node.closest?.('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-drawer')) {
              continue;
            }

            if (node.matches?.('chat-message, .to-user-container, model-response, query-box, .query-box, textarea') ||
                node.querySelector?.('chat-message, .to-user-container, model-response, query-box, .query-box, textarea')) {
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
      this.initComposer();

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
    notesToABC,
    midiToABCPitch,
    formatABCDuration,
    NotebookLMComposer,
    createPianoRollWidget,
    createLazyPlaceholder,
    processNotebookLMMessage,
    NotebookLMWatcher
  };
}

