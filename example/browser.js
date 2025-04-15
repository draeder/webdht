/**
 * Browser example for WebDHT
 * 
 * This example shows how to use WebDHT in a browser environment.
 * For this to work, you would need a signaling server to exchange WebRTC signals.
 */

// Import WebDHT and the SHA1 functionality
import WebDHT from '/src/index.js';
import { generateRandomId } from '/src/sha1.js';

// Initialize the application
async function initApp() {
  try {
    // Create a WebDHT instance
    const dht = new WebDHT();
    
    // Set up the UI and event listeners once DHT is ready
    dht.on('ready', (nodeId) => {
      document.getElementById('peerId').textContent = nodeId;
      document.getElementById('status').textContent = 'DHT node created with SHA1 ID';
      
      // Set up the UI with the DHT instance
      setupUI(dht);
      console.log('Your peer ID is:', nodeId);
    });
    
    return dht;
  } catch (err) {
    console.error('Error initializing WebDHT:', err);
    document.getElementById('status').textContent = `Error: ${err.message}`;
  }
}

// Set up the UI and event handlers
function setupUI(dht) {
  // DOM Elements
  const statusEl = document.getElementById('status');
  const peerIdEl = document.getElementById('peerId');
  const connectForm = document.getElementById('connectForm');
  const peerInfoEl = document.getElementById('peerInfo');
  const storeForm = document.getElementById('storeForm');
  const retrieveForm = document.getElementById('retrieveForm');
  const resultEl = document.getElementById('result');
  const peersEl = document.getElementById('peers');
  
  // Set up connected peers tracking
  const connectedPeers = new Set();
  
  // Handle signal events
  dht.on('signal', peerSignal => {
    statusEl.textContent = 'Generated signal data for peer: ' + peerSignal.id.substr(0, 8) + '...';
    // In a real application, you would send this to a signaling server
    console.log('Signal data for peer:', peerSignal);
    
    // For demo purposes, you could copy this to clipboard or display it
    peerInfoEl.value = JSON.stringify(peerSignal);
  });
  
  // Handle peer connections
  dht.on('peer:connect', peerId => {
    statusEl.textContent = 'Connected to peer: ' + peerId.substr(0, 8) + '...';
    connectedPeers.add(peerId);
    updatePeersList();
  });
  
  // Handle peer disconnections
  dht.on('peer:disconnect', peerId => {
    statusEl.textContent = 'Disconnected from peer: ' + peerId.substr(0, 8) + '...';
    connectedPeers.delete(peerId);
    updatePeersList();
  });
  
  // Handle peer errors
  dht.on('peer:error', ({ peer, error }) => {
    statusEl.textContent = 'Error with peer: ' + peer.substr(0, 8) + '... - ' + error;
  });
  
  // Connect to a peer
  connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    
    try {
      const peerInfo = JSON.parse(peerInfoEl.value);
      dht.signal(peerInfo);
      statusEl.textContent = 'Connecting to peer: ' + peerInfo.id.substr(0, 8) + '...';
    } catch (err) {
      statusEl.textContent = 'Invalid peer info: ' + err.message;
    }
  });
  
  // Store a value
  storeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    
    const key = document.getElementById('storeKey').value;
    const value = document.getElementById('storeValue').value;
    
    if (!key || !value) {
      resultEl.textContent = 'Key and value are required';
      return;
    }
    
    statusEl.textContent = 'Storing value...';
    
    try {
      const success = await dht.put(key, value);
      resultEl.textContent = success ? 
        'Value stored successfully' : 
        'Failed to store value';
      statusEl.textContent = success ? 
        'Value stored successfully for key: ' + key : 
        'Failed to store value for key: ' + key;
    } catch (err) {
      resultEl.textContent = 'Error: ' + err.message;
      statusEl.textContent = 'Error: ' + err.message;
    }
  });
  
  // Retrieve a value
  retrieveForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    
    const key = document.getElementById('retrieveKey').value;
    
    if (!key) {
      resultEl.textContent = 'Key is required';
      return;
    }
    
    statusEl.textContent = 'Retrieving value...';
    
    try {
      const value = await dht.get(key);
      resultEl.textContent = value !== null ? 
        'Retrieved value: ' + value : 
        'Value not found';
      statusEl.textContent = value !== null ? 
        'Retrieved value for key: ' + key : 
        'Value not found for key: ' + key;
    } catch (err) {
      resultEl.textContent = 'Error: ' + err.message;
      statusEl.textContent = 'Error: ' + err.message;
    }
  });
  
  // Update the list of connected peers
  function updatePeersList() {
    peersEl.innerHTML = '';
    
    if (connectedPeers.size === 0) {
      peersEl.textContent = 'No connected peers';
      return;
    }
    
    for (const peerId of connectedPeers) {
      const peerEl = document.createElement('div');
      peerEl.textContent = peerId.substr(0, 16) + '...';
      peersEl.appendChild(peerEl);
    }
  }
}

// Show SHA1 performance demonstration
async function demonstrateSHA1() {
  const resultEl = document.getElementById('result');
  resultEl.innerHTML = '';
  
  try {
    // Generate multiple peer IDs to demonstrate SHA1 performance
    const peers = [];
    const startTime = performance.now();
    
    // Generate 5 peer IDs in sequence
    for (let i = 0; i < 5; i++) {
      const id = await generateRandomId();
      peers.push(id);
      
      // Display each generated ID
      const peerEl = document.createElement('div');
      peerEl.textContent = `Peer ${i+1}: ${id.substring(0, 8)}...${id.substring(id.length - 8)}`;
      resultEl.appendChild(peerEl);
    }
    
    const endTime = performance.now();
    const timeEl = document.createElement('div');
    timeEl.style.marginTop = '10px';
    timeEl.textContent = `Generated 5 SHA1 peer IDs in ${(endTime - startTime).toFixed(2)}ms`;
    resultEl.appendChild(timeEl);
    
  } catch (err) {
    resultEl.textContent = `Error in SHA1 demo: ${err.message}`;
  }
}

// Start initialization when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('status').textContent = 'Initializing WebDHT...';
  let dht = initApp();
  
  // If demo button exists, add event listener
  const demoButton = document.getElementById('demoButton');
  if (demoButton) {
    demoButton.addEventListener('click', demonstrateSHA1);
  }
});

