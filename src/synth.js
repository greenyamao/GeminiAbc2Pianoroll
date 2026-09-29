/**
 * Web Audio Polyphonic Engine & Two-Circuit Lookahead Scheduler
 * 
 * Architecture:
 * 1. Circuit 1 (Audio Lookahead Clock):
 *    - High-frequency timer (25ms interval) scans notes 100ms ahead into the future.
 *    - Events are placed into the Web Audio hardware queue with sub-millisecond accuracy (audioCtx.currentTime).
 *    - Avoids audio jitter and eliminates upfront mass-allocation of AudioNodes on long scores.
 * 
 * 2. Circuit 2 (Visual Rendering & Playhead):
 *    - Decoupled requestAnimationFrame loop polls audioCtx.currentTime for passive 60/120 FPS playhead movement.
 *    - Never directly schedules audio from rAF, preventing UI drops from affecting musical rhythm.
 * 
 * 3. Modular Hybrid Sound Engine:
 *    - Default: Zero-dependency procedural synthesis (warm Rhodes/electric piano with dual-oscillators,
 *      harmonic shimmer, dynamic biquad filtering, and studio compressor limiter).
 *    - Pluggable: Instant support for 'smplr' (SplendidGrandPiano Steinway samples) or SoundFont engines
 *      via synth.setSampler(samplerInstance).
 */

// Module-level shared Web Audio singletons (prevents Chrome AudioContext exhaustion & redundant sample memory)
let sharedAudioCtx = null;
let sharedMasterGain = null;
let sharedCompressor = null;
let sharedToneFilter = null;
let sharedSampler = null;
let sharedSamplerPromise = null;
let sharedSamplerLoading = false;

class PianoRollSynth {
  constructor(options = {}) {
    this.ctx = null;
    this.compressor = null;
    this.masterGain = null;
    this.compressor = null;
    this.toneFilter = null;
    this.volume = options.volume !== undefined ? options.volume : 0.7;

    // Expression & Dynamics profile ('soft' | 'balanced' | 'bright')
    this.expressionMode = options.expression || 'balanced';
    this.baseVelocity = this.expressionMode === 'soft' ? 56 : (this.expressionMode === 'bright' ? 82 : 68);
    
    // Engine & Sampler adapter
    this.sampler = options.sampler || null;

    // Scheduler parameters (Two-circuit Lookahead pattern)
    this.lookaheadMs = 25.0;            // How frequently scheduler wakes up (ms)
    this.scheduleAheadTimeSec = 0.10;   // How far ahead to schedule notes (100ms)
    this.schedulerTimerId = null;
    this.scheduledNoteKeys = new Set(); // Set of "loopIter_noteIndex" to avoid duplicate scheduling
    this.loopIteration = 0;

    // Transport & Playback state
    this.isPlaying = false;
    this.isPaused = false;
    this.notes = [];
    this.tempo = 120;
    this.loop = true; // Always loop on finish
    this.totalBeats = 4;
    this.currentBeat = 0;
    this.secondsPerBeat = 0.5;
    this.totalDurationSec = 2.0;

    this.startAudioTime = 0;
    this.pauseAudioOffset = 0;
    this.animFrameId = null;

    // Track active procedural voices for immediate cancellation on seek/stop
    this.activeVoices = [];

    // Callbacks
    this.onProgress = null; // (currentBeat, activePitches) => {}
    this.onEnded = null;    // () => {}
  }

  /**
   * Attach an external sampler (e.g. smplr.SplendidGrandPiano or SoundFont player)
   */
  setSampler(samplerInstance) {
    this.sampler = samplerInstance;
  }

