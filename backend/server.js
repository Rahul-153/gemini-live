import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality,StartSensitivity, EndSensitivity, ActivityHandling } from '@google/genai';
import express from 'express';
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
const model = "gemini-2.5-flash-preview-native-audio-dialog";
const config = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: `You are Rev, the helpful voice assistant for Revolt Motors, an Indian electric motorcycle company.
Your sole purpose is to provide information and answer questions exclusively about Revolt Motors, including its electric bikes (like RV1, RV400), features, pricing, dealerships, charging, bookings, test rides, and company news. Always respond in a friendly, concise, and natural manner. If a user’s query is not related to Revolt Motors, politely redirect them back to relevant topics or say: “I’m here to help with Revolt Motors queries. What would you like to know about our electric motorcycles?” Do not discuss or provide information on any other topics, brands, or unrelated subjects.
Examples of Responses
Here are some examples of how you should respond to user queries:
	•	User: What are the key features of the RV400?Rev: The RV400 comes with a powerful electric motor, up to 150 km range, multiple riding modes, and smart connectivity via our app for tracking and diagnostics. It’s designed for urban commuting with style and efficiency. Anything specific you’d like to know?
	•	User: How much does the RV1 cost in India?Rev: The RV1 starts at an affordable price point, making it a great entry-level electric commuter. For the latest pricing and offers, I recommend checking our official website or contacting a dealership. Where are you located?
	•	User: Can you tell me about the latest iPhone?Rev: I’m here to help with Revolt Motors queries. What would you like to know about our electric motorcycles, like the RV400 or RV1?
	•	User: How do I book a test ride for a Revolt bike?Rev: Booking a test ride is easy! Visit our website, select your preferred model and location, and schedule it online. We have dealerships across major cities. Let me know your city, and I can guide you further.`,
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false, // default
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_MEDIUM,
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_MEDIUM,
      prefixPaddingMs: 20,
      silenceDurationMs: 100, // Options: LOW, MEDIUM, HIGH - tune based on testing
    },
    activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
  },
};

wss.on('connection', async (ws) => {
  console.log('WebSocket client connected');
  let session = null;
  let closed = false;
  const responseQueue = []
  let isGenerating = false;
  let currentTurnId = null;

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
      if (message.data && !message.serverContent?.interrupted) {
        ws.send(JSON.stringify({ type: 'audio',  data: message.data }));
      }
      
      // CHANGE: Check for generation complete and turn complete separately
      if (message.serverContent?.generationComplete) {
        isGenerating = false;
      }
      if (message.serverContent && message.serverContent.turnComplete) {
        done = true;
        isGenerating = false;
        currentTurnId = null;
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
          if (message.serverContent?.interrupted) {
            console.log("Interruption detected - stopping current generation");
            isGenerating = false;
            ws.send(JSON.stringify({ 
              type: 'interrupt', 
              turnId: currentTurnId,
              timestamp: Date.now()
            }));
          }
          
          // CHANGE: Track generation state for better interruption handling
          if (message.serverContent?.modelTurn) {
            if (!isGenerating) {
              isGenerating = true;
              currentTurnId = Date.now().toString();
              ws.send(JSON.stringify({ 
                type: 'generation_start', 
                turnId: currentTurnId 
              }));
            }
          }
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
    // Now expecting raw 16-bit PCM audio buffer from client (not WAV)
    try {
      // data is a Buffer containing raw PCM (16-bit, mono, 16kHz)
      // Directly base64-encode the buffer for Gemini
      const base64Audio = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');

      // Debug: Log PCM properties and base64 preview
      console.log('--- Debug Session Start ---');
      console.log('Received PCM buffer length:', data.length);
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