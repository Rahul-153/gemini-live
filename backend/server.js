import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import * as fs from 'node:fs';
import pkg from 'wavefile';
const { WaveFile } = pkg;

import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/genai-audio' });

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.send('GenAI Audio Streaming Backend is running.');
});

// Model and config as in the sample
const model = "gemini-2.0-flash-live-001";
const config = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: "You are a helpful assistant and answer in a friendly tone."
};

wss.on('connection', async (ws) => {
  console.log('WebSocket client connected');
  let session = null;
  let closed = false;
  const responseQueue = [];

  // Helper to wait for a message from the queue
  async function waitMessage() {
    let done = false;
    let message = undefined;
    while (!done) {
      message = responseQueue.shift();
      if (message) {
        done = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return message;
  }

  // Helper to collect all turns for a request
  async function handleTurn() {
    const turns = [];
    let done = false;
    while (!done) {
      const message = await waitMessage();
      turns.push(message);
      // Forward each message to the client as soon as it arrives
      if (message.data) {
        ws.send(JSON.stringify({ type: 'audio', data: message.data }));
      }
      if (message.serverContent && message.serverContent.turnComplete) {
        done = true;
      }
    }
    return turns;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    session = await ai.live.connect({
      model: model,
      callbacks: {
        onopen: function () {
          ws.send(JSON.stringify({ type: 'status', message: 'Session opened' }));
        },
        onmessage: function (message) {
          console.log("Received message from Gemini:", message);
          responseQueue.push(message);
        },
        onerror: function (e) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        },
        onclose: function (e) {
          ws.send(JSON.stringify({ type: 'status', message: 'Session closed: ' + e.reason }));
        },
      },
      config: config,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
    return;
  }

  ws.on('message', async (data) => {
    // Expecting base64-encoded WAV audio from client
    try {
      const wavBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Optionally save for debugging
      // fs.writeFileSync('debug_chunk.wav', wavBuffer);

      // Ensure audio is 16kHz, 16-bit, mono
      const wav = new WaveFile();
      wav.fromBuffer(wavBuffer);
      wav.toSampleRate(16000);
      wav.toBitDepth("16");
      // wav.toChannels(1);
      const base64Audio = wav.toBase64();

      // Debug: Log WAV properties and base64 preview
      console.log('--- Debug Session Start ---');
      console.log('Received WAV properties:', {
        sampleRate: wav.fmt.sampleRate,
        bitDepth: wav.fmt.bitsPerSample,
        numChannels: wav.fmt.numChannels,
        container: wav.container
      });
      console.log('Base64 audio preview:', base64Audio.slice(0, 30));
      console.log('Sending audio to Gemini...');

      // Send to Gemini API
      session.sendRealtimeInput({
        audio: {
          data: base64Audio,
          mimeType: "audio/pcm;rate=16000"
        }
      });

      // Wait for and forward all turns for this input
      const turns = await handleTurn();
      console.log('Received response from Gemini:', turns.length, 'turn(s)');
      console.log('--- Debug Session End ---');

    } catch (e) {
      console.error('Error in audio debug session:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    closed = true;
    if (session) session.close();
    console.log('WebSocket client disconnected');
  });
});

const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`GenAI Audio Streaming Backend listening on port ${PORT}`);
});