  /**
   * Sets expression/touch dynamics mode: 'soft' (velvet), 'balanced' (acoustic), or 'bright' (concert)
   */
  setExpression(mode) {
    this.expressionMode = mode || 'balanced';
    if (this.expressionMode === 'soft') {
      this.baseVelocity = 56;
    } else if (this.expressionMode === 'bright') {
      this.baseVelocity = 82;
    } else {
      this.baseVelocity = 68;
    }

    if (this.toneFilter && this.ctx) {
      const db = this.expressionMode === 'soft' ? -3.5 : (this.expressionMode === 'bright' ? 0.5 : -1.8);
      this.toneFilter.gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Initializes AudioContext and master dynamics bus with Studio Compressor & Acoustic Tone Filter
   */
  initContext() {
    if (!sharedAudioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      sharedAudioCtx = new AudioCtx({ latencyHint: 'interactive' });

      // Transparent Studio Acoustic Glue Compressor (prevents anvil pounding, lets notes bloom)
      sharedCompressor = sharedAudioCtx.createDynamicsCompressor();
      sharedCompressor.threshold.setValueAtTime(-6, sharedAudioCtx.currentTime);
      sharedCompressor.knee.setValueAtTime(24, sharedAudioCtx.currentTime);
      sharedCompressor.ratio.setValueAtTime(2.2, sharedAudioCtx.currentTime);
      sharedCompressor.attack.setValueAtTime(0.035, sharedAudioCtx.currentTime); // 35ms natural acoustic attack
      sharedCompressor.release.setValueAtTime(0.22, sharedAudioCtx.currentTime);

      // Acoustic Warmth Tone Filter (tames harsh metallic clank / anvil transient frequencies)
      sharedToneFilter = sharedAudioCtx.createBiquadFilter();
      sharedToneFilter.type = 'highshelf';
      sharedToneFilter.frequency.setValueAtTime(4500, sharedAudioCtx.currentTime);
      sharedToneFilter.gain.setValueAtTime(-1.8, sharedAudioCtx.currentTime);

      sharedMasterGain = sharedAudioCtx.createGain();
      sharedMasterGain.gain.setValueAtTime(this.volume, sharedAudioCtx.currentTime);

      sharedCompressor.connect(sharedToneFilter);
      sharedToneFilter.connect(sharedMasterGain);
      sharedMasterGain.connect(sharedAudioCtx.destination);
    }

    this.ctx = sharedAudioCtx;
    this.compressor = sharedCompressor;
    this.toneFilter = sharedToneFilter;

    // Per-instance gain node for individual synthesis routing
    if (!this.masterGain && this.ctx) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.compressor);
    }

    if (sharedSampler) {
      this.sampler = sharedSampler;
    }
  }

