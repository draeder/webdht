# WebDHT

A Kademlia-like Distributed Hash Table (DHT) that works seamlessly in both browser and Node.js environments using WebRTC for peer connections.

## Features

- **Cross-platform compatibility**: Works in both browser and Node.js environments
- **WebRTC peer connections**: Uses simple-peer for WebRTC-based peer-to-peer communication
- **Kademlia DHT implementation**: Efficient distributed key-value storage
- **No external dependencies for core functionality**: Implements its own SHA1 solution
- **Asynchronous API**: Modern Promise-based interface
- **Event-based architecture**: Provides events for signal data, peer connections, etc.

## Installation

```bash
npm install @draeder/webdht
```

## Basic Usage

### Browser

```javascript
import WebDHT from '@draeder/webdht';

// Create a new DHT node
const dht = new WebDHT();

// Listen for when the DHT is ready
dht.on('ready', (nodeId) => {
  console.log('My Node ID:', nodeId);
});

// Handle signal events (to establish WebRTC connections)
dht.on('signal', (peerSignal) => {
  console.log('Signal data to share:', peerSignal);
  // Send this signal data to another peer via your signaling channel
});

// Connect to another peer using their signal data
dht.signal(peerSignalData);

// Store a value in the DHT
await dht.put('myKey', 'myValue');

// Retrieve a value from the DHT
const value = await dht.get('myKey');
```

### Node.js

```javascript
import WebDHT from '@draeder/webdht';

// Create a new DHT node
// WebDHT automatically detects Node.js environment and uses @koush/wrtc
const dht = new WebDHT();

// Listen for when the DHT is ready
dht.on('ready', (nodeId) => {
  console.log('My Node ID:', nodeId);
  
  // Get signal data for sharing with other peers
  dht.on('signal', (signalData) => {
    console.log('Share this signal data with another peer:', JSON.stringify(signalData));
    // This signal data can be shared through any channel (API, WebSocket, etc.)
  });
  
  // Connect to another peer using their signal data
  // This could be received through any external channel
  function connectToPeer(peerSignalData) {
    dht.signal(peerSignalData);
  }
  
  // Once connected to peers, store and retrieve data
  dht.put('myKey', 'myValue')
    .then(success => console.log('Store success:', success))
    .catch(err => console.error('Store error:', err));
});

// Handle peer connections
dht.on('peer:connect', (peerId) => {
  console.log('Connected to peer:', peerId);
  
  // Now you can get values from the DHT network
  dht.get('someKey')
    .then(value => console.log('Retrieved value:', value))
    .catch(err => console.error('Retrieval error:', err));
});
```

## API Reference

### WebDHT Class

#### Constructor

```javascript
const dht = new WebDHT(options);
```

**Options:**
- `nodeId` (optional): Specify a custom node ID (otherwise generated using SHA1)
- `bootstrap` (optional): Array of bootstrap nodes to connect to

#### Methods

- **`signal(peerInfo)`**: Signal a peer with WebRTC connection data
- **`connect(peerInfo)`**: Connect to a peer
- **`put(key, value)`**: Store a value in the DHT
- **`get(key)`**: Retrieve a value from the DHT
- **`findNode(targetId)`**: Find nodes close to the target ID
- **`close()`**: Close all connections and clean up resources

#### Events

- **`ready`**: Emitted when the DHT node is initialized (with node ID)
- **`signal`**: Emitted when signal data is generated for a peer
- **`peer:connect`**: Emitted when a peer connection is established
- **`peer:disconnect`**: Emitted when a peer disconnects
- **`peer:error`**: Emitted when a peer connection has an error

## Examples

See the `example` directory for complete usage examples:

- `browser.js`: Browser implementation example
- `node.js`: Node.js command-line interface example

### Running Examples

#### Browser Example

```bash
# Start the example server
node server.js

# Then open http://localhost:3000 in your browser
```

#### Node.js Example

```bash
node example/node.js
```

## Signaling Server Example

WebRTC requires a signaling mechanism to exchange connection information between peers. Here's a simple signaling server example using Express and Socket.io:

