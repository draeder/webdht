/**
 * Simplified DHT Client Example
 * This example demonstrates using the simplified DHT implementation
 */

const SimplifiedDHT = require('../src/simplified-dht');
const io = require('socket.io-client');
const { Buffer } = require('buffer');

// Create a simplified DHT node with debug logging enabled
const dht = new SimplifiedDHT({
  debug: true
});

// Connect to signaling server
const socket = io('http://localhost:3001');

// Track connected peers
const connectedPeers = new Map();

console.log('Connecting to signaling server...');

socket.on('connect', () => {
  console.log('Connected to signaling server');
  
  // Register with DHT node ID
  socket.emit('register', { nodeId: dht.nodeId });
  
  console.log(`DHT node ready with ID: ${dht.nodeId}`);
});

// Receive list of existing peers
socket.on('peers', (peers) => {
  console.log(`Received list of ${peers.length} peers`);
  
  // Connect to each peer
  peers.forEach(peer => {
    if (peer.nodeId !== dht.nodeId) {
      console.log(`Connecting to existing peer: ${peer.nodeId.substring(0, 8)}...`);
      socket.emit('connect-peer', { targetId: peer.nodeId });
    }
  });
});

// Handle connection request from another peer
socket.on('connect-peer', (data) => {
  const peerId = data.peerId;
  console.log(`Received connection request from: ${peerId.substring(0, 8)}...`);
  
  // Create a simple peer object for the DHT
  const peer = {
    send: (message) => {
      try {
        // Send the message via the signaling socket
        socket.emit('relay', {
          targetId: peerId,
          data: message
        });
        return true;
      } catch (err) {
        console.error(`Error sending message to ${peerId.substring(0, 8)}...`, err);
        return false;
      }
    },
    connected: true
  };
  
  // Add the peer to our DHT
  dht.addPeer(peerId, peer);
  
  // Track the connection
  connectedPeers.set(peerId, peer);
  
  console.log(`Connected to peer: ${peerId.substring(0, 8)}...`);
});

// Handle relayed messages from peers
socket.on('relay', (data) => {
  const senderId = data.senderId;
  const message = data.data;
  
  console.log(`Received relayed message from ${senderId.substring(0, 8)}...`);
  
  // Process the message in our DHT
  dht.handleMessage(message, senderId);
});

// Simple CLI interface
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n==== DHT Commands ====');
console.log('put <key> <value> - Store a value in the DHT');
console.log('get <key> - Retrieve a value from the DHT');
console.log('peers - List connected peers');
console.log('exit - Exit the application');

rl.on('line', async (input) => {
  const parts = input.trim().split(' ');
  const command = parts[0].toLowerCase();
  
  try {
    if (command === 'put') {
      if (parts.length < 3) {
        console.log('Usage: put <key> <value>');
        return;
      }
      
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      
      console.log(`Storing key "${key}" with value "${value}"...`);
      await dht.put(key, value);
      console.log('Value stored successfully');
    }
    else if (command === 'get') {
      if (parts.length < 2) {
        console.log('Usage: get <key>');
        return;
      }
      
      const key = parts[1];
      console.log(`Retrieving key "${key}"...`);
      
      const result = await dht.get(key);
      if (result !== null) {
        console.log(`Retrieved value: "${result}"`);
      } else {
        console.log('Key not found');
      }
    }
    else if (command === 'peers') {
      console.log(`Connected to ${connectedPeers.size} peers:`);
      for (const [peerId, peer] of connectedPeers.entries()) {
        console.log(`- ${peerId.substring(0, 8)}...`);
      }
    }
    else if (command === 'exit') {
      console.log('Closing connections...');
      dht.close();
      socket.disconnect();
      rl.close();
      process.exit(0);
    }
    else {
      console.log('Unknown command');
    }
  } catch (err) {
    console.error('Error executing command:', err.message);
  }
});
