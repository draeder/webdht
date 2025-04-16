/**
 * WebDHT Node.js Signaling Client Example
 * 
 * This example demonstrates how to use WebDHT with a signaling server
 * in a Node.js environment to establish WebRTC connections between peers.
 * 
 * Usage: node signaling-node-client.js
 */

import DHT from '../src/index.js';
import { io } from 'socket.io-client';
import readline from 'readline';

// Set up readline interface for command input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Connect to signaling server
const SIGNALING_SERVER = 'http://localhost:3001';
console.log(`Connecting to signaling server at ${SIGNALING_SERVER}...`);
const socket = io(SIGNALING_SERVER);

// Initialize DHT and variables
let dht;
let nodeId;
const peers = new Set();

// Handle socket.io connection
socket.on('connect', () => {
  console.log('Connected to signaling server');
  initializeDHT();
});

socket.on('disconnect', () => {
  console.log('Disconnected from signaling server');
});

// Socket.io event handlers for signaling
socket.on('signal', (data) => {
  const { id, signal } = data;
  console.log(`Received signal from peer: ${id.substring(0, 8)}..., type: ${signal?.type || 'unknown'}`);
  console.log(`Signal data: ${JSON.stringify(signal).substring(0, 50)}...`);
  
  // Always try to establish a connection when we receive a signal
  if (dht && id !== nodeId) {
    try {
      // Try to establish the connection first
      if (!peers.has(id)) {
        console.log(`Auto-connecting to peer sending signals: ${id.substring(0, 8)}...`);
        dht.connect(id);
      }
      
      // Then process the signal
      dht.signal({
        id: id,
        signal: signal
      });
    } catch (err) {
      console.error('Error handling peer signal:', err.message);
    }
  } else {
    console.log(`Cannot process signal - DHT not initialized or signal from self`);
  }
});

socket.on('peer-joined', (peerId) => {
  console.log(`New peer joined the network: ${peerId.substring(0, 8)}...`);
  // Automatically connect to new peers
  if (dht && peerId !== nodeId) {
    console.log(`Auto-connecting to new peer: ${peerId.substring(0, 8)}...`);
    try {
      const peer = dht.connect(peerId);
      console.log(`Connection to new peer initiated: ${peer ? 'success' : 'failed'}`);
      if (peer) peers.add(peerId);
    } catch (err) {
      console.error(`Error connecting to new peer ${peerId.substring(0, 8)}...:`, err.message);
    }
  }
});

socket.on('peer-left', (peerId) => {
  console.log(`Peer left the network: ${peerId.substring(0, 8)}...`);
  peers.delete(peerId);
});

socket.on('peers-list', (peersList) => {
  console.log(`Received list of ${peersList.length} existing peers`);
  
  if (dht && peersList.length > 0) {
    // Attempt to connect to each peer automatically
    peersList.forEach(peerId => {
      // Avoid connecting to self
      if (peerId !== nodeId) {
        console.log(`- Found peer: ${peerId.substring(0, 8)}... - Attempting auto-connection`);
        peers.add(peerId);
        
        try {
          const peer = dht.connect(peerId);
          console.log(`Connection attempt initiated: ${peer ? 'success' : 'failed'}`);
        } catch (err) {
          console.error(`Error connecting to peer ${peerId.substring(0, 8)}...:`, err.message);
        }
      }
    });
  }
});

// Initialize the DHT
async function initializeDHT() {
  try {
    console.log('Creating DHT node...');
    dht = new DHT();
    
    // Set up DHT event listeners
    dht.on('ready', (id) => {
      nodeId = id;
      console.log(`DHT node ready with ID: ${nodeId}`);
      
      // Register with the signaling server
      socket.emit('register', nodeId);
      
      // Set up DHT event handlers
      setupDHTEvents();
      
      // Start command line interface
      startCommandInterface();
    });
  } catch (error) {
    console.error(`Error initializing DHT: ${error.message}`);
    process.exit(1);
  }
}

