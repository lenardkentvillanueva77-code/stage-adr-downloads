/**
 * renderer/pcm-recorder-processor.js
 *
 * AudioWorklet processor — runs on the audio render thread.
 * Captures mono PCM from channel 0 of the first input.
 *
 * Messages received from renderer main thread (via this.port):
 *   { type: 'start' }
 *     Begin capturing. Clears any existing buffer.
 *   { type: 'scheduleStop', stopAtAudioTime: number }
 *     Set the AudioContext time at which recording should stop.
 *     Recording stops within one render quantum (≤128 samples ≈ 2.67ms at 48kHz).
 *   { type: 'abort' }
 *     Immediately stop capturing, discard buffer, do not send recordingComplete.
 *
 * Messages sent to renderer main thread (via this.port):
 *   { type: 'recordingComplete', buffer: ArrayBuffer, sampleCount: number }
 *     PCM data as Float32 samples (mono). ArrayBuffer is transferred (zero-copy).
 *   { type: 'aborted' }
 *     Abort acknowledged, buffer discarded.
 *
 * Architecture note:
 *   PCM is accumulated here in full, then transferred in a single postMessage
 *   at take end. This avoids high-frequency IPC during recording. For ADR
 *   cue-length takes (typically 1–30 seconds), memory pressure is negligible.
 *   30s mono @ 48kHz float32 = 5.76MB.
 */

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._recording       = false;
    this._stopAtAudioTime = null;   // AudioContext time to stop (null = no limit set)
    this._chunks          = [];     // Float32Array buffers accumulated per quantum
    this._sampleCount     = 0;

    this.port.onmessage = (e) => {
      const { type, stopAtAudioTime } = e.data || {};
      switch (type) {
        case 'start':
          this._recording       = true;
          this._stopAtAudioTime = null;
          this._chunks          = [];
          this._sampleCount     = 0;
          break;

        case 'scheduleStop':
          // stopAtAudioTime is an AudioContext.currentTime value
          this._stopAtAudioTime = (typeof stopAtAudioTime === 'number') ? stopAtAudioTime : null;
          break;

        case 'abort':
          this._recording       = false;
          this._stopAtAudioTime = null;
          this._chunks          = [];
          this._sampleCount     = 0;
          this.port.postMessage({ type: 'aborted' });
          break;
      }
    };
  }

  /**
   * Called by the audio engine every render quantum (~128 samples).
   * Must return true to keep the processor alive.
   */
  process(inputs) {
    if (!this._recording) return true;

    const input   = inputs[0];
    const channel = input && input[0];   // mono: channel 0 only

    if (channel && channel.length > 0) {
      // Check scheduled stop BEFORE writing this quantum.
      // currentTime and currentFrame are AudioWorkletGlobalScope globals.
      const nowSecs = currentFrame / sampleRate;  // eslint-disable-line no-undef

      if (this._stopAtAudioTime !== null && nowSecs >= this._stopAtAudioTime) {
        // Stop time reached — finalise without this quantum (clean boundary)
        this._recording = false;
        this._transferAndComplete();
        return true;
      }

      // Accumulate a copy of this quantum's samples
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this._chunks.push(copy);
      this._sampleCount += channel.length;
    }

    return true;
  }

  /**
   * Assemble all chunks into a single ArrayBuffer and transfer to main thread.
   * Uses Transferable to avoid copying — the chunk data cannot be used here
   * after transfer.
   */
  _transferAndComplete() {
    const totalSamples = this._sampleCount;
    const combined     = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this._chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this._chunks = [];   // release references

    // Transfer the underlying ArrayBuffer (zero-copy)
    this.port.postMessage(
      { type: 'recordingComplete', buffer: combined.buffer, sampleCount: totalSamples },
      [combined.buffer],
    );
  }
}

registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
