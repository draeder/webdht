import WebDHT from '../src/index.js';
import WebSocket from 'ws';
import readline from 'readline';

let signalingSocket = null;
let dht = null;

// CLI setup
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function printCommands() {
  console.log(`
==============================
  WebDHT Node CLI Commands
==============================
connect <peerId>   - Connect to a peer
put <key> <value>  - Store a value in DHT
get <key>          - Retrieve a value from DHT
dump               - Dump DHT contents
peers              - List connected peers
exit               - Quit the app
==============================
`);
}

// Initialize DHT
async function init() {
  dht = new WebDHT();

  dht.on('ready', (nodeId) => {
    console.log(`🟢 DHT ready. Your peer ID: ${nodeId}`);
    printCommands();
    connectToSignalingServer(dht, nodeId);
    setupDHTEventListeners(dht);
    promptCLI();
  });

  dht.on('error', (err) => {
    console.error('❌ DHT Error:', err);
  });
}

// Connect to signaling server
function connectToSignalingServer(dht, nodeId) {
  signalingSocket = new WebSocket('ws://localhost:3000');

  signalingSocket.on('open', () => {
    console.log('🔌 Connected to signaling server');
    signalingSocket.send(JSON.stringify({
      type: 'register',
      peerId: nodeId
    }));
  });

  signalingSocket.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'registered') {
        console.log(`🆔 Registered as ${data.peerId}`);
        if (data.peers.length) {
          console.log(`🌐 Available peers: ${data.peers.join(', ')}`);
        } else {
          console.log('🌐 No other peers available yet.');
        }
      }

      if (data.type === 'new_peer') {
        console.log(`➕ New peer joined: ${data.peerId}`);
      }

      if (data.type === 'peer_left') {
        console.log(`➖ Peer left: ${data.peerId}`);
      }

      if (data.type === 'signal' && data.peerId && data.signal) {
        console.log(`📩 Signal received from ${data.peerId}`);

        const peer = dht.signal({ id: data.peerId, signal: data.signal });

        if (peer && typeof peer.on === 'function') {
          attachPeerEvents(peer, data.peerId);
        }
      }

      if (data.type === 'error') {
        console.error(`❌ Server error: ${data.message}`);
      }
    } catch (err) {
      console.error('❌ Failed to process server message:', err);
    }
  });

  signalingSocket.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });

  signalingSocket.on('close', () => {
    console.log('⚠️ Disconnected from signaling server');
  });

  // DHT to signaling server: outgoing signals
  dht.on('signal', (data) => {
    if (signalingSocket?.readyState === WebSocket.OPEN) {
      if (data && data.id && data.signal) {
        console.log(`📤 Sending signal to ${data.id}`);
        signalingSocket.send(JSON.stringify({
          type: 'signal',
          target: data.id,
          signal: data.signal
        }));
      }
    }
  });
}

// Attach peer events (used for both connect and signal)
function attachPeerEvents(peer, peerId) {
  peer.on('connect', () => {
    console.log(`🟢 Connected to ${peerId}`);
    peer.send(`Hello from ${dht.nodeId}`);
  });

  peer.on('data', (data) => {
    console.log(`📨 Message from ${peerId}:`, data.toString());
  });

  peer.on('error', (err) => {
    console.error(`❌ Peer ${peerId} error:`, err);
  });

  peer.on('close', () => {
    console.log(`🔌 Peer ${peerId} connection closed.`);
  });
}

// DHT-level peer tracking
function setupDHTEventListeners(dht) {
  dht.on('peer:connect', (peerId) => {
    console.log(`✅ DHT reports connected to peer: ${peerId}`);
  });

  dht.on('peer:disconnect', (peerId) => {
    console.log(`❌ DHT reports disconnected from peer: ${peerId}`);
  });

  dht.on('peer:error', (peerId, err) => {
    console.error(`❌ DHT error with peer ${peerId}:`, err);
  });
}

// CLI REPL
function promptCLI() {
  rl.question('> ', async (input) => {
    const args = input.trim().split(/\s+/);
    const cmd = args[0];

    switch (cmd) {
      case 'connect':
        if (!args[1]) {
          console.log('Usage: connect <peerId>');
        } else {
          try {
            const peerId = args[1];
            console.log(`📞 Connecting to ${peerId}...`);
            const peer = await dht.connect({ id: peerId });
            attachPeerEvents(peer, peerId);
          } catch (err) {
            console.error(`❌ Connection to ${args[1]} failed:`, err.message);
          }
        }
        break;

      case 'put':
        if (args.length < 3) {
          console.log('Usage: put <key> <value>');
        } else {
          try {
            await dht.put(args[1], args.slice(2).join(' '));
            console.log('📝 Value stored successfully.');
          } catch (err) {
            console.error('❌ Failed to store value:', err);
          }
        }
        break;

      case 'get':
        if (!args[1]) {
          console.log('Usage: get <key>');
        } else {
          try {
            const value = await dht.get(args[1]);
            console.log('📦 Retrieved value:', value);
          } catch (err) {
            console.error('❌ Failed to retrieve value:', err);
          }
        }
        break;

      case 'peers':
        console.log('Connected peers:', [...dht.peers.keys()]);
        break;

      case 'dump':
        console.log('DHT Storage Contents:');
        dht.storage.forEach((value, key) => {
          console.log(`Key: ${key} => Value: ${value}`);
        });
        break;

      case 'exit':
        rl.close();
        signalingSocket?.close();
        process.exit(0);
        break;

      default:
        console.log(`Unknown command: ${cmd}`);
        printCommands();
    }

    promptCLI();
  });
}

init();
