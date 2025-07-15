# WebDHT

A Kademlia-inspired Distributed Hash Table that runs in both browser and Node.js environments, using WebRTC for peer-to-peer communication with built-in chess game demonstration.

## Features

-   **Cross-Platform**: Seamlessly runs in browsers and Node.js.
-   **WebRTC Signaling**: Uses `simple-peer` for peer connections over WebRTC.
-   **Kademlia Routing**: Efficient key-value lookups and storage via K-buckets.
-   **Built-in SHA1**: SHA1 implementation included—no external dependencies.
-   **Promise-Based API**: All methods return Promises for easy async/await usage.
-   **Event-Driven**: Emits events for lifecycle and signaling hooks.
-   **Interactive Chess Game**: Full multiplayer chess implementation using DHT for matchmaking and game state.
-   **Multiple Transport Support**: WebSocket, Azure, AWS, GCP, and PubNub transports for signaling.
-   **Comprehensive Demo Interface**: Web interface with Network, DHT Storage, Chess, and Tools tabs.
-   **HTTPS Support**: Secure development server with SSL certificates included.

## Live Demo

The included web interface demonstrates:

- **Network Tab**: Peer discovery, connection management, and messaging
- **DHT Storage Tab**: Store and retrieve key-value data across the network
- **Chess Tab**: Full multiplayer chess with DHT-based matchmaking and real-time gameplay
- **Tools Tab**: SHA1 utilities and development tools

## Installation

```bash
npm install @draeder/webdht
```

## Quick Start

### Start the Demo Server

```bash
npm start
# Opens on http://localhost:3001 and https://localhost:3443
```

### Browser Usage

```javascript
import WebDHT from '@draeder/webdht';

// Create node
const dht = new WebDHT();

// When ready
dht.on('ready', (nodeId) => {
  console.log('Node ID:', nodeId);
});

// Send out signal data
dht.on('signal', (signalData) => {
  // Relay this to another peer
});

// Connect using received signal
dht.signal(remoteSignal);

// Store and retrieve data
await dht.put('myKey', 'myValue');
const value = await dht.get('myKey');
```

### Node.js Usage

```javascript
import WebDHT from '@draeder/webdht';

const dht = new WebDHT();

dht.on('ready', async (nodeId) => {
  console.log('Node ID:', nodeId);
  const success = await dht.put('myKey', 'myValue');
  console.log('Put success:', success);
});

dht.on('peer:connect', (peerId) => {
  console.log('Connected to:', peerId);
});
```

## API Reference

### WebDHT Class

#### Constructor

`new WebDHT(options?)`

-   `options.nodeId` (string): Hex string to override generated node ID.
-   `options.bootstrap` (Array<string>): List of bootstrap node signal payloads.

#### Methods

| Method     | Signature                                 | Description                                     |
| :--------- | :---------------------------------------- | :---------------------------------------------- |
| `signal`   | `signal(peerSignal: any): void`           | Pass a peer’s signal data into the instance.    |
| `connect`  | `connect(peerInfo: any): Promise<void>`   | Establish peer connection using stored peer info. |
| `put`      | `put(key: string, value: any): Promise<boolean>` | Store `value` at `key` in the DHT.             |
| `get`      | `get(key: string): Promise<any>`          | Retrieve the value stored at `key`.             |
| `findNode` | `findNode(targetId: string): Promise<string[]>` | Find nodes closest to `targetId`.               |
| `close`    | `close(): Promise<void>`                  | Close all connections and clean up resources.   |

#### Events

| Event             | Payload         | Description                                      |
| :---------------- | :-------------- | :----------------------------------------------- |
| `ready`           | `nodeId: string`  | Emitted when the node is initialized.            |
| `signal`          | `signalData: any` | Emitted with WebRTC signal data to send to a peer. |
| `peer:connect`    | `peerId: string`  | Emitted when a peer connection is established.   |
| `peer:disconnect` | `peerId: string`  | Emitted when a peer disconnects.                 |
| `peer:error`      | `error: Error`    | Emitted on a peer connection error.              |

### API Helpers

WebDHT includes helper functions in `src/api.js` for easier integration:

| Function | Description |
| :------- | :---------- |
| `initializeApi(dht, adapter?, debug?)` | Initialize API layer with DHT instance |
| `connectSignaling(config)` | Connect to signaling server |
| `putValue(key, value)` | Store data with logging |
| `getValue(key)` | Retrieve data with logging |
| `disconnectSignaling()` | Close signaling connection |
| `setDebug(enabled)` | Enable/disable debug logging |

