# WebDHT

A Kademlia-like Distributed Hash Table (DHT) that works seamlessly in both browser and Node.js environments using WebRTC for peer connections.

## Features

- **Cross-platform compatibility**: Works in both browser and Node.js environments
- **WebRTC peer connections**: Uses simple-peer for WebRTC-based peer-to-peer communication
- **Kademlia DHT implementation**: Efficient distributed key-value storage
- **No external dependencies for core functionality**: Implements its own SHA1 solution
- **Asynchronous API**: Modern Promise-based interface
- **Event-based architecture**: Provides events for signal data, peer connections, etc.

## Implementation Details

WebDHT implements a Kademlia-like Distributed Hash Table with the following components:

- **DHT**: The main DHT implementation with Kademlia routing logic
- **Peer**: Wrapper around simple-peer for WebRTC connections
- **K-Buckets**: Store routing information for Kademlia
- **SHA1**: Custom SHA1 implementation that works in both environments

The DHT class is the main entry point for using the library. It manages the node's ID, routing table (K-Buckets), and peer connections. When a new DHT instance is created, it generates a random node ID using the SHA1 implementation and initializes the K-Buckets.

The Peer class is a wrapper around the simple-peer library, providing a simplified interface for establishing WebRTC connections between nodes. It handles the signaling process and manages the underlying WebRTC connection.

The K-Buckets class implements the Kademlia routing table, storing information about other nodes in the network. It uses the XOR distance metric to determine the proximity of nodes and efficiently routes messages to the closest nodes.

The SHA1 class provides a custom implementation of the SHA1 hashing algorithm that works in both browser and Node.js environments. It is used to generate node IDs and hash keys for the DHT.

## Advanced Usage & Exports

The default export is the DHT class (named `WebDHT` in examples for clarity). For advanced use cases, you can also import:

- `Peer`: The peer connection wrapper
- `utils`: Utility functions (e.g., buffer conversions)
- `sha1`, `generateRandomId`: SHA1 hash and random ID generator
- `bufferToHex`, `hexToBuffer`: Buffer/hex conversion helpers

Example:

```javascript
import WebDHT, { Peer, utils, sha1, generateRandomId, bufferToHex, hexToBuffer } from 'webdht';
```

The `Peer` class can be used directly to establish WebRTC connections between nodes without using the full DHT implementation. This can be useful for building custom peer-to-peer applications or integrating WebDHT with other libraries.

The `utils` module provides utility functions for working with buffers and converting between different data formats. These functions can be used to manipulate data before storing it in the DHT or after retrieving it.

The `sha1` and `generateRandomId` functions can be used to generate SHA1 hashes and random IDs, respectively. These can be useful for creating custom node IDs or hashing keys for the DHT.

The `bufferToHex` and `hexToBuffer` functions provide helpers for converting between buffers and hexadecimal strings. These can be useful for working with data in different formats or for debugging purposes.

## API.js Usage

The `api.js` file provides a consolidated API for WebDHT operations, peer discovery, and signaling. It handles both browser and Node.js environments. The key functions are:

1. **initializeApi(dht, adapter)**: Initializes the API manager with a DHT instance and UI adapter. It sets up event listeners for signal events, peer connections, and disconnections.

2. **connectSignaling(url, options)**: Connects to the signaling server using a WebSocket URL. It handles registration, new peer notifications, and signal forwarding.

3. **connectPeer(peerId, forceInitiator, additionalOptions)**: Initiates a connection to a peer. It uses lexicographical comparison to determine who initiates the connection and sets up event listeners for the peer.

4. **putValue(key, value)**: Stores a value in the DHT.

5. **getValue(key)**: Retrieves a value from the DHT.

6. **startDiscovery(initialDelay)**: Starts the peer discovery process with an initial delay.

7. **connectToPeer(peerId)**: Connects to a peer using the DHT instance.

8. **sendMessageToPeer(peerId, messageText)**: Sends a message to a connected peer.

9. **startDhtPeerDiscovery()**: Starts the DHT peer discovery process.

10. **stopDhtPeerDiscovery()**: Stops the DHT peer discovery process.

Example usage:

```javascript
import { initializeApi, connectSignaling, connectPeer, putValue, getValue, startDiscovery, connectToPeer, sendMessageToPeer, startDhtPeerDiscovery, stopDhtPeerDiscovery } from 'webdht/api';

// Initialize the API
const dht = new WebDHT();
const adapter = {
  updateStatus: (message, isError = false) => console.log(isError ? `ERROR: ${message}` : `Status: ${message}`),
  updatePeerList: (peerIds) => console.log("Available peers:", peerIds),
  addMessage: (peerId, message, isOutgoing) => console.log(`Message ${isOutgoing ? 'to' : 'from'} ${peerId.substring(0,8)}: ${message}`),
  getWebSocket: (url) => new WebSocket(url) // Browser default
};
initializeApi(dht, adapter);

// Connect to the signaling server
connectSignaling('wss://signaling.example.com');

// Connect to a peer
connectPeer('peer-id-123');

// Store a value in the DHT
putValue('my-key', 'my-value');

// Retrieve a value from the DHT
getValue('my-key').then(value => console.log('Retrieved value:', value));

// Start peer discovery
startDiscovery();

// Connect to a peer using the DHT instance
connectToPeer('peer-id-456');

// Send a message to a connected peer
sendMessageToPeer('peer-id-789', 'Hello, peer!');

// Start DHT peer discovery
startDhtPeerDiscovery();

// Stop DHT peer discovery
stopDhtPeerDiscovery();
```

## Installation

```bash
npm install webdht
```

## Basic Usage

### Browser

```javascript
import WebDHT from 'webdht';

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
import WebDHT from 'webdht';

// Create a new DHT node
const dht = new WebDHT();

// Listen for when the DHT is ready
dht.on('ready', (nodeId) => {
  console.log('My Node ID:', nodeId);
  
  // Store a value
  dht.put('myKey', 'myValue')
    .then(success => console.log('Store success:', success))
    .catch(err => console.error('Store error:', err));
});

// Handle peer connections
dht.on('peer:connect', (peerId) => {
  console.log('Connected to peer:', peerId);
});
```

# WebDHT API Reference

## WebDHT Class

### Constructor
```js
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
> Note: both node and browser peer instances can connect to each other.

#### Browser Example

```bash
# Start the example server
node server.js

# Then open http://localhost:3000 in your browser in multiple tabs
```

#### Node.js Example

```bash
# Start the example server
node server.js
# Then run the Node.js example
node example/node.js
## Auto-connect peers
node example/node.js --autoconnect
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
