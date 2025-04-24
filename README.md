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
