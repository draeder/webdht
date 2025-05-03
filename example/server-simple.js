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
        
        // Check if this peer ID is already registered
        const isDuplicate = peers.has(peerId);
        
        // Update the WebSocket connection for this peer ID
        peers.set(peerId, ws);
        
        if (isDuplicate) {
          console.log(`Registered: ${peerId} (reconnection)`);
        } else {
          console.log(`Registered: ${peerId}`);
        }

        // Get list of other peers (XOR distance calculation moved to transport files)
        const peerList = Array.from(peers.keys())
          .filter(id => id !== peerId);
        
        ws.send(JSON.stringify({
          type: 'registered',
          peerId: peerId,
          peers: peerList
        }));

        // Only notify other peers if this is a new registration, not a reconnection
        if (!isDuplicate) {
          // Notify all peers about the new peer (filtering by XOR distance moved to transport files)
          Array.from(peers.entries())
            .filter(([existingId, _]) => existingId !== peerId)
            .forEach(([id, ws]) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type: 'new_peer',
                  peerId: peerId
                }));
                console.log(`Notified peer ${id.substring(0, 8)} about new peer ${peerId.substring(0, 8)}`);
              }
            });
        }
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