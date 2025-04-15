/**
 * Node.js example for WebDHT
 * 
 * This example shows how to use WebDHT in a Node.js environment.
 * Run multiple instances of this file to create a network of nodes.
 */

// Use the local import path for WebDHT
import WebDHT from '../src/index.js';
// Use Node.js built-in readline module
import readline from 'readline';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Create a new DHT node with a random ID
const dht = new WebDHT();

// Display welcome message
console.log('WebDHT Node.js Example');
console.log('-----------------------');

// Wait for DHT to be ready
dht.on('ready', (nodeId) => {
  console.log('Node ID:', nodeId);
  console.log('');
  console.log('Available commands:');
  console.log('  signal <peerInfo>   - Connect to a peer using signal data');
  console.log('  put <key> <value>   - Store a value in the DHT');
  console.log('  get <key>           - Retrieve a value from the DHT');
  console.log('  peers               - List connected peers');
  console.log('  exit                - Exit the application');
  console.log('');
  
  // Start the prompt once DHT is ready
  promptUser();
});

// Handle signal events
dht.on('signal', peerSignal => {
  console.log('\nSignal data generated for peer:', peerSignal.id.substr(0, 8) + '...');
  console.log('Share this with the peer to establish a connection:');
  console.log(JSON.stringify(peerSignal));
  promptUser();
});

// Handle peer connections
dht.on('peer:connect', peerId => {
  console.log('\nConnected to peer:', peerId.substr(0, 16) + '...');
  promptUser();
});

// Handle peer disconnections
dht.on('peer:disconnect', peerId => {
  console.log('\nDisconnected from peer:', peerId.substr(0, 16) + '...');
  promptUser();
});

// Handle peer errors
dht.on('peer:error', ({ peer, error }) => {
  console.log('\nError with peer:', peer.substr(0, 16) + '...', '-', error);
  promptUser();
});

// Process user input
function processCommand(input) {
  const parts = input.trim().split(' ');
  const command = parts[0].toLowerCase();
  
  switch (command) {
    case 'signal':
      try {
        const peerInfo = JSON.parse(parts.slice(1).join(' '));
        console.log('Connecting to peer:', peerInfo.id.substr(0, 8) + '...');
        dht.signal(peerInfo);
      } catch (err) {
        console.log('Invalid peer info:', err.message);
      }
      break;
      
    case 'put':
      if (parts.length < 3) {
        console.log('Usage: put <key> <value>');
        break;
      }
      
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      
      console.log('Storing value...');
      dht.put(key, value)
        .then(success => {
          console.log(success ? 
            'Value stored successfully for key: ' + key : 
            'Failed to store value for key: ' + key);
        })
        .catch(err => {
          console.log('Error:', err.message);
        });
      break;
      
    case 'get':
      if (parts.length < 2) {
        console.log('Usage: get <key>');
        break;
      }
      
      const getKey = parts[1];
      
      console.log('Retrieving value...');
      dht.get(getKey)
        .then(value => {
          console.log(value !== null ? 
            'Retrieved value: ' + value : 
            'Value not found for key: ' + getKey);
        })
        .catch(err => {
          console.log('Error:', err.message);
        });
      break;
      
    case 'peers':
      console.log('\nConnected Peers:');
      if (dht.peers.size === 0) {
        console.log('No connected peers');
      } else {
        dht.peers.forEach((peer, peerId) => {
          console.log(`- ${peerId.substr(0, 32)}... (${peer.connected ? 'connected' : 'disconnected'})`);
        });
      }
      break;
      
    case 'exit':
      console.log('Closing DHT and exiting...');
      dht.close();
      rl.close();
      process.exit(0);
      break;
      
    default:
      console.log('Unknown command:', command);
      console.log('Available commands: signal, put, get, peers, exit');
  }
  
  promptUser();
}

// Prompt for user input
function promptUser() {
  rl.question('\n> ', processCommand);
}

// Prompt will be started when DHT is ready
