/**
 * Ultra-simple signaling server for WebDHT
 * Core functionality only - no statistics tracking
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use('/', express.static(path.join(__dirname)));
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
app.use('/transports', express.static(path.join(__dirname, '..', 'transports')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const peers = new Map();

wss.on('connection', (ws) => {
  console.log('New connection');
  let peerId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'register' && data.peerId) {
        peerId = data.peerId;
        peers.set(peerId, ws);
        console.log(`Registered: ${peerId}`);

        const peerList = Array.from(peers.keys()).filter(id => id !== peerId);
        ws.send(JSON.stringify({
          type: 'registered',
          peerId: peerId,
          peers: peerList
        }));

        // Notify existing peers
        peers.forEach((existingWs, existingId) => {
          if (existingId !== peerId && existingWs.readyState === 1) {
            existingWs.send(JSON.stringify({
              type: 'new_peer',
              peerId: peerId
            }));
          }
        });
      }
      else if (data.type === 'signal' && data.target && data.signal) {
        const targetWs = peers.get(data.target);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({
            type: 'signal',
            peerId: peerId,
            signal: data.signal
          }));
          console.log('Signal forwarded from', peerId.substring(0, 8), 'to', data.target.substring(0, 8), 'Type:', data.signal.type || 'candidate');
          if (data.signal.sdp) {
            console.log('SDP snippet:', data.signal.sdp.substring(0, 120) + '...');
          }
          if (data.signal.candidate) {
            console.log('ICE candidate:', data.signal.candidate.candidate.substring(0, 80) + '...');
          }
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Target peer not available'
          }));
        }
      }
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (peerId) {
      peers.delete(peerId);
      console.log(`Peer disconnected: ${peerId}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});