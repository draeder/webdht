/**
 * Simple signaling server for WebDHT browser tests
 * 
 * This server provides a mechanism for WebDHT peers to discover each other
 * and exchange WebRTC signaling data in browser environments.
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create Express app
const app = express();
const server = http.createServer(app);
const PORT = 8080;

// In-memory storage for signaling data and peer tracking
const signalStore = new Map();
const activePeers = new Map(); // Changed to Map to store peer objects with timestamps

// Clean up inactive peers periodically (peers inactive for more than 30 seconds)
setInterval(() => {
  const inactiveCutoff = Date.now() - 30000;
  const peersToRemove = [];
  
  activePeers.forEach(peer => {
    if (peer.lastSeen < inactiveCutoff) {
      peersToRemove.push(peer.id);
    }
  });
  
  peersToRemove.forEach(peerId => {
    activePeers.delete(peerId);
    console.log(`Removing inactive peer: ${peerId.substr(0, 8)}...`);
  });
}, 10000);

// Serve static files from the test directory
app.use(express.static(__dirname));
// Serve the parent directory too (for accessing src files)
app.use(express.static(path.join(__dirname, '..')));
// Parse JSON requests
app.use(express.json());

// Endpoints for signaling
app.post('/signal', (req, res) => {
  const { fromId, toId, signal } = req.body;
  
  if (!fromId || !toId || !signal) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  console.log(`Signaling from ${fromId.substr(0, 8)}... to ${toId.substr(0, 8)}...`);
  
  // Update peer activity timestamp
  activePeers.set(fromId, { id: fromId, lastSeen: Date.now() });
  
  // Store the signal for the recipient to retrieve
  if (!signalStore.has(toId)) {
    signalStore.set(toId, []);
  }
  
  signalStore.get(toId).push({
    fromId, 
    signal
  });
  
  return res.json({ success: true });
});

app.get('/signals/:peerId', (req, res) => {
  const peerId = req.params.peerId;
  
  // Update peer activity timestamp
  activePeers.set(peerId, { id: peerId, lastSeen: Date.now() });
  
  if (!signalStore.has(peerId)) {
    return res.json({ signals: [] });
  }
  
  const signals = signalStore.get(peerId);
  // Clear the signals after retrieving them
  signalStore.set(peerId, []);
  
  return res.json({ signals });
});

// New endpoint for peer registration
app.post('/register-peer', (req, res) => {
  const { peerId } = req.body;
  
  if (!peerId) {
    return res.status(400).json({ error: 'Missing peer ID' });
  }
  
  console.log(`Registering peer: ${peerId.substr(0, 8)}...`);
  activePeers.set(peerId, { id: peerId, lastSeen: Date.now() });
  
  return res.json({ success: true });
});

// New endpoint to get active peers
app.get('/active-peers', (req, res) => {
  const peerIds = Array.from(activePeers.keys());
  console.log(`Returning ${peerIds.length} active peers`);
  return res.json({ peers: peerIds });
});

// Endpoint to initiate cross-peer connections
app.post('/initiate-connection', (req, res) => {
  const { fromId, toId } = req.body;
  
  if (!fromId || !toId) {
    return res.status(400).json({ error: 'Missing peer IDs' });
  }
  
  console.log(`Initiating connection from ${fromId.substr(0, 8)}... to ${toId.substr(0, 8)}...`);
  
  // Instead of directly connecting peers, we tell the target peer to initiate a connection
  // This way we attempt connections from both sides, increasing success rates
  if (!signalStore.has(toId)) {
    signalStore.set(toId, []);
  }
  
  signalStore.get(toId).push({
    fromId,
    signal: {
      type: 'connection-request',
      initiateConnection: true
    }
  });
  
  return res.json({ success: true });
});

// Serve the browser test HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'browser-test.html'));
});

// Start the server
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
  console.log(`Open multiple browser tabs/windows with this URL to test WebDHT peers`);
});