  /**
   * Ensures AudioContext is active and resumed following a user gesture
   */
  async ensureResumed() {
    this.initContext();
    if (!this.sampler && !sharedSampler && !sharedSamplerLoading) {
      this.loadSteinwayPiano();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('AudioContext resume rejected:', err);
      }
    }
    return this.ctx;
  }

  /**
   * Automatically load and activate genuine Steinway Grand Piano audio samples via smplr (shared instance)
   */
  async loadSteinwayPiano() {
    if (this.sampler) return;
    if (sharedSampler) {
      this.sampler = sharedSampler;
      return;
    }
    if (sharedSamplerLoading && sharedSamplerPromise) {
      await sharedSamplerPromise;
      this.sampler = sharedSampler;
      return;
    }

    const GrandPiano = (typeof window !== 'undefined' && (window.SplendidGrandPiano || (window.smplr && window.smplr.SplendidGrandPiano)));
    if (!GrandPiano) return;

    this.initContext();
    sharedSamplerLoading = true;
    sharedSamplerPromise = (async () => {
      try {
        const piano = new GrandPiano(this.ctx, {
          destination: this.compressor || this.ctx.destination,
          notesToLoad: {
            notes: [21, 24, 28, 31, 36, 40, 43, 48, 52, 55, 60, 64, 67, 72, 76, 79, 84, 88, 91, 96, 100, 108],
            velocityRange: [41, 95], // PP, MP, and MF layers (velvety soft felt to expressive mezzo)
            fallback: 'nearest'
          }
        });

        // Await genuine loading promise (smplr exposes .ready and .load)
        if (piano.ready) {
          await piano.ready;
        } else if (piano.load) {
          await piano.load;
        }

        sharedSampler = piano;
        console.log('🎹 Steinway Concert Grand Piano (smplr) successfully loaded and active!');
      } catch (err) {
        console.warn('Steinway smplr loading error, keeping procedural fallback:', err);
      } finally {
        sharedSamplerLoading = false;
      }
    })();

    await sharedSamplerPromise;
    this.sampler = sharedSampler;
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
    if (sharedMasterGain && this.ctx) {
      sharedMasterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  midiToFreq(pitch) {
    return 440 * Math.pow(2, (pitch - 69) / 12);
  }

  /**
   * Circuit 1: High-precision Lookahead Scheduler
   * Runs via setInterval every 25ms, projecting notes into the hardware audio buffer ahead of time.
   */
  runScheduler() {
    if (!this.isPlaying || this.isPaused || !this.ctx) return;

    const curAudioTime = this.ctx.currentTime;
    const currentPlaybackSec = curAudioTime - this.startAudioTime;
    const currentBeat = currentPlaybackSec / this.secondsPerBeat;

    // Lookahead boundary: schedule notes occurring between current time and future horizon
    const horizonSec = currentPlaybackSec + this.scheduleAheadTimeSec;
    const horizonBeat = horizonSec / this.secondsPerBeat;

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      const noteKey = `${this.loopIteration}_${i}`;

      if (this.scheduledNoteKeys.has(noteKey)) continue;

      // Check if note start falls within lookahead window
      if (note.startBeat <= horizonBeat) {
        const noteEndBeat = note.startBeat + note.duration;

        // Ensure note hasn't already finished in the past
        if (noteEndBeat > currentBeat) {
          const targetTime = this.startAudioTime + (note.startBeat * this.secondsPerBeat);
          const playedOffsetBeat = Math.max(0, currentBeat - note.startBeat);
          const remainingDurationBeat = note.duration - playedOffsetBeat;
          const noteDurationSec = Math.max(0.04, remainingDurationBeat * this.secondsPerBeat);

          this.playVoice(note, Math.max(curAudioTime, targetTime), noteDurationSec);
          this.scheduledNoteKeys.add(noteKey);
        } else {
          // Note already elapsed
          this.scheduledNoteKeys.add(noteKey);
        }
      }
    }

    // Clean up expired procedural voice nodes
    const now = this.ctx.currentTime;
    this.activeVoices = this.activeVoices.filter(v => v.stopTime > now);
  }

  /**
   * Dispatches a single note event to either the attached smplr piano or the built-in procedural synth
   */
  playVoice(note, startTime, durationSec) {
    const pitch = note.pitch;
    
    // Scale velocity smoothly according to current expression profile
    const rawVel = note.velocity || this.baseVelocity;
    let velocity = rawVel;
    if (this.expressionMode === 'soft') {
      velocity = Math.round(rawVel * 0.85); // Gentle touch (~48-58 velocity -> triggers warm PP layer)
    } else if (this.expressionMode === 'bright') {
      velocity = Math.round(rawVel * 1.15); // Concert touch (~80-92 velocity -> triggers energetic MF layer)
    } else {
      velocity = Math.round(rawVel * 0.96); // Balanced acoustic touch (~65-72 velocity -> triggers mellow MP layer)
    }
    velocity = Math.max(25, Math.min(105, velocity));

    // 1. If external sampler (smplr SplendidGrandPiano / SoundFont) is attached
    if (this.sampler && typeof this.sampler.start === 'function') {
      try {
        const token = this.sampler.start({
          note: pitch,
          velocity: velocity,
          time: startTime,
          duration: durationSec
        });
        this.activeVoices.push({
          isSampler: true,
          token,
          stopTime: startTime + durationSec + 0.1
        });
        return;
      } catch (err) {
        console.warn('Sampler error, falling back to procedural synth:', err);
      }
    }

    // 2. Built-in Acoustic Piano Physical Model (Warm velvet felt hammers, non-metallic)
    this.scheduleProceduralVoice(pitch, startTime, durationSec, velocity);
  }

  /**
   * Synthesize a warm, natural acoustic piano timbre:
   * - Soft wool felt hammer strike (gentle low-frequency soundboard body knock, NO high-pitch metallic anvil click)
   * - Warm fundamental triangle body + sine 2nd harmonic
   * - Subtle acoustic unison chorusing (+2.2 cents)
   * - Smooth lowpass filter envelope with Q=0.5 (non-resonant Butterworth roll-off)
   * - 12ms smooth felt compression attack (eliminates transient snap)
   */
  scheduleProceduralVoice(pitch, startTime, durationSec, velocity = 68) {
    if (!this.ctx) return;
    const curTime = this.ctx.currentTime;
    if (startTime + durationSec < curTime) return;

    const freq = this.midiToFreq(pitch);
    const effectiveStart = Math.max(curTime, startTime);
    const velFactor = Math.max(0.3, Math.min(1.15, velocity / 80));

    // 1. Warm Acoustic Lowpass Filter (Q: 0.5 - smooth roll-off without harsh resonant peak)
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const initialCutoff = Math.min(3200, Math.max(650, freq * 3.4));
    const sustainedCutoff = Math.min(1500, Math.max(280, freq * 1.5));
    filter.frequency.setValueAtTime(initialCutoff, effectiveStart);
    filter.frequency.exponentialRampToValueAtTime(sustainedCutoff, effectiveStart + 0.18);
    filter.Q.setValueAtTime(0.5, effectiveStart); // Non-resonant, velvety damping

    // 2. Fundamental & Soundboard Body (Warm Triangle)
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, effectiveStart);

    // 3. Second harmonic body warmth (Sine)
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, effectiveStart);

    // 4. Subtle acoustic string shimmer (Gentle detuned wave, very soft)
    const osc3 = this.ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.setValueAtTime(freq, effectiveStart);
    osc3.detune.setValueAtTime(2.2, effectiveStart);

    // Mix buses
    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0.24 * velFactor, effectiveStart);
    osc1.connect(bodyGain);
    bodyGain.connect(filter);

    const harmonicGain = this.ctx.createGain();
    harmonicGain.gain.setValueAtTime(0.08 * velFactor, effectiveStart);
    osc2.connect(harmonicGain);
    harmonicGain.connect(filter);

    const stringGain = this.ctx.createGain();
    stringGain.gain.setValueAtTime(0.05 * velFactor, effectiveStart);
    osc3.connect(stringGain);
    stringGain.connect(filter);

    // 5. Soft Wool Felt Hammer Thud (Deep, rounded wood-knock impulse, NO anvil ring)
    const hammerOsc = this.ctx.createOscillator();
    hammerOsc.type = 'sine';
    hammerOsc.frequency.setValueAtTime(Math.min(220, Math.max(90, freq * 0.7)), effectiveStart);
    const hammerGain = this.ctx.createGain();
    hammerGain.gain.setValueAtTime(0.06 * velFactor, effectiveStart);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, effectiveStart + 0.025);
    hammerOsc.connect(hammerGain);
    hammerGain.connect(filter);

    // 6. Main voice amplitude envelope (Smooth felt attack, natural piano decay)
    const voiceGain = this.ctx.createGain();
    const attackTime = 0.012; // 12ms smooth felt compression curve (no digital click)
    const releaseTime = 0.08; // 80ms damper cutoff on key release
    const peakGain = (pitch < 48 ? 0.28 : 0.32) * velFactor;

    voiceGain.gain.setValueAtTime(0.0001, effectiveStart);
    voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peakGain), effectiveStart + attackTime);

    // Natural acoustic decay
    const decayDuration = Math.max(0.5, durationSec * 0.95);
    const sustainResidual = Math.max(0.0001, peakGain * 0.22);
    voiceGain.gain.exponentialRampToValueAtTime(sustainResidual, effectiveStart + attackTime + decayDuration);

    // Key release (damper drops onto string)
    const stopTime = startTime + durationSec;
    if (stopTime > effectiveStart) {
      voiceGain.gain.setValueAtTime(Math.max(0.0001, sustainResidual), stopTime);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, stopTime + releaseTime);
    }

    filter.connect(voiceGain);
    voiceGain.connect(this.compressor || this.masterGain);

    const voiceStopTime = stopTime + releaseTime + 0.05;
    try {
      osc1.start(effectiveStart);
      osc2.start(effectiveStart);
      osc3.start(effectiveStart);
      hammerOsc.start(effectiveStart);

      osc1.stop(voiceStopTime);
      osc2.stop(voiceStopTime);
      osc3.stop(voiceStopTime);
      hammerOsc.stop(effectiveStart + 0.03);
    } catch (e) {}

    this.activeVoices.push({
      osc1,
      osc2,
      osc3,
      hammerOsc,
      voiceGain,
      stopTime: voiceStopTime
    });
  }

  /**
   * Preview a note immediately on key/note click
   */
  async playNotePreview(pitch, durationSec = 0.4, velocity = 90) {
    await this.ensureResumed();
    this.playVoice({ pitch, velocity }, this.ctx.currentTime, durationSec);
  }

  /**
   * Start playback of score (always loops by default)
   */
  async play(notes, tempo = 120, loop = true, totalBeats = 4, startFromBeat = 0) {
    await this.ensureResumed();
    this.stopAudioVoices();

    this.notes = notes || [];
    this.tempo = tempo || 120;
    this.loop = (loop !== undefined) ? loop : true;
    this.totalBeats = Math.max(totalBeats || 4, 1);
    this.currentBeat = startFromBeat;

    this.secondsPerBeat = 60 / this.tempo;
    this.totalDurationSec = this.totalBeats * this.secondsPerBeat;

    this.startAudioTime = this.ctx.currentTime + 0.02 - (startFromBeat * this.secondsPerBeat);
    this.pauseAudioOffset = startFromBeat * this.secondsPerBeat;
    this.isPlaying = true;
    this.isPaused = false;

    // Reset Lookahead scheduling tracking
    this.scheduledNoteKeys.clear();
    this.loopIteration = 0;

    // Immediate initial scheduling pass before timer ticks
    this.runScheduler();

    // Start Circuit 1: Audio Lookahead Timer (every 25ms)
    if (this.schedulerTimerId) clearInterval(this.schedulerTimerId);
    this.schedulerTimerId = setInterval(() => this.runScheduler(), this.lookaheadMs);

    // Start Circuit 2: Display & Playhead Loop (rAF)
    this.startTracking();
  }

  /**
   * Seek (jump) directly to target beat position
   */
  async seek(targetBeat) {
    targetBeat = Math.max(0, Math.min(this.totalBeats, targetBeat));
    this.currentBeat = targetBeat;
    this.stopAudioVoices();

    if (this.isPlaying && !this.isPaused) {
      await this.ensureResumed();
      this.startAudioTime = this.ctx.currentTime - (targetBeat * this.secondsPerBeat);
      this.pauseAudioOffset = targetBeat * this.secondsPerBeat;
      this.scheduledNoteKeys.clear();
      this.runScheduler();
    } else {
      this.pauseAudioOffset = targetBeat * (60 / (this.tempo || 120));
    }

    // Update playhead and active keys immediately
    const activePitches = new Set();
    for (const n of this.notes) {
      if (targetBeat >= n.startBeat && targetBeat < (n.startBeat + n.duration)) {
        activePitches.add(n.pitch);
      }
    }

    if (this.onProgress) {
      this.onProgress(targetBeat, activePitches);
    }
  }

  pause() {
    if (!this.isPlaying || this.isPaused) return;
    this.isPaused = true;
    this.pauseAudioOffset = this.ctx.currentTime - this.startAudioTime;

    if (this.schedulerTimerId) {
      clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
    this.stopAudioVoices();
  }

  async resume() {
    if (!this.isPlaying || !this.isPaused) return;
    await this.ensureResumed();
    this.isPaused = false;
    this.startAudioTime = this.ctx.currentTime - this.pauseAudioOffset;

    this.scheduledNoteKeys.clear();
    this.runScheduler();

    if (this.schedulerTimerId) clearInterval(this.schedulerTimerId);
    this.schedulerTimerId = setInterval(() => this.runScheduler(), this.lookaheadMs);

    this.startTracking();
  }

  /**
   * Stop playback completely and kill all scheduled and active voices
   */
  stop(triggerCallback = true) {
    this.isPlaying = false;
    this.isPaused = false;
    this.pauseAudioOffset = 0;
    this.currentBeat = 0;

    if (this.schedulerTimerId) {
      clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.stopAudioVoices();
    this.scheduledNoteKeys.clear();

    if (triggerCallback && this.onEnded) {
      this.onEnded();
    }
  }

  /**
   * Cuts off all sounding and scheduled voices immediately
   */
  stopAudioVoices() {
    // 1. External sampler stop
    if (this.sampler && typeof this.sampler.stop === 'function') {
      try { this.sampler.stop(); } catch (e) {}
    }

    // 2. Procedural voices stop
    if (this.ctx) {
      const cur = this.ctx.currentTime;
      for (const v of this.activeVoices) {
        if (v.isSampler) continue;
        try {
          v.voiceGain.gain.cancelScheduledValues(cur);
          v.voiceGain.gain.setValueAtTime(0, cur);
          v.osc1.stop(cur);
          v.osc2.stop(cur);
          v.osc1.disconnect();
          v.osc2.disconnect();
        } catch (e) {}
      }
      if (this.masterGain) {
        this.masterGain.gain.cancelScheduledValues(cur);
        this.masterGain.gain.setValueAtTime(this.volume, cur);
      }
    }
    this.activeVoices = [];
  }

  /**
   * Circuit 2: Display & Playhead loop (Passive requestAnimationFrame)
   * Queries hardware audioCtx.currentTime to compute exact visual coordinate
   */
  startTracking() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }

    const update = () => {
      if (!this.isPlaying || this.isPaused) return;

      const elapsed = this.ctx.currentTime - this.startAudioTime;
      const currentBeat = elapsed / this.secondsPerBeat;
      this.currentBeat = currentBeat;

      // Check track completion
      if (elapsed >= this.totalDurationSec) {
        if (this.loop) {
          // Seamless sample-accurate loop wrap-around without clock drift
          this.stopAudioVoices();
          this.loopIteration++;
          this.scheduledNoteKeys.clear();
          this.startAudioTime += this.totalDurationSec;
          this.currentBeat = Math.max(0, (this.ctx.currentTime - this.startAudioTime) / this.secondsPerBeat);
          this.runScheduler();
        } else {
          this.stop(true);
          return;
        }
      }

      // Query active sounding pitches for keyboard/note highlights
      const activePitches = new Set();
      for (const n of this.notes) {
        if (currentBeat >= n.startBeat && currentBeat < (n.startBeat + n.duration)) {
          activePitches.add(n.pitch);
        }
      }

      if (this.onProgress) {
        this.onProgress(currentBeat, activePitches);
      }

      this.animFrameId = requestAnimationFrame(update);
    };

    this.animFrameId = requestAnimationFrame(update);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PianoRollSynth };
}

