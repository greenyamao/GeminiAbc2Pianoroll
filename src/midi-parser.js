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

if (typeof window !== 'undefined') {
  window.MIDIParser = { parse: parseMIDI };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMIDI };
}
