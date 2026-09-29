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

  // 2. Second: inspect all text blocks across the message
  const fullText = messageNode.textContent || '';
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

      const elem = immediate
        ? createPianoRollWidget(item.abcString, hostContainer)
        : createLazyPlaceholder(item.abcString, hostContainer);

      if (elem) {
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

  // Mark this message node as completely processed only if we successfully attached or confirmed no music
  if (messageNode.querySelector('.fl-widget-container, .fl-lazy-placeholder') || !hasMusicContent(messageNode.textContent || '')) {
    messageNode.dataset.flProcessed = 'true';
  }
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

function quantize(val, step = 0.25) {
  return Math.round(Math.round(val / step) * step * 10000) / 10000;
}

function formatABCRest(restInBeats) {
  let remUnits = Math.round(quantize(restInBeats, 0.25) * 4) / 2; // In 1/8 units
  let out = '';

  while (remUnits >= 0.25) {
    if (remUnits >= 8) {
      out += 'z8 ';
      remUnits -= 8;
    } else if (remUnits >= 6) {
      out += 'z6 ';
      remUnits -= 6;
    } else if (remUnits >= 4) {
      out += 'z4 ';
      remUnits -= 4;
    } else if (remUnits >= 3) {
      out += 'z3 ';
      remUnits -= 3;
    } else if (remUnits >= 2) {
      out += 'z2 ';
      remUnits -= 2;
    } else if (remUnits >= 1) {
      out += 'z ';
      remUnits -= 1;
    } else if (remUnits >= 0.5) {
      out += 'z/2 ';
      remUnits -= 0.5;
    } else {
      break;
    }
  }
  return out;
}

function formatABCDuration(durationInBeats) {
  const units = Math.round(quantize(durationInBeats, 0.25) * 4) / 2; // L:1/8 -> 0.5 beat = 1 unit
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

  // Strictly quantize all note timings to clean musical fractions (1/16th note steps)
  const cleanNotes = notes.map(n => ({
    pitch: n.pitch,
    startBeat: Math.max(0, quantize(n.startBeat, 0.25)),
    duration: Math.max(0.25, quantize(n.duration, 0.25))
  })).sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);

  // Group notes into simultaneous time steps
  const groups = [];
  let currentGroup = null;

  for (const n of cleanNotes) {
    if (!currentGroup || Math.abs(currentGroup.startBeat - n.startBeat) > 0.05) {
      currentGroup = {
        startBeat: n.startBeat,
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
      const restBeats = Math.min(group.startBeat - currentBeat, nextBarBeat - currentBeat);
      const cleanRestBeats = quantize(restBeats, 0.25);

      if (cleanRestBeats > 0) {
        body += formatABCRest(cleanRestBeats);
      }
      currentBeat = quantize(currentBeat + cleanRestBeats, 0.25);

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

    const groupDur = quantize(Math.max(...group.notes.map(n => n.duration)), 0.25);
    currentBeat = quantize(currentBeat + groupDur, 0.25);

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

      rightGroup.appendChild(snapPill);
      rightGroup.appendChild(exprPill);
      rightGroup.appendChild(volPill);

      toolbar.appendChild(leftGroup);
      toolbar.appendChild(rightGroup);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'fl-canvas-wrap';
      canvasWrap.style.flex = '1';
      canvasWrap.style.height = '100%';
      canvasWrap.style.minHeight = '360px';
      canvasWrap.style.position = 'relative';

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
          key: 'C',
          meter: '4/4'
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

    // MutationObserver watches for any newly added nodes in document
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const m of mutations) {
        // If mutation occurred inside our own widgets, IGNORE
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
          if (m.target.closest?.('.fl-widget-container, .fl-lazy-placeholder, .fl-composer-modal-overlay, .fl-composer-drawer')) {
            continue;
          }
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
        this.scheduleScan(350);
      }
    });

    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  scheduleScan(delay = 350) {
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

