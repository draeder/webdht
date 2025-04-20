/**
 * WebDHT demo server with signaling functionality
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bodyParser from 'body-parser';

// ES modules fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Use JSON body parser
app.use(bodyParser.json());

// Serve static files from the project directory
app.use(express.static(__dirname));

// Signaling server storage
const activePeers = new Set(); // Store active peer IDs
const signals = new Map(); // Map of peer ID to array of pending signals

// Redirect root to example directory
app.get('/', (req, res) => {
  res.redirect('/example');
});

// Serve the example app
app.get('/example', (req, res) => {
  res.sendFile(join(__dirname, 'example/index.html'));
});

// SIGNALING SERVER ENDPOINTS

// Register a peer
app.post('/register-peer', (req, res) => {
  const { peerId } = req.body;
  
  if (!peerId) {
    return res.status(400).json({ success: false, error: 'No peer ID provided' });
  }
  
  // Add to active peers
  activePeers.add(peerId);
  console.log(`Peer registered: ${peerId.substring(0, 8)}... (Total: ${activePeers.size})`);
  
  // Initialize signal queue for this peer if it doesn't exist
  if (!signals.has(peerId)) {
    signals.set(peerId, []);
  }
  
  res.json({ success: true });
});

// Post a signal to another peer
app.post('/signal', (req, res) => {
  const { from, to, data } = req.body;
  
  if (!from || !to || !data) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields (from, to, data)' 
    });
  }
  
  // Initialize signal queue for recipient if it doesn't exist
  if (!signals.has(to)) {
    signals.set(to, []);
  }
  
  // Add signal to recipient's queue
  signals.get(to).push({ from, data });
  console.log(`Signal from ${from.substring(0, 8)} to ${to.substring(0, 8)} queued`);
  
  res.json({ success: true });
});

// Check for signals
app.get('/check-signals', (req, res) => {
  const { peerId } = req.query;
  
  if (!peerId) {
    return res.status(400).json({ success: false, error: 'No peer ID provided' });
  }
  
  // Get signals for this peer
  const peerSignals = signals.get(peerId) || [];
  
  // Clear signals after sending
  if (peerSignals.length > 0) {
    signals.set(peerId, []);
    console.log(`Sent ${peerSignals.length} signals to ${peerId.substring(0, 8)}`);
  }
  
  res.json({ success: true, signals: peerSignals });
});

// Get list of active peers
app.get('/active-peers', (req, res) => {
  res.json({ success: true, peers: Array.from(activePeers) });
});

// Deregister a peer
app.post('/deregister-peer', (req, res) => {
  const { peerId } = req.body;
  
  if (!peerId) {
    return res.status(400).json({ success: false, error: 'No peer ID provided' });
  }
  
  // Remove from active peers
  activePeers.delete(peerId);
  signals.delete(peerId);
  console.log(`Peer deregistered: ${peerId.substring(0, 8)}... (Total: ${activePeers.size})`);
  
  res.json({ success: true });
});

// Start the server
app.listen(PORT, () => {
  console.log(`WebDHT server running at http://localhost:${PORT}`);
  console.log(`Signaling server active at http://localhost:${PORT}`);
  console.log(`Debug page available at http://localhost:${PORT}/test/debug.html`);
});
