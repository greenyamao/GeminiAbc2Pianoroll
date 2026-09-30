/**
 * Pure JavaScript Standard MIDI File (SMF Type 0 and Type 1) Parser
 * Converts binary .mid / .midi files directly into Piano Roll notes and ABC-compatible music data.
 * Zero external dependencies.
 */

function parseMIDI(bufferOrArrayBuffer, options = {}) {
  const quantizeStep = options.quantizeStep !== undefined ? options.quantizeStep : 0.25; // 1/16 note default
  
  let arrayBuffer;
  let byteOffset = 0;
  let byteLength = 0;

  if (bufferOrArrayBuffer instanceof ArrayBuffer) {
    arrayBuffer = bufferOrArrayBuffer;
    byteOffset = 0;
    byteLength = arrayBuffer.byteLength;
  } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(bufferOrArrayBuffer)) {
    arrayBuffer = bufferOrArrayBuffer.buffer;
    byteOffset = bufferOrArrayBuffer.byteOffset;
    byteLength = bufferOrArrayBuffer.byteLength;
  } else {
    throw new Error('Invalid input: Expected ArrayBuffer or TypedArray/Buffer');
  }

  const view = new DataView(arrayBuffer, byteOffset, byteLength);
  let pos = 0;
  const len = view.byteLength;

  if (len < 14) {
    throw new Error('Invalid MIDI file: File is too small (< 14 bytes)');
  }

  // 1. Read MThd Chunk
  const mthdHeader = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
  if (mthdHeader !== 'MThd') {
    throw new Error(`Invalid MIDI file: Expected 'MThd', found '${mthdHeader}'`);
  }
  pos += 4;

  const headerLength = view.getUint32(pos, false);
  pos += 4;

  const format = view.getUint16(pos, false);
  pos += 2;

  const numTracks = view.getUint16(pos, false);
  pos += 2;

  const timeDivision = view.getUint16(pos, false);
  pos += 2;

  // Skip any extra header bytes if headerLength > 6
  if (headerLength > 6) {
    pos += (headerLength - 6);
  }

  // PPQN (pulses per quarter note)
  let ppqn = 480;
  if ((timeDivision & 0x8000) === 0) {
    ppqn = timeDivision;
  } else {
    // SMPTE timecode (rare)
    const framesPerSec = 0x100 - ((timeDivision >> 8) & 0xFF);
    const subFrames = timeDivision & 0xFF;
    ppqn = framesPerSec * subFrames;
  }
  if (!ppqn || ppqn <= 0) ppqn = 480;

  let detectedTempo = 120;
  let detectedMeter = '4/4';
  let detectedTitle = '';
  const parsedNotes = [];

  // Helper: Read Variable-Length Quantity (VLQ)
  function readVLQ() {
    let value = 0;
    let byte = 0;
    do {
      if (pos >= len) break;
      byte = view.getUint8(pos++);
      value = (value << 7) | (byte & 0x7F);
    } while (byte & 0x80);
    return value;
  }

  // 2. Read each Track Chunk (MTrk)
  for (let t = 0; t < numTracks && pos < len; t++) {
    // Find next MTrk header
    while (pos <= len - 4) {
      const tag = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
      if (tag === 'MTrk') break;
      pos++;
    }
    if (pos > len - 8) break;

    pos += 4; // Skip 'MTrk'
    const trackLength = view.getUint32(pos, false);
    pos += 4;
    const trackEnd = Math.min(len, pos + trackLength);

    let currentTicks = 0;
    let runningStatus = 0;
    const activeNotes = new Map(); // key: "channel_pitch" -> { startTicks, velocity }

    while (pos < trackEnd) {
      const deltaTicks = readVLQ();
      currentTicks += deltaTicks;

      if (pos >= trackEnd) break;
      let statusByte = view.getUint8(pos);

      if (statusByte < 0x80) {
        // Running status: reuse previous status byte
        statusByte = runningStatus;
      } else {
        pos++;
        runningStatus = statusByte;
      }

      const eventType = statusByte & 0xF0;
      const channel = statusByte & 0x0F;

      if (eventType === 0x90) { // Note On
        if (pos >= trackEnd) break;
        const pitch = view.getUint8(pos++);
        const velocity = (pos < trackEnd) ? view.getUint8(pos++) : 64;
        const key = `${channel}_${pitch}`;

        if (velocity === 0) {
          // Note On with velocity 0 is Note Off
          if (activeNotes.has(key)) {
            const startInfo = activeNotes.get(key);
            activeNotes.delete(key);
            const durationTicks = Math.max(1, currentTicks - startInfo.startTicks);
            parsedNotes.push({
              pitch: pitch,
              startBeat: startInfo.startTicks / ppqn,
              duration: durationTicks / ppqn,
              velocity: startInfo.velocity
            });
          }
        } else {
          // If previous note on same pitch is already open, close it first
          if (activeNotes.has(key)) {
            const startInfo = activeNotes.get(key);
            const durationTicks = Math.max(1, currentTicks - startInfo.startTicks);
            parsedNotes.push({
              pitch: pitch,
              startBeat: startInfo.startTicks / ppqn,
              duration: durationTicks / ppqn,
              velocity: startInfo.velocity
            });
          }
          activeNotes.set(key, { startTicks: currentTicks, velocity: velocity });
        }
      } else if (eventType === 0x80) { // Note Off
        if (pos >= trackEnd) break;
        const pitch = view.getUint8(pos++);
        if (pos < trackEnd) pos++; // Skip release velocity
        const key = `${channel}_${pitch}`;

        if (activeNotes.has(key)) {
          const startInfo = activeNotes.get(key);
          activeNotes.delete(key);
          const durationTicks = Math.max(1, currentTicks - startInfo.startTicks);
          parsedNotes.push({
            pitch: pitch,
            startBeat: startInfo.startTicks / ppqn,
            duration: durationTicks / ppqn,
            velocity: startInfo.velocity
          });
        }
      } else if (eventType === 0xA0 || eventType === 0xB0 || eventType === 0xE0) {
        // 2 data bytes to skip (Aftertouch, Control Change, Pitch Bend)
        pos = Math.min(trackEnd, pos + 2);
      } else if (eventType === 0xC0 || eventType === 0xD0) {
        // 1 data byte to skip (Program Change, Channel Pressure)
        pos = Math.min(trackEnd, pos + 1);
      } else if (statusByte === 0xF0 || statusByte === 0xF7) {
        // SysEx: read length VLQ and skip
        const sysexLen = readVLQ();
        pos = Math.min(trackEnd, pos + sysexLen);
      } else if (statusByte === 0xFF) {
        // Meta Event
        if (pos >= trackEnd) break;
        const metaType = view.getUint8(pos++);
        const metaLength = readVLQ();
        const metaDataEnd = Math.min(trackEnd, pos + metaLength);

        if (metaType === 0x51 && metaLength >= 3) { // Set Tempo
          const usPerQuarter = (view.getUint8(pos) << 16) | (view.getUint8(pos + 1) << 8) | view.getUint8(pos + 2);
          if (usPerQuarter > 0) {
            detectedTempo = Math.round(60000000 / usPerQuarter);
          }
        } else if (metaType === 0x58 && metaLength >= 2) { // Time Signature
          const num = view.getUint8(pos);
          const den = Math.pow(2, view.getUint8(pos + 1));
          if (num > 0 && den > 0) {
            detectedMeter = `${num}/${den}`;
          }
        } else if (metaType === 0x03 && metaLength > 0 && !detectedTitle) { // Sequence / Track Name
          let name = '';
          for (let i = 0; i < metaLength && (pos + i) < trackEnd; i++) {
            name += String.fromCharCode(view.getUint8(pos + i));
          }
          if (name.trim()) detectedTitle = name.trim();
        }

        pos = metaDataEnd;
      } else {
        // Unknown status byte, increment to prevent infinite loops
        pos++;
      }
    }

    // Flush any remaining active notes at end of track
    for (const [key, startInfo] of activeNotes.entries()) {
      const pitch = parseInt(key.split('_')[1], 10);
      const durationTicks = Math.max(1, currentTicks - startInfo.startTicks);
      parsedNotes.push({
        pitch: pitch,
        startBeat: startInfo.startTicks / ppqn,
        duration: durationTicks / ppqn,
        velocity: startInfo.velocity
      });
    }

    pos = trackEnd;
  }

  if (parsedNotes.length === 0) {
    throw new Error('No musical notes found in this MIDI file.');
  }

  // Helper for quantization
  function quantizeVal(val, step) {
    return Math.round(Math.round(val / step) * step * 10000) / 10000;
  }

  // 3. Clean, quantize, and sort notes
  const cleanNotes = parsedNotes.map(n => {
    const qStart = Math.max(0, quantizeVal(n.startBeat, quantizeStep));
    const qDur = Math.max(quantizeStep, quantizeVal(n.duration, quantizeStep));
    return {
      pitch: Math.max(21, Math.min(108, n.pitch)),
      startBeat: qStart,
      duration: qDur,
      measure: Math.floor(qStart / 4) + 1
    };
  }).sort((a, b) => a.startBeat - b.startBeat || b.pitch - a.pitch);

  let maxBeat = 0;
  let minP = 127;
  let maxP = 0;
  for (const n of cleanNotes) {
    maxBeat = Math.max(maxBeat, n.startBeat + n.duration);
    minP = Math.min(minP, n.pitch);
    maxP = Math.max(maxP, n.pitch);
  }

  // Calculate beats per measure from detected meter
  let beatsPerMeasure = 4;
  if (detectedMeter) {
    const parts = detectedMeter.split('/');
    if (parts.length === 2) {
      const num = parseInt(parts[0], 10);
      const den = parseInt(parts[1], 10);
      if (num && den) beatsPerMeasure = (num / den) * 4;
    }
  }

  const totalMeasures = Math.max(1, Math.ceil(maxBeat / beatsPerMeasure));
  const totalBeats = totalMeasures * beatsPerMeasure;

  return {
    header: {
      title: detectedTitle || 'Imported MIDI',
      meter: detectedMeter,
      tempo: detectedTempo,
      key: 'C'
    },
    key: 'C',
    meter: detectedMeter,
    tempo: detectedTempo,
    totalBeats: totalBeats,
    totalMeasures: totalMeasures,
    minPitch: minP <= maxP ? minP : 48,
    maxPitch: minP <= maxP ? maxP : 72,
    notes: cleanNotes
  };
}

