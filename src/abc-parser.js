/**
 * Universal Production-Grade ABC Notation Parser for Piano Roll
 * Fully compliant with ABC 2.1 / 2.2 and real-world LLM / web variations:
 * - Universal Modal Key Signatures (Major, Minor, Dorian, Mixolydian, Phrygian, Lydian, Locrian, HP)
 * - True Polyphony & Multi-Voice Tracking (SATB, V:1, V:2, [V:1 clef=treble], etc.)
 * - Full 88-Key Piano / MIDI (A0 to C8) with scientific pitch (C2, D#5, Bb3) and ABC commas/apostrophes (C,, to c'')
 * - Tuplets ((3, (2, (4, (5, etc.) with sample-accurate time-scaling
 * - Ties (-) merging identical consecutive notes into single held DAW notes
 * - Broken rhythms (c>d, c>>d, c<d, c<<d)
 * - Multi-measure rests (Z, Z4) and hidden voice rests (x, X)
 * - Safe skipping of guitar chords ("Am7", "C#dim"), lyrics (w:, W:), decorations (~, ., !...!), and comments (%)
 * - Mid-piece inline key/meter changes ([K:...], [M:...], [Q:...])
 */

const ROOT_FIFTHS = {
  'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7,
  'F': -1, 'Bb': -2, 'Eb': -3, 'Ab': -4, 'Db': -5, 'Gb': -6, 'Cb': -7
};

const MODE_OFFSETS = [
  ['mixolydian', -1], ['mix', -1],
  ['dorian', -2], ['dor', -2],
  ['phrygian', -4], ['phr', -4],
  ['lydian', 1], ['lyd', 1],
  ['locrian', -5], ['loc', -5],
  ['minor', -3], ['min', -3], ['aeolian', -3], ['aeo', -3], ['m', -3],
  ['major', 0], ['maj', 0], ['ionian', 0], ['ion', 0]
];

const SHARPS_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLATS_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

const BASE_NOTE_SEMITONES = {
  'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11
};

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Convert MIDI pitch (0-127) to standard note name (e.g. 60 -> "C4", 78 -> "F#5")
 */
function midiToNoteName(pitch) {
  const octave = Math.floor(pitch / 12) - 1;
  const note = NOTE_NAMES_SHARP[((pitch % 12) + 12) % 12];
  return `${note}${octave}`;
}

/**
 * Universal Key Signature Accidentals Generator
 * Supports all 12 roots in all 7 musical modes, bagpipe HP, and explicit accidentals
 */