```javascript
// signaling-server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files
app.use(express.static('public'));

// Store connected peers
const peers = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Register the peer with its DHT nodeId
  socket.on('register', (nodeId) => {
    console.log(`Peer ${socket.id} registered with DHT nodeId: ${nodeId}`);
    peers.set(nodeId, socket.id);
    socket.nodeId = nodeId;
    
    // Let everyone know about the new peer
    socket.broadcast.emit('peer-joined', nodeId);
    
    // Send list of existing peers to the new peer
    const existingPeers = [];
    peers.forEach((_, peerId) => {
      if (peerId !== nodeId) existingPeers.push(peerId);
    });
    socket.emit('peers-list', existingPeers);
  });
  
  // Handle WebRTC signaling
  socket.on('signal', ({ targetNodeId, signalData }) => {
    const targetSocketId = peers.get(targetNodeId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', {
        fromNodeId: socket.nodeId,
        signalData
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.nodeId) {
      console.log(`Peer ${socket.id} (DHT ${socket.nodeId}) disconnected`);
      peers.delete(socket.nodeId);
      io.emit('peer-left', socket.nodeId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
```

### Using the Signaling Server

```javascript
// In your WebDHT application
import WebDHT from '@draeder/webdht';
import io from 'socket.io-client';

// Connect to signaling server
const socket = io('http://localhost:3000');
const dht = new WebDHT();

dht.on('ready', (nodeId) => {
  console.log('My DHT Node ID:', nodeId);
  
  // Register with the signaling server
  socket.emit('register', nodeId);
  
  // Handle incoming signals from other peers
  socket.on('signal', ({ fromNodeId, signalData }) => {
    console.log(`Received signal from ${fromNodeId}`);
    dht.signal(signalData);
  });
  
  // Get notified about new peers
  socket.on('peers-list', (peersList) => {
    console.log('Available peers:', peersList);
    // Optionally connect to some or all peers
  });
  
  // Forward DHT signals to the target peer via signaling server
  dht.on('signal', (signalData) => {
    if (signalData.targetNodeId) {
      socket.emit('signal', {
        targetNodeId: signalData.targetNodeId,
        signalData
      });
    }
  });
});
```

## Node.js Peer Discovery and WebRTC Implementation

WebDHT provides a seamless experience for Node.js developers by automatically handling the WebRTC implementation details:

### Automatic WebRTC Detection

In Node.js environments, WebDHT automatically:

1. Detects that it's running in Node.js
2. Dynamically imports and configures the `@koush/wrtc` package
3. Sets up SimplePeer with the appropriate WebRTC implementation

This means you don't need to manually configure WebRTC in your Node.js applications - WebDHT handles it for you transparently.

### Practical Peer Discovery Pattern

To discover and connect peers in a Node.js application:

1. **Exchange Signal Data**: Use any external channel (API, WebSocket server, etc.) to exchange WebRTC signal data between nodes

   ```javascript
   // Node A: Generate and share signal data
   dht.on('signal', (signalData) => {
     // Send this data to Node B through your chosen channel
     sendToPeer(JSON.stringify(signalData));
   });
   
   // Node B: Receive and use signal data
   receiveFromPeer((signalDataStr) => {
     dht.signal(JSON.parse(signalDataStr));
   });
   ```

2. **Establish Direct Connection**: Once signal data is exchanged, WebDHT establishes a direct WebRTC connection between peers

3. **Use the DHT**: After connection, use the DHT functions (put/get) as normal

With this approach, you can build fully decentralized applications that work across browsers and Node.js environments.

## Implementation Details

WebDHT implements a Kademlia-like Distributed Hash Table with the following components:

- **DHT**: The main DHT implementation with Kademlia routing logic
- **Peer**: Wrapper around simple-peer for WebRTC connections
- **K-Buckets**: Store routing information for Kademlia
- **SHA1**: Custom SHA1 implementation that works in both environments

## License

This project is licensed under the MIT License - see the LICENSE file for details.