/**
 * Encodes variable-length quantity (VLQ) for MIDI format
 */
function encodeVLQ(val) {
  let v = Math.max(0, Math.round(val));
  const buffer = [v & 0x7F];
  while ((v >>= 7) > 0) {
    buffer.unshift((v & 0x7F) | 0x80);
  }
  return buffer;
}

/**
 * Encodes musicData (notes, tempo, meter, title) into standard binary MIDI format (SMF Type 0)
 * @param {object} musicData
 * @returns {Uint8Array} Binary MIDI bytes
 */
function createMIDI(musicData) {
  const ppqn = 480;
  const notes = (musicData && musicData.notes) || [];
  const tempo = (musicData && musicData.tempo) || 120;
  const meter = (musicData && musicData.meter) || '4/4';
  const title = (musicData && (musicData.title || (musicData.header && musicData.header.title))) || 'NotebookLM Score';

  const trackEvents = [];

  // 1. Time Signature Meta Event: 0xFF 0x58 0x04 nn dd cc bb
  const meterParts = meter.split('/');
  const num = parseInt(meterParts[0], 10) || 4;
  const den = parseInt(meterParts[1], 10) || 4;
  const denPower = Math.round(Math.log2(den)) || 2;
  trackEvents.push(0x00, 0xFF, 0x58, 0x04, num, denPower, 24, 8);

  // 2. Tempo Meta Event: 0xFF 0x51 0x03 tt tt tt (microseconds per quarter note)
  const usPerQuarter = Math.round(60000000 / tempo);
  trackEvents.push(0x00, 0xFF, 0x51, 0x03, (usPerQuarter >> 16) & 0xFF, (usPerQuarter >> 8) & 0xFF, usPerQuarter & 0xFF);

  // 3. Track Name Meta Event
  const titleBytes = [];
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i);
    titleBytes.push(code < 128 ? code : 63); // ASCII-safe track name
  }
  trackEvents.push(0x00, 0xFF, 0x03, ...encodeVLQ(titleBytes.length), ...titleBytes);

  // 4. Note Events
  const events = [];
  for (const n of notes) {
    const startTick = Math.max(0, Math.round(n.startBeat * ppqn));
    const endTick = Math.max(startTick + 1, Math.round((n.startBeat + n.duration) * ppqn));
    events.push({ tick: startTick, type: 'on', pitch: Math.max(0, Math.min(127, n.pitch)), vel: n.velocity || 90 });
    events.push({ tick: endTick, type: 'off', pitch: Math.max(0, Math.min(127, n.pitch)), vel: 0 });
  }

  // Sort: tick ascending; if same tick, 'off' comes before 'on'
  events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let lastTick = 0;
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    const deltaBytes = encodeVLQ(delta);
    if (ev.type === 'on') {
      trackEvents.push(...deltaBytes, 0x90, ev.pitch, ev.vel);
    } else {
      trackEvents.push(...deltaBytes, 0x80, ev.pitch, 0x00);
    }
  }

  // 5. End of Track Meta Event: 0xFF 0x2F 0x00
  trackEvents.push(0x00, 0xFF, 0x2F, 0x00);

  const trackLen = trackEvents.length;
  const trackChunk = [
    0x4D, 0x54, 0x72, 0x6B, // 'MTrk'
    (trackLen >> 24) & 0xFF,
    (trackLen >> 16) & 0xFF,
    (trackLen >> 8) & 0xFF,
    trackLen & 0xFF,
    ...trackEvents
  ];

  const headerChunk = [
    0x4D, 0x54, 0x68, 0x64, // 'MThd'
    0x00, 0x00, 0x00, 0x06, // length 6
    0x00, 0x00,             // format 0
    0x00, 0x01,             // 1 track
    (ppqn >> 8) & 0xFF,
    ppqn & 0xFF             // division
  ];

  return new Uint8Array([...headerChunk, ...trackChunk]);
}

/**
 * Browser helper to trigger instant download of a .mid file
 * @param {object} musicData
 * @param {string} [filename]
 */
function downloadMIDI(musicData, filename) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const bytes = createMIDI(musicData);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const rawTitle = filename || (musicData && (musicData.title || (musicData.header && musicData.header.title))) || 'FL_Score';
  const cleanName = rawTitle.replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '_');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${cleanName}.mid`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentElement) document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

if (typeof window !== 'undefined') {
  window.MIDIParser = {
    parse: parseMIDI,
    create: createMIDI,
    download: downloadMIDI
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMIDI, createMIDI, downloadMIDI };
}