**Example:**
```javascript
import WebDHT, { initializeApi, connectSignaling, putValue, getValue } from 'webdht';

const dht = new WebDHT();
initializeApi(dht, null, true); // Enable debug logging

await connectSignaling({
  type: 'websocket',
  url: 'wss://your-signaling-server.com'
});

// Use the DHT
dht.on('ready', async (nodeId) => {
  await putValue('myKey', 'myValue');
  const value = await getValue('myKey');
  console.log('Retrieved:', value);
});
```

### Quick Start Example

```javascript
import WebDHT, { initializeApi, connectSignaling, putValue, getValue } from 'webdht';

// Create and initialize DHT
const dht = new WebDHT();
initializeApi(dht, null, true); // Enable debug logging

// Connect to signaling server
await connectSignaling({
  type: 'websocket',
  url: 'wss://your-signaling-server.com'
});

// Listen for DHT ready event
dht.on('ready', async (nodeId) => {
  console.log('DHT ready, Node ID:', nodeId);
  
  // Store and retrieve data
  await putValue('greeting', 'Hello DHT!');
  const value = await getValue('greeting');
  console.log('Retrieved:', value);
});

// Handle peer events
dht.on('peer:connect', (peerId) => {
  console.log('Connected to peer:', peerId);
});
```


## Transports

WebDHT supports multiple transport mechanisms for signaling and establishing peer connections:

### WebSocketTransport

-   **Type**: `websocket`
-   **Usage**: Default signaling via WebSocket server (primary method)
-   **Options**:
    -   `url` (string): WebSocket server URL

### AzureTransport

-   **Type**: `azure`
-   **Usage**: Signaling via Azure Web PubSub or SignalR Service
-   **Options**:
    -   `connectionString` (string)
    -   `hubName` (string)

### AWSTransport

-   **Type**: `aws`
-   **Usage**: Signaling via AWS services
-   **Options**: AWS-specific configuration

### GCPTransport  

-   **Type**: `gcp`
-   **Usage**: Signaling via Google Cloud Platform services
-   **Options**: GCP-specific configuration

### PubNubTransport

-   **Type**: `pubnub`
-   **Usage**: Signaling via PubNub real-time messaging
-   **Options**: PubNub-specific configuration

You can also create custom transports by adhering to the transport interface expected by WebDHT.

## Chess Game Demo

The chess implementation demonstrates advanced DHT usage:

### Features
- **DHT-Based Matchmaking**: Players find opponents through distributed matchmaking
- **Real-time Gameplay**: Moves synchronized via gossip protocol with DHT fallback
- **Game State Persistence**: Complete game state stored in DHT
- **Reconnection Support**: Games survive network interruptions
- **Draw Offers & Resignation**: Full game action support

### Game Architecture
- **Matchmaking**: Uses shared DHT key for peer discovery
- **Move Synchronization**: Gossip protocol for real-time moves, DHT polling for reliability
- **State Management**: Game state stored under unique game IDs
- **Conflict Resolution**: Deterministic game setup prevents race conditions

### Usage
1. Navigate to the Chess tab in the demo interface
2. Click "Find Game" to enter matchmaking
3. Play chess when matched with another player
4. Games support draw offers, resignation, and rematch requests

## Development & Examples

### Demo Server

The included server provides both HTTP and HTTPS endpoints:

```bash
npm start
# HTTP: http://localhost:3001
# HTTPS: https://localhost:3443 (with included SSL certificates)
```

### Example Files

-   **`example/index.html`** — Interactive web interface with full DHT and chess demo
-   **`example/server.js`** — HTTPS-enabled signaling server with WebSocket support
-   **`example/browser.js`** — Browser-specific DHT implementation
-   **`example/node.js`** — Node.js CLI example
-   **`example/chess-module.js`** — Complete multiplayer chess implementation
-   **`example/game/`** — Chess engine and styling assets

### Running Examples

```bash
# Start the demo server
npm start

# Access the web interface
# Browser: visit http://localhost:3001 or https://localhost:3443
# Features: Network status, DHT operations, multiplayer chess, tools

# Run Node.js CLI example
node example/node.js --autoconnect
```

## Project Structure

```
webdht/
├── src/                    # Core DHT implementation
│   ├── index.js           # Main WebDHT class
│   ├── dht.js             # Kademlia DHT logic
│   ├── peer.js            # Peer connection management
│   └── ...
├── transports/            # Transport implementations
│   ├── websocket.js       # WebSocket transport (default)
│   ├── azure.js          # Azure transport
│   ├── aws.js            # AWS transport
│   ├── gcp.js            # GCP transport
│   └── pubnub.js         # PubNub transport
├── example/               # Demo and examples
│   ├── index.html        # Interactive web demo
│   ├── server.js         # HTTPS signaling server
│   ├── chess-module.js   # Multiplayer chess
│   └── game/            # Chess assets
└── README.md             # This file
```

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