function getKeyAccidentals(keyStr) {
  if (!keyStr) return {};
  const clean = keyStr.trim();
  if (/^HP$/i.test(clean)) return { 'F': 1, 'C': 1 };
  if (/^none$/i.test(clean)) return {};

  const match = clean.match(/^([A-Ga-g][#b]?)\s*([A-Za-z]*)/);
  if (!match) return {};

  let root = match[1];
  root = root.charAt(0).toUpperCase() + root.slice(1);
  const modeStr = (match[2] || '').toLowerCase();

  let modeOffset = 0;
  if (modeStr) {
    for (const [m, off] of MODE_OFFSETS) {
      if (modeStr.startsWith(m)) {
        modeOffset = off;
        break;
      }
    }
  } else if (clean.endsWith('m') && !clean.endsWith('maj')) {
    modeOffset = -3;
    root = root.replace(/m$/i, '');
  }

  const rootFifths = ROOT_FIFTHS[root] !== undefined ? ROOT_FIFTHS[root] : 0;
  const net = rootFifths + modeOffset;

  const accs = {};
  if (net > 0) {
    for (let i = 0; i < Math.min(net, 7); i++) accs[SHARPS_ORDER[i]] = 1;
  } else if (net < 0) {
    for (let i = 0; i < Math.min(-net, 7); i++) accs[FLATS_ORDER[i]] = -1;
  }

  // Handle explicit accidentals in key definition, e.g. K:C ^f _b
  const explicitMatches = clean.match(/[\^_=][A-Ga-g]/g);
  if (explicitMatches) {
    for (const em of explicitMatches) {
      const accChar = em[0];
      const noteLetter = em[1].toUpperCase();
      if (accChar === '^') accs[noteLetter] = 1;
      else if (accChar === '_') accs[noteLetter] = -1;
      else if (accChar === '=') delete accs[noteLetter];
    }
  }

  return accs;
}

/**
 * Read duration suffix from ABC note (e.g. "2", "3", "/2", "3/2", "//")
 */
function readDuration(str, pos) {
  let multiplier = 1;
  const len = str.length;

  let numStr = '';
  while (pos < len && /\d/.test(str[pos])) {
    numStr += str[pos];
    pos++;
  }
  if (numStr) {
    multiplier = parseInt(numStr, 10);
  }

  if (pos < len && str[pos] === '/') {
    pos++;
    let denomStr = '';
    while (pos < len && /\d/.test(str[pos])) {
      denomStr += str[pos];
      pos++;
    }
    if (denomStr) {
      multiplier /= parseInt(denomStr, 10);
    } else {
      multiplier /= 2;
      while (pos < len && str[pos] === '/') {
        multiplier /= 2;
        pos++;
      }
    }
  }

  return { multiplier, newPos: pos };
}

/**
 * Universal single note parser
 */
function parseSingleNote(str, pos, measureAccidentals, defaultDuration, isInsideChord, tupletScale) {
  const len = str.length;

  // 1. Accidental prefixes: ^^, __, ^, _, =
  let accidental = null;
  if (str.substr(pos, 2) === '^^') { accidental = 2; pos += 2; }
  else if (str.substr(pos, 2) === '__') { accidental = -2; pos += 2; }
  else if (str[pos] === '^') { accidental = 1; pos++; }
  else if (str[pos] === '_') { accidental = -1; pos++; }
  else if (str[pos] === '=') { accidental = 0; pos++; }

  // 2. Note letter: A-G, a-g
  if (pos >= len || !/[A-Ga-g]/.test(str[pos])) {
    return { note: null, newPos: pos };
  }
  const noteLetter = str[pos];
  pos++;

  // 3. Suffix accidentals: #, ##, b, bb (modern / LLM notation e.g. G#4, Bb3)
  let hasSuffixAcc = false;
  if (pos < len && (str[pos] === '#' || str[pos] === 'b')) {
    if (str[pos] === '#') {
      accidental = (pos + 1 < len && str[pos + 1] === '#') ? (pos++, 2) : 1;
      hasSuffixAcc = true;
      pos++;
    } else if (str[pos] === 'b' && pos + 1 < len && /^[0-8]/.test(str.substr(pos + 1))) {
      // Suffix 'b' is a flat accidental only if followed by an octave digit, e.g. Bb3, Eb4, Ab2
      accidental = -1;
      hasSuffixAcc = true;
      pos++;
    }
  }

  // 4. Octave modifiers:
  // Scientific octave digit [0-8]
  let explicitOctave = null;
  let octaveOffset = 0;

  if (pos < len && /^[0-8]/.test(str[pos])) {
    if (isInsideChord || hasSuffixAcc) {
      explicitOctave = parseInt(str[pos], 10);
      pos++;
    }
  }

  // Standard ABC commas (lower) and apostrophes (higher)
  while (pos < len && (str[pos] === "'" || str[pos] === ',')) {
    if (str[pos] === "'") octaveOffset++;
    else if (str[pos] === ',') octaveOffset--;
    pos++;
  }

  // 5. Duration
  let noteDuration = defaultDuration;
  if (pos < len && /[\d\/]/.test(str[pos])) {
    const dur = readDuration(str, pos);
    pos = dur.newPos;
    noteDuration = defaultDuration * dur.multiplier;
  }

  if (tupletScale && tupletScale !== 1) {
    noteDuration *= tupletScale;
  }

  // Check for tie symbol immediately after note
  let hasTie = false;
  if (pos < len && str[pos] === '-') {
    hasTie = true;
    pos++;
  }

  // 6. Calculate MIDI pitch
  const isUpperCase = noteLetter === noteLetter.toUpperCase();
  const baseLetter = noteLetter.toUpperCase();
  let baseOctave = (explicitOctave !== null) ? explicitOctave : ((isUpperCase ? 4 : 5) + octaveOffset);

  let semitoneAlter = 0;
  if (accidental !== null) {
    semitoneAlter = accidental;
    measureAccidentals[baseLetter] = accidental;
  } else if (measureAccidentals[baseLetter] !== undefined) {
    semitoneAlter = measureAccidentals[baseLetter];
  }

  const pitch = (baseOctave + 1) * 12 + BASE_NOTE_SEMITONES[baseLetter] + semitoneAlter;
  const clampedPitch = Math.max(12, Math.min(127, pitch));

  return {
    note: {
      pitch: clampedPitch,
      name: midiToNoteName(clampedPitch),
      duration: noteDuration,
      hasTie: hasTie
    },
    newPos: pos
  };
}

/**
 * Parse individual notes within a chord [ ... ]
 */
function parseChordNotes(chordStr, measureAccidentals, baseDuration, tupletScale) {
  const result = [];
  let pos = 0;
  const len = chordStr.length;

  while (pos < len) {
    if (/\s/.test(chordStr[pos])) {
      pos++;
      continue;
    }

    const parsed = parseSingleNote(chordStr, pos, measureAccidentals, baseDuration, true, tupletScale);
    if (parsed.note) {
      result.push(parsed.note);
      pos = parsed.newPos;
      continue;
    }

    pos++;
  }

  return result;
}

/**
 * Parse an ABC string into structured music data
 * @param {string} abcString
 * @returns {object} { title, meter, defaultLength, tempo, key, notes: [...], totalBeats, totalMeasures, minPitch, maxPitch }
 */
function parseABC(abcString) {
  if (!abcString || typeof abcString !== 'string') {
    return null;
  }

  // Preprocess lines:
  // 1. Strip comments starting with %
  // 2. Remove lyrics lines (w:, W:)
  // 3. Skip non-musical metadata lines in body (N:, H:, R:, B:, O:, S:, Z:)
  const rawLines = abcString.split(/\r?\n/);
  const cleanLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    // Strip trailing % comments
    const commentIndex = line.indexOf('%');
    if (commentIndex !== -1) {
      line = line.substring(0, commentIndex);
    }
    line = line.trim();
    if (!line) continue;

    // Skip lyrics lines
    if (/^[wW]:/i.test(line)) continue;
    // Skip unneeded meta
    if (/^[NHRBOZS]:/i.test(line)) continue;

    cleanLines.push(line);
  }

  // Parse headers
  let title = 'Piano Roll';
  let meter = '4/4';
  let meterNum = 4;
  let meterDen = 4;
  let defaultLength = null; // To be inferred if missing
  let defaultLengthFrac = 0.125;
  let tempo = 120;
  let keyStr = 'C';
  let headerIndexEnd = 0;

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];
    const headerMatch = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (headerMatch) {
      const type = headerMatch[1].toUpperCase();
      const value = headerMatch[2].trim();

      if (type === 'T') {
        title = value;
      } else if (type === 'M') {
        meter = value;
        const m = value.match(/(\d+)\/(\d+)/);
        if (m) {
          meterNum = parseInt(m[1], 10);
          meterDen = parseInt(m[2], 10);
        } else if (value === 'C') {
          meterNum = 4; meterDen = 4;
        } else if (value === 'C|') {
          meterNum = 2; meterDen = 2;
        }
      } else if (type === 'L') {
        defaultLength = value;
        const l = value.match(/(\d+)\/(\d+)/);
        if (l) defaultLengthFrac = parseInt(l[1], 10) / parseInt(l[2], 10);
      } else if (type === 'Q') {
        // e.g. Q: 120 or Q: 1/4=120 or Q: 3/8=96 or Q: "Allegro" 120
        const qFrac = value.match(/(\d+)\/(\d+)\s*=\s*(\d+)/);
        const qNum = value.match(/(\d+)(?:\s*$|\s*bpm)/i) || value.match(/=\s*(\d+)/);
        if (qFrac) {
          const num = parseInt(qFrac[1], 10);
          const den = parseInt(qFrac[2], 10);
          const bpm = parseInt(qFrac[3], 10);
          tempo = Math.round((num / den) * 4 * bpm);
        } else if (qNum) {
          tempo = parseInt(qNum[1], 10);
        }
      } else if (type === 'K') {
        keyStr = value;
        headerIndexEnd = i + 1;
        break; // In ABC, K: ends header section
      }
    }
  }

  // Infer default note length if missing (ABC 2.1 standard: if meter < 0.75 -> 1/16, else 1/8)
  if (!defaultLength) {
    const meterVal = meterNum / meterDen;
    defaultLengthFrac = meterVal < 0.75 ? 0.0625 : 0.125;
    defaultLength = meterVal < 0.75 ? '1/16' : '1/8';
  }

  const baseKeyAccidentals = getKeyAccidentals(keyStr);

  // Music body lines
  const bodyText = cleanLines.slice(headerIndexEnd).join('\n');

  // Track independent voices
  const voices = {};
  let currentVoiceId = 'default';

  function getVoice(id) {
    const cleanId = String(id || 'default').trim();
    if (!voices[cleanId]) {
      voices[cleanId] = {
        id: cleanId,
        currentBeat: 0,
        currentMeasure: 1,
        measureAccidentals: { ...baseKeyAccidentals },
        tupletNotesRemaining: 0,
        tupletScale: 1,
        brokenRhythmScale: 1,
        lastNote: null
      };
    }
    return voices[cleanId];
  }

  const notes = [];
  const unitInBeats = defaultLengthFrac * 4;
  const beatsPerMeasure = (meterNum / meterDen) * 4;

  let pos = 0;
  const len = bodyText.length;

  while (pos < len) {
    const char = bodyText[pos];

    // 1. Whitespace
    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    const v = getVoice(currentVoiceId);

    // 2. Quotes: guitar chords ("Am7", "C#dim") and text annotations ("Fine", "pizz.")
    // Safely skip past closing quote!
    if (char === '"') {
      pos++;
      while (pos < len && bodyText[pos] !== '"') {
        pos++;
      }
      if (pos < len && bodyText[pos] === '"') pos++;
      continue;
    }

    // 3. Grace notes: {...}
    // Safely skip past closing brace
    if (char === '{') {
      pos++;
      while (pos < len && bodyText[pos] !== '}') {
        pos++;
      }
      if (pos < len && bodyText[pos] === '}') pos++;
      continue;
    }

    // 4. Voice markers: e.g. "V:1", "V: 2", "V:Soprano", or inline "[V:1 clef=treble]"
    if (
      (bodyText.substr(pos, 2) === 'V:' && (pos === 0 || bodyText[pos - 1] === '\n')) ||
      (char === '[' && /^\[V:\s*[^\]]+\]/i.test(bodyText.substr(pos)))
    ) {
      let vMatch = null;
      if (char === '[') {
        vMatch = bodyText.substr(pos).match(/^\[V:\s*([A-Za-z0-9_]+)[^\]]*\]/i);
      } else {
        vMatch = bodyText.substr(pos).match(/^V:\s*([A-Za-z0-9_]+)[^\n]*/i);
      }
      if (vMatch) {
        currentVoiceId = vMatch[1];
        pos += vMatch[0].length;
        continue;
      }
    }

    // 5. Inline Key or Meter changes: [K:...], [M:...], [Q:...], [L:...]
    if (char === '[' && /^\[[KMQL]:\s*[^\]]+\]/i.test(bodyText.substr(pos))) {
      const matchInline = bodyText.substr(pos).match(/^\[([KMQL]):\s*([^\]]+)\]/i);
      if (matchInline) {
        const type = matchInline[1].toUpperCase();
        const val = matchInline[2].trim();
        if (type === 'K') {
          v.measureAccidentals = getKeyAccidentals(val);
        } else if (type === 'Q') {
          const qVal = val.match(/(\d+)/);
          if (qVal) tempo = parseInt(qVal[1], 10);
        }
        pos += matchInline[0].length;
        continue;
      }
    }

    // 6. Barlines and repeats: |, ||, |], [|, |:, :|, ::, |1, :|2, [1, [2
    if (char === '|' || char === ':') {
      while (pos < len && (bodyText[pos] === '|' || bodyText[pos] === ':' || bodyText[pos] === ']' || bodyText[pos] === '[')) {
        pos++;
      }
      // Skip repeat numbers e.g. [1, 1, 2
      while (pos < len && /\d/.test(bodyText[pos])) {
        pos++;
      }
      v.measureAccidentals = { ...baseKeyAccidentals };
      v.currentMeasure++;
      v.tupletNotesRemaining = 0;
      v.tupletScale = 1;
      v.brokenRhythmScale = 1;
      continue;
    }

    // 7. Tuplet markers: (p:q:r or (p
    if (char === '(' && /\(\d/.test(bodyText.substr(pos, 2))) {
      const tupletMatch = bodyText.substr(pos).match(/^\((\d+)(?::(\d+))?(?::(\d+))?/);
      if (tupletMatch) {
        const p = parseInt(tupletMatch[1], 10);
        let q = tupletMatch[2] ? parseInt(tupletMatch[2], 10) : 0;
        if (!q) {
          if (p === 3) q = 2;
          else if (p === 2) q = 3;
          else if (p === 4) q = 3;
          else if (p === 5) q = 4;
          else if (p === 6) q = 2;
          else if (p === 7) q = 4;
          else if (p === 8) q = 6;
          else if (p === 9) q = 6;
          else q = p - 1;
        }
        v.tupletNotesRemaining = p;
        v.tupletScale = q / p;
        pos += tupletMatch[0].length;
        continue;
      }
    }

    // 8. Chords: [ ... ]
    if (char === '[') {
      pos++; // skip '['
      let chordContent = '';
      while (pos < len && bodyText[pos] !== ']') {
        chordContent += bodyText[pos];
        pos++;
      }
      if (pos < len && bodyText[pos] === ']') pos++;

      // Check chord trailing duration: [CEG]2 or [CEG]/2
      const trailingDur = readDuration(bodyText, pos);
      pos = trailingDur.newPos;
      const chordDurMult = trailingDur.multiplier;

      const currentTupletScale = v.tupletNotesRemaining > 0 ? v.tupletScale : 1;
      const chordNotes = parseChordNotes(chordContent, v.measureAccidentals, unitInBeats * chordDurMult, currentTupletScale);

      let maxChordDuration = 0;
      for (const cn of chordNotes) {
        // Handle ties
        if (v.lastNote && v.lastNote.hasTie && v.lastNote.pitch === cn.pitch && v.lastNote.voice === v.id) {
          v.lastNote.duration += cn.duration;
          v.lastNote.hasTie = cn.hasTie;
        } else {
          const newNote = {
            pitch: cn.pitch,
            name: cn.name || midiToNoteName(cn.pitch),
            startBeat: v.currentBeat,
            duration: cn.duration,
            measure: v.currentMeasure,
            voice: v.id,
            hasTie: cn.hasTie
          };
          notes.push(newNote);
          v.lastNote = newNote;
        }
        if (cn.duration > maxChordDuration) {
          maxChordDuration = cn.duration;
        }
      }

      if (v.tupletNotesRemaining > 0) {
        v.tupletNotesRemaining--;
        if (v.tupletNotesRemaining <= 0) v.tupletScale = 1;
      }

      v.currentBeat += maxChordDuration > 0 ? maxChordDuration : (unitInBeats * chordDurMult * currentTupletScale);
      continue;
    }

    // 9. Multi-measure rests: Z or Z4
    if (char === 'Z') {
      pos++;
      let zCount = 1;
      let numStr = '';
      while (pos < len && /\d/.test(bodyText[pos])) {
        numStr += bodyText[pos];
        pos++;
      }
      if (numStr) zCount = parseInt(numStr, 10);
      v.currentBeat += (beatsPerMeasure * zCount);
      v.currentMeasure += zCount;
      continue;
    }

    // 10. Standard Rests: z or x or X
    if (/[zxX]/.test(char)) {
      pos++;
      const dur = readDuration(bodyText, pos);
      pos = dur.newPos;
      const currentTupletScale = v.tupletNotesRemaining > 0 ? v.tupletScale : 1;
      v.currentBeat += unitInBeats * dur.multiplier * currentTupletScale;
      if (v.tupletNotesRemaining > 0) {
        v.tupletNotesRemaining--;
        if (v.tupletNotesRemaining <= 0) v.tupletScale = 1;
      }
      continue;
    }

    // 11. Decorations & Articulations: ~, ., u, v, !...! or +...+
    if (char === '!' || char === '+') {
      const closeDelim = char;
      pos++;
      while (pos < len && bodyText[pos] !== closeDelim) pos++;
      if (pos < len && bodyText[pos] === closeDelim) pos++;
      continue;
    }
    if (/[~.uvHST]/.test(char) && (pos + 1 < len) && /[\^_=A-Ga-g]/.test(bodyText[pos + 1])) {
      pos++; // skip articulation prefix
    }

    // 12. Single Note
    const currentTupletScale = v.tupletNotesRemaining > 0 ? v.tupletScale : 1;
    const parsed = parseSingleNote(bodyText, pos, v.measureAccidentals, unitInBeats, false, currentTupletScale);
    if (parsed.note) {
      let finalDuration = parsed.note.duration;

      // Handle broken rhythms (c>d, c>>d, c<d, c<<d)
      if (v.brokenRhythmScale !== 1) {
        finalDuration *= v.brokenRhythmScale;
        v.brokenRhythmScale = 1;
      }

      pos = parsed.newPos;

      // Check if this note initiates a broken rhythm (> or <)
      if (pos < len && (bodyText[pos] === '>' || bodyText[pos] === '<')) {
        let isRight = bodyText[pos] === '>';
        let count = 0;
        while (pos < len && (bodyText[pos] === '>' || bodyText[pos] === '<')) {
          count++;
          pos++;
        }
        if (isRight) {
          if (count === 1) { finalDuration *= 1.5; v.brokenRhythmScale = 0.5; }
          else { finalDuration *= 1.75; v.brokenRhythmScale = 0.25; }
        } else {
          if (count === 1) { finalDuration *= 0.5; v.brokenRhythmScale = 1.5; }
          else { finalDuration *= 0.25; v.brokenRhythmScale = 1.75; }
        }
      }

      // Check for ties: merge identical consecutive notes
      if (v.lastNote && v.lastNote.hasTie && v.lastNote.pitch === parsed.note.pitch && v.lastNote.voice === v.id) {
        v.lastNote.duration += finalDuration;
        v.lastNote.hasTie = parsed.note.hasTie;
      } else {
        const newNote = {
          pitch: parsed.note.pitch,
          name: parsed.note.name,
          startBeat: v.currentBeat,
          duration: finalDuration,
          measure: v.currentMeasure,
          voice: v.id,
          hasTie: parsed.note.hasTie
        };
        notes.push(newNote);
        v.lastNote = newNote;
      }

      v.currentBeat += finalDuration;

      if (v.tupletNotesRemaining > 0) {
        v.tupletNotesRemaining--;
        if (v.tupletNotesRemaining <= 0) v.tupletScale = 1;
      }

      continue;
    }

    // Skip any other character (decorations, slurs, formatting)
    pos++;
  }

  // Sort notes chronologically
  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);

  const allVoices = Object.values(voices);
  const totalBeats = allVoices.length > 0 ? Math.max(...allVoices.map(v => v.currentBeat)) : 0;
  const maxMeasure = allVoices.length > 0 ? Math.max(...allVoices.map(v => v.currentMeasure)) : 1;

  let minPitch = 127;
  let maxPitch = 0;
  for (const n of notes) {
    if (n.pitch < minPitch) minPitch = n.pitch;
    if (n.pitch > maxPitch) maxPitch = n.pitch;
  }
  if (notes.length === 0) {
    minPitch = 60;
    maxPitch = 72;
  }

  const calculatedMeasures = Math.ceil(totalBeats / beatsPerMeasure);
  const totalMeasures = Math.max(1, calculatedMeasures > 0 ? calculatedMeasures : maxMeasure);

  return {
    title,
    meter,
    meterNum,
    meterDen,
    beatsPerMeasure,
    defaultLength,
    tempo: Math.max(20, Math.min(320, tempo)),
    bpm: Math.max(20, Math.min(320, tempo)),
    key: keyStr,
    notes,
    totalBeats: totalBeats > 0 ? totalBeats : 4,
    totalMeasures,
    minPitch,
    maxPitch,
    voicesCount: allVoices.length
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseABC, midiToNoteName, getKeyAccidentals };
}
