import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import { WaveFile } from 'wavefile';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isAIGenerating, setIsAIGenerating] = useState(false);

  // Refs for audio context and nodes
  const inputAudioContextRef = useRef(null);
  const outputAudioContextRef = useRef(null);
  const inputNodeRef = useRef(null);
  const outputNodeRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const scriptProcessorNodeRef = useRef(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef(new Set());
  const wsRef = useRef(null);
  const isRecordingRef = useRef(false); // Additional ref for real-time recording state
  const currentTurnIdRef = useRef(null);
  const lastInterruptTimeRef = useRef(0);

  // Helper to create a new AudioContext
  const createInputAudioContext = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    inputNodeRef.current = ctx.createGain();
    inputAudioContextRef.current = ctx;
    return ctx;
  };

  const createOutputAudioContext = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    outputNodeRef.current = ctx.createGain();
    outputNodeRef.current.connect(ctx.destination);
    outputAudioContextRef.current = ctx;
    return ctx;
  };

  // Initialize audio contexts (create new if closed or null)
  const initAudio = () => {
    if (!inputAudioContextRef.current || inputAudioContextRef.current.state === 'closed') {
      createInputAudioContext();
    }
    if (!outputAudioContextRef.current || outputAudioContextRef.current.state === 'closed') {
      createOutputAudioContext();
    }
    nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
  };

  // Helper to decode base64 to ArrayBuffer
  function base64ToArrayBuffer(base64String) {
    try {
      // 1. Validate input
      if (typeof base64String !== 'string' || base64String.length === 0) {
        throw new Error('Invalid base64 string input');
      }

      // 2. Clean and prepare base64
      const cleanBase64 = base64String
        .replace(/^data:[^;]+;base64,/, '')
        .replace(/\s+/g, '');

      // 3. Calculate and add padding if needed
      // const padLength = (4 - (cleanBase64.length % 4)) % 4;
      // const paddedBase64 = cleanBase64 + '='.repeat(padLength);

      // 4. Convert to binary string
      const binaryString = atob(cleanBase64);

      // 5. Create NEW ArrayBuffer in one step (critical fix)
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 6. Return the buffer (bytes.buffer is guaranteed fresh)
      return bytes.buffer;
    } catch (error) {
      console.error('Conversion failed:', {
        error: error.message,
        inputSample: base64String?.slice(0, 30),
        inputLength: base64String?.length
      });
      throw new Error(`Audio conversion failed: ${error.message}`);
    }
  }

  // Helper to play audio buffer
  const playAudioBuffer = async (audioBuffer, turnId = null) => {
    // Don't play audio from interrupted turns
    if (turnId && turnId !== currentTurnIdRef.current) {
      console.log(`Skipping audio from interrupted turn: ${turnId}`);
      return;
    }

    console.log("will play", audioBuffer)
    const source = outputAudioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outputNodeRef.current);
    
    source.onended = () => {
      sourcesRef.current.delete(source);
    };
    
    // CHANGE: Improved timing management for interruptions
    const now = outputAudioContextRef.current.currentTime;
    const startTime = Math.max(nextStartTimeRef.current, now + 0.01); // Small buffer to prevent timing issues
    
    try {
      source.start(startTime);
      nextStartTimeRef.current = startTime + audioBuffer.duration;
      sourcesRef.current.add(source);
    } catch (error) {
      console.error('Error starting audio source:', error);
    }
  };

  // Helper to decode PCM audio (assume 24kHz mono float32 PCM or WAV)
  async function decodeAudioData(arrayBuffer) {
    try {
      // Gemini Live API returns raw 16-bit little-endian PCM at 24kHz
      const view = new DataView(arrayBuffer);
      // 16-bit = 2 bytes per sample
      const sampleCount = arrayBuffer.byteLength / 2;
      const float32Array = new Float32Array(sampleCount);
  
      // Convert 16-bit PCM to Float32 with proper scaling
      for (let i = 0; i < sampleCount; i++) {
        const int16Sample = view.getInt16(i * 2, true); // little-endian
        // Convert to float32 range [-1, 1] with proper scaling
        float32Array[i] = int16Sample / (int16Sample < 0 ? 32768 : 32767);
      }
  
      // Create AudioBuffer with Gemini's native sample rate (24kHz)
      const audioBuffer = outputAudioContextRef.current.createBuffer(
        1,         // mono channel
        sampleCount, // length in samples
        24000      // Gemini's output sample rate
      );
  
      audioBuffer.copyToChannel(float32Array, 0);
      return audioBuffer;
  
    } catch (error) {
      console.error('Audio decode failed:', error);
      throw new Error('Audio decode failed: ' + error.message);
    }
  }
  const handleInterruption = (turnId, timestamp) => {
    const now = Date.now();
    
    // Prevent duplicate interruption handling
    if (now - lastInterruptTimeRef.current < 100) {
      return;
    }
    lastInterruptTimeRef.current = now;

    console.log(`Handling interruption for turn ${turnId} at ${timestamp}`);
    
    // Stop all active audio sources immediately
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (error) {
        console.log('Source already stopped or invalid:', error);
      }
    });
    sourcesRef.current.clear();
    
    // CHANGE: Proper timing reset - use current time, not 0
    nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
    
    // Reset generation state
    setIsAIGenerating(false);
    currentTurnIdRef.current = null;
    
    console.log('Interruption handled: Playback stopped and timing reset.');
  };

  // WebSocket connection logic
  const connectWebSocket = () => {
    const ws = new window.WebSocket(
      window.location.protocol === 'https:'
        ? 'wss://' + window.location.host + '/api/genai-audio'
        : 'ws://' + window.location.hostname + ':5050/api/genai-audio'
    );
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      setStatus('WebSocket connected.');
    };
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          setStatus(msg.message);
        } else if (msg.type === 'error') {
          setError(msg.message);
        // CHANGE: Enhanced interruption handling with turn tracking
        } else if (msg.type === 'interrupt') {
          handleInterruption(msg.turnId, msg.timestamp);
        // CHANGE: Added generation start tracking
        } else if (msg.type === 'generation_start') {
          setIsAIGenerating(true);
          currentTurnIdRef.current = msg.turnId;
          console.log(`AI generation started for turn: ${msg.turnId}`);
        } else if (msg.type === 'audio' && msg.data) {
          const arrayBuffer = base64ToArrayBuffer(msg.data);
          console.log("decoding", arrayBuffer)
          const audioBuffer = await decodeAudioData(arrayBuffer);
          console.log("will play")
          // CHANGE: Pass current turn ID to playback function
          playAudioBuffer(audioBuffer, currentTurnIdRef.current);
        }
      } catch (err) {
        setError('Error handling message: ' + err.message);
      }
    };
    ws.onerror = (e) => {
      setError('WebSocket error');
    };
    ws.onclose = () => {
      setStatus('WebSocket closed.');
    };
    wsRef.current = ws;
  };

  const closeWebSocket = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

