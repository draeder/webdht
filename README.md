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
npm install webdht
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
dht.on('peer:connect', (peerId) => {

    -   `hubName` (string)
-   **Options**: AWS-specific configuration
# Start the demo server
│   ├── aws.js            # AWS transport

# WebDHT Mesh Console (Vue 3 + Vite)

Modernized WebDHT frontend built with **Vue 3** and **Vite**, wired to peer-to-peer primitives from:

- [partialmesh](https://github.com/draeder/partialmesh) for WebRTC partial-mesh topology
- [gossip-protocol](https://github.com/draeder/gossip-protocol) for message re-propagation
- [UniWRTC](https://github.com/draeder/UniWRTC) for WebSocket signaling
- [unsea](https://github.com/draeder/unsea) for key generation and message signing

The new console lets you join a session, observe discovered/connected peers, and broadcast signed messages across the mesh.

## Quick start

```bash
npm install
npm run dev
# open http://localhost:5173
```

### TURN server (fixes "ICE failed")

If you see WebRTC errors like "ICE failed" or "Ice connection failed", you likely need a TURN relay (common on symmetric NATs, corporate Wi‑Fi, or some mobile networks).

Provide TURN settings via Vite env vars:

```bash
export VITE_TURN_URL='turn:your-turn-host:3478?transport=udp'
export VITE_TURN_USERNAME='your-username'
export VITE_TURN_CREDENTIAL='your-password'
```

Then restart `npm run dev`.

By default the app points at the public signaling service `wss://signal.peer.ooo`. Update the signaling URL or session ID in the UI before starting the mesh if needed.

## What changed

- Rebuilt as a Vite + Vue 3 SPA (no legacy Express/server demo required).
- Mesh connectivity uses `PartialMesh` (from `partialmesh`) with UniWRTC signaling for discovery.
- Gossip propagation handled by `GossipProtocol` for bounded-hop re-broadcasts.
- Unsea generates an identity keypair and signs/validates each gossip payload.
- UniWRTC is also used directly for a quick signaling “probe” and room listing.

## App flow

1. **Generate keys** — Unsea creates a signing keypair shown in the header badge.
2. **Configure mesh** — Set session ID, signaling server, min/max peers, and gossip hop limit.
3. **Start mesh** — PartialMesh connects to UniWRTC, auto-discovers peers, and becomes ready once `minPeers` are connected.
4. **Broadcast** — Type a message and send; GossipProtocol distributes it to peers and verifies signatures on receipt.
5. **Inspect** — Watch connected/discovered peers, gossip stats, and activity logs in real time.

## Scripts

- `npm run dev` — Vite dev server with HMR
- `npm run build` — Production build
- `npm run preview` — Preview the production build locally

## Notes

- The public signaling host is shared. Use unique session IDs in development to avoid cross-talk.
# WebDHT Mesh Console (Vue 3 + Vite)

Modernized WebDHT frontend built with **Vue 3** and **Vite**, wired to peer-to-peer primitives from:

- [partialmesh](https://github.com/draeder/partialmesh) for WebRTC partial-mesh topology
- [gossip-protocol](https://github.com/draeder/gossip-protocol) for message re-propagation
- [UniWRTC](https://github.com/draeder/UniWRTC) for WebSocket signaling
- [unsea](https://github.com/draeder/unsea) for key generation and message signing

The new console lets you join a session, observe discovered/connected peers, and broadcast signed messages across the mesh.

## Quick start

```bash
npm install
npm run dev
# open http://localhost:5173
```

By default the app points at the public signaling service `wss://signal.peer.ooo`. Update the signaling URL or session ID in the UI before starting the mesh if needed.

## What changed

- Rebuilt as a Vite + Vue 3 SPA (no legacy Express/server demo required).
- Mesh connectivity uses `PartialMesh` (from `partialmesh`) with UniWRTC signaling for discovery.
- Gossip propagation handled by `GossipProtocol` for bounded-hop re-broadcasts.
- Unsea generates an identity keypair and signs/validates each gossip payload.
- UniWRTC is also used directly for a quick signaling “probe” and room listing.

## App flow

1. **Generate keys** — Unsea creates a signing keypair shown in the header badge.
2. **Configure mesh** — Set session ID, signaling server, min/max peers, and gossip hop limit.
3. **Start mesh** — PartialMesh connects to UniWRTC, auto-discovers peers, and becomes ready once `minPeers` are connected.
4. **Broadcast** — Type a message and send; GossipProtocol distributes it to peers and verifies signatures on receipt.
5. **Inspect** — Watch connected/discovered peers, gossip stats, and activity logs in real time.

## Scripts

- `npm run dev` — Vite dev server with HMR
- `npm run build` — Production build
- `npm run preview` — Preview the production build locally

## Notes

- The public signaling host is shared. Use unique session IDs in development to avoid cross-talk.
- The legacy DHT and chess demo code remain in the repository for reference but are not used by the new UI.
- All cryptographic operations (keygen, signing, verification) are handled by Unsea in-browser.

## License

MIT