function setupDHTEvents() {
  // Handle DHT signal events
  dht.on('signal', (signalData) => {
    console.log(`DHT generated signal data for peer: ${signalData.targetNodeId?.substring(0, 8) || 'unknown'}...`);
    
    // Ensure the signal has the correct format for the signaling server
    socket.emit('signal', {
      targetNodeId: signalData.targetNodeId,
      signal: signalData.signal
    });
  });
  
  // Handle DHT peer connection events
  dht.on('peer:connect', (peerId) => {
    console.log(`Connected to peer: ${peerId}`);
    peers.add(peerId);
  });
  
  dht.on('peer:disconnect', (peerId) => {
    console.log(`Disconnected from peer: ${peerId}`);
    peers.delete(peerId);
  });
  
  dht.on('error', (error) => {
    console.error(`DHT error: ${error.message}`);
  });
}

function startCommandInterface() {
  console.log('\nWebDHT Node.js Signaling Client');
  console.log('-------------------------------');
  console.log('Available commands:');
  console.log('  connect <peerId>   - Connect to a specific peer by ID');
  console.log('  put <key> <value>  - Store a value in the DHT');
  console.log('  get <key>          - Retrieve a value from the DHT');
  console.log('  peers              - List connected peers');
  console.log('  signal             - Generate and display your signal data for manual sharing');
  console.log('  exit               - Exit the application');
  console.log('');
  
  promptCommand();
}

function promptCommand() {
  rl.question('> ', async (input) => {
    const args = input.trim().split(' ');
    const command = args[0].toLowerCase();
    
    try {
      switch (command) {
        case 'connect':
          if (!args[1]) {
            console.log('Usage: connect <peerId>');
            break;
          }
          console.log(`Attempting to connect to peer: ${args[1]}`);
          // Initiate connection through signaling server
          dht.connect(args[1]);
          break;
          
        case 'put':
          if (!args[1] || !args[2]) {
            console.log('Usage: put <key> <value>');
            break;
          }
          console.log(`Storing key: ${args[1]}, value: ${args.slice(2).join(' ')}`);
          const putResult = await dht.put(args[1], args.slice(2).join(' '));
          console.log(`Store result: ${putResult ? 'Success' : 'Failed'}`);
          break;
          
        case 'get':
          if (!args[1]) {
            console.log('Usage: get <key>');
            break;
          }
          console.log(`Retrieving key: ${args[1]}`);
          const value = await dht.get(args[1]);
          console.log(`Retrieved value: ${value || 'Not found'}`);
          break;
          
        case 'peers':
          if (peers.size === 0) {
            console.log('No peers connected');
          } else {
            console.log(`Connected peers (${peers.size}):`);
            peers.forEach(peerId => {
              console.log(`- ${peerId}`);
            });
          }
          break;
          
        case 'signal':
          console.log('Your DHT Node ID (for manual connections):');
          console.log(nodeId);
          console.log('\nShare your Node ID with other peers for them to connect to you.');
          break;
          
        case 'exit':
          console.log('Closing connections and exiting...');
          socket.disconnect();
          dht.close();
          rl.close();
          process.exit(0);
          break;
          
        default:
          if (command !== '') {
            console.log(`Unknown command: ${command}`);
            console.log('Type "help" for available commands');
          }
      }
    } catch (error) {
      console.error(`Error executing command: ${error.message}`);
    }
    
    promptCommand();
  });
}

// Handle initiate-connection event
socket.on('initiate-connection', (targetPeerId) => {
  console.log(`Received connection request for peer: ${targetPeerId.substring(0, 8)}...`);
  if (dht && targetPeerId !== nodeId) {
    try {
      const peer = dht.connect(targetPeerId);
      console.log(`Connection initiated via server request: ${peer ? 'success' : 'failed'}`);
      if (peer) peers.add(targetPeerId);
    } catch (err) {
      console.error(`Error connecting to peer ${targetPeerId.substring(0, 8)}...:`, err.message);
    }
  }
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nClosing connections and exiting...');
  socket.disconnect();
  if (dht) dht.close();
  process.exit(0);
});