const startRecording = async () => {
  if (isRecordingRef.current) return;
  
  initAudio();
  await inputAudioContextRef.current.resume();
  setStatus('Requesting microphone access...');
  
  try {
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    mediaStreamRef.current = mediaStream;
    setStatus('Microphone access granted. Starting capture...');
    
    connectWebSocket();
    
    const sourceNode = inputAudioContextRef.current.createMediaStreamSource(mediaStream);
    sourceNodeRef.current = sourceNode;
    sourceNode.connect(inputNodeRef.current);
    
    const bufferSize = 256;
    const scriptProcessorNode = inputAudioContextRef.current.createScriptProcessor(bufferSize, 1, 1);
    
    scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
      if (!isRecordingRef.current) return;
      
      const inputBuffer = audioProcessingEvent.inputBuffer;
      const pcmData = inputBuffer.getChannelData(0); // Float32Array (-1 to 1)
      
      // Convert to 16-bit PCM properly
      const int16Array = new Int16Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        // Scale from [-1, 1] to [-32768, 32767]
        int16Array[i] = Math.max(-32768, Math.min(32767, Math.floor(pcmData[i] * 32767)));
      }
      
      // Send raw PCM buffer directly (lower latency than WAV)
      try {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(int16Array.buffer);
        }
      } catch (err) {
        console.error('Error sending PCM:', err);
      }
    };
    
    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(inputAudioContextRef.current.destination);
    scriptProcessorNodeRef.current = scriptProcessorNode;
    
    // Update both state and ref
    setIsRecording(true);
    isRecordingRef.current = true;
    setStatus('🔴 Recording... Capturing PCM chunks.');
    
  } catch (err) {
    setError(`Error: ${err.message}`);
    setStatus('Error starting recording');
    stopRecording();
  }
};

  const stopRecording = () => {
    setStatus('Stopping recording...');
    setIsRecording(false);
    isRecordingRef.current = false;
    
    if (scriptProcessorNodeRef.current && sourceNodeRef.current && inputAudioContextRef.current) {
      scriptProcessorNodeRef.current.disconnect();
      sourceNodeRef.current.disconnect();
    }
    scriptProcessorNodeRef.current = null;
    sourceNodeRef.current = null;
    
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (error) {
        console.log('Source already stopped:', error);
      }
    });
    sourcesRef.current.clear();
    
    closeWebSocket();
    
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    setStatus('Recording stopped. Click Start to begin again.');
  };

  const reset = () => {
    stopRecording();
    setStatus('Session cleared.');
  };

  // Cleanup on unmount
  useEffect(() => {
    initAudio();
    return () => {
      stopRecording();
      if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
        inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
      }
      if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close();
        outputAudioContextRef.current = null;
      }
      closeWebSocket();
    };
  }, []);

  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: '#222', color: '#fff' }}>
      <div className="controls" style={{ position: 'absolute', bottom: '10vh', left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, zIndex: 10 }}>
        <button
          id="resetButton"
          onClick={reset}
          disabled={isRecording}
          style={{ outline: 'none', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: 12, background: 'rgba(255,255,255,0.1)', width: 64, height: 64, cursor: 'pointer', fontSize: 24, padding: 0, margin: 0 }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" height="40px" viewBox="0 -960 960 960" width="40px" fill="#ffffff">
            <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
          </svg>
        </button>
        <button
          id="startButton"
          onClick={startRecording}
          disabled={isRecording}
          style={{ outline: 'none', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: 12, background: 'rgba(255,255,255,0.1)', width: 64, height: 64, cursor: 'pointer', fontSize: 24, padding: 0, margin: 0 }}
        >
          <svg viewBox="0 0 100 100" width="32px" height="32px" fill="#c80000" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="50" />
          </svg>
        </button>
        <button
          id="stopButton"
          onClick={stopRecording}
          disabled={!isRecording}
          style={{ outline: 'none', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: 12, background: 'rgba(255,255,255,0.1)', width: 64, height: 64, cursor: 'pointer', fontSize: 24, padding: 0, margin: 0 }}
        >
          <svg viewBox="0 0 100 100" width="32px" height="32px" fill="#000000" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="100" height="100" rx="15" />
          </svg>
        </button>
      </div>
      <div id="status" style={{ position: 'absolute', bottom: '5vh', left: 0, right: 0, zIndex: 10, textAlign: 'center' }}>{error || status}</div>
    </div>
  );
}

export default App;