# WebDHT

A Kademlia-inspired Distributed Hash Table that runs in both browser and Node.js environments, using WebRTC for peer-to-peer communication.

## Features

-   **Cross-Platform**: Seamlessly runs in browsers and Node.js.
-   **WebRTC Signaling**: Uses `simple-peer` for peer connections over WebRTC.
-   **Kademlia Routing**: Efficient key-value lookups and storage via K-buckets.
-   **Built-in SHA1**: SHA1 implementation included—no external dependencies.
-   **Promise-Based API**: All methods return Promises for easy async/await usage.
-   **Event-Driven**: Emits events for lifecycle and signaling hooks.
-   **Pluggable Transports**: WebDHT supports multiple transport mechanisms for signaling and establishing peer connections. While you can implement custom transports, it comes with built-in support for several common methods.

    -   **WebSocket Transport (Default Signaling)**: This is the primary and default mechanism for signaling in WebDHT. Peers connect to a WebSocket server to exchange WebRTC handshake messages (offers, answers, ICE candidates). 
        -   **Usage**: Typically, you provide the WebSocket server URL in the `WebDHT` constructor options (e.g., `new WebDHT({ transport: [{ type: 'ws', url: 'wss://your-signaling-server.com' }] })`). If no transport is specified, WebDHT might attempt to use a default public signaling server if configured to do so, or it will rely on manual signaling via the `signal` event and `dht.signal()` method.
        -   It's crucial for establishing initial peer connections before direct WebRTC communication takes over.

    -   **Azure Transport**: Provides an alternative signaling mechanism using Azure services. This is less commonly used as a default and is more for specific cloud-based deployments.

    -   **Other Default Transports**: (If any other defaults are present or implied by the library's behavior, they would be listed here. For now, WebSocket is the main default for signaling.)

    You can also create and use your own custom transports by adhering to the transport interface expected by WebDHT.

## Installation

```bash
npm install webdht
```

## Quick Start

### Browser

```javascript
import WebDHT from 'webdht';

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

### Node.js

```javascript
import WebDHT from 'webdht';

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

### API Helpers (from `src/api.js`)

| Function                 | Signature                                       | Description                                                                          |
| :----------------------- | :---------------------------------------------- | :----------------------------------------------------------------------------------- |
| `initializeApi`          | `initializeApi(dht, adapter, debug?)`           | Link a DHT instance to a UI adapter for status updates and debug logging.            |
| `connectSignaling`       | `connectSignaling({ type, url, ... }): Promise<void>` | Establish connection to a signaling server via the specified transport.              |
| `putValue`               | `putValue(key, value): Promise<boolean>`        | Shortcut for `dht.put` with added logging.                                         |
| `getValue`               | `getValue(key): Promise<any>`                   | Shortcut for `dht.get` with added logging.                                         |
| `createTransport`        | `createTransport(type, options): Transport`     | Factory for built-in transports (`websocket`, `azure`).                                |
| `getAvailableTransports` | `getAvailableTransports(): string[]`            | List of supported transport types.                                                   |
| `sendMessageToPeer`      | `sendMessageToPeer(peerId, message): void`      | Send arbitrary message over an existing peer connection.                             |
| `disconnectSignaling`    | `disconnectSignaling(): void`                   | Close the signaling transport and clean up listeners.                                |
| `setDebug`               | `setDebug(enabled: boolean): void`              | Enable or disable verbose debug logging in the API layer.                            |

### Using API Helpers with Transports

The `api.js` module provides helper functions to simplify interaction with WebDHT, especially when managing signaling transports. This section demonstrates a typical workflow.

**1. Import necessary modules:**

Make sure to import `WebDHT` and the required API helper functions. The exact import path might depend on your project setup and how `webdht` structures its exports.

```javascript
// For ES Modules:
import WebDHT, {
  initializeApi,
  connectSignaling,
  disconnectSignaling,
  // createTransport, // Use if you need to instantiate transport manually for advanced cases
  putValue,
  getValue,
  setDebug
} from 'webdht';

// For CommonJS (Node.js):
// const { WebDHT, initializeApi, connectSignaling, ... } = require('webdht');
```

**2. Initialize WebDHT and the API Layer:**

First, create an instance of `WebDHT`. Then, use `initializeApi` to link this instance with the API helper system. This function also allows you to set up a UI adapter (for status updates, optional) and enable/disable debug logging for the API operations.

```javascript
// Create a WebDHT instance
const dht = new WebDHT({
  // bootstrap: ['ws://another-peer-signal-server.com/signal'], // Optional: bootstrap nodes
  // nodeId: 'your-custom-node-id-hex', // Optional: specify a node ID
});

// Initialize the API layer
// The second argument (adapter) is for UI updates; can be null if not used.
// The third argument enables/disables debug logging for the API helpers.
initializeApi(dht, null /* adapter */, true /* debug */);
// Alternatively, you can call setDebug(true) separately.
```

**3. Connect to a Signaling Server:**

Use the `connectSignaling` helper to establish a connection with your signaling server. You'll need to provide the transport type and its specific options (e.g., URL for a WebSocket server).

```javascript
async function setupSignalingConnection() {
  const transportConfig = {
    type: 'websocket', // Specify the transport type (e.g., 'websocket', 'azure')
    url: 'wss://your-signaling-server.com' // Replace with your actual signaling server URL
    // For 'azure', you'd provide 'connectionString' and 'hubName'
  };

  try {
    // connectSignaling handles the creation and management of the transport
    await connectSignaling(transportConfig);
    console.log('Successfully connected to signaling server via API helper.');

    // At this point, the DHT instance is ready to discover and connect to peers
    // through the configured signaling mechanism.
  } catch (error) {
    console.error('Failed to connect to signaling server:', error);
    // Handle connection errors (e.g., server down, incorrect URL)
  }
}

// Call the function to establish the signaling connection
setupSignalingConnection();
```
**Note on `createTransport`:** The `createTransport(type, options)` function is also available if you need to create a transport instance manually (e.g., to attach specific event listeners before `connectSignaling` is called). However, for most use cases, passing the configuration object to `connectSignaling` is sufficient as it will internally manage the transport lifecycle. If `connectSignaling` were to accept a pre-made transport instance, that would be an alternative flow.

**4. Using DHT Operations (Put/Get):**

Once `initializeApi` has been called and `connectSignaling` has successfully established a connection, you can use API helpers like `putValue` and `getValue`. These helpers will use the DHT instance you provided to `initializeApi`.

```javascript
// Listen for the DHT 'ready' event, which indicates the node is initialized
dht.on('ready', async (nodeId) => {
  console.log(`DHT Node is ready. Node ID: ${nodeId}`);

  try {
    const exampleKey = 'myFavoriteColor';
    const exampleValue = 'blue';

    console.log(`Attempting to PUT: { "${exampleKey}": "${exampleValue}" }`);
    const putSuccess = await putValue(exampleKey, exampleValue);

    if (putSuccess) {
      console.log('PUT operation successful!');

      console.log(`Attempting to GET value for key: "${exampleKey}"`);
      const retrievedValue = await getValue(exampleKey);
      console.log(`Retrieved value: "${retrievedValue}"`);

      if (retrievedValue === exampleValue) {
        console.log('Success! Value retrieved matches value put.');
      } else {
        console.warn('Value mismatch or value not found.');
      }
    } else {
      console.error('PUT operation failed. The value might not be stored on enough peers.');
    }
  } catch (error) {
    console.error('An error occurred during DHT PUT/GET operations:', error);
  }
});

// Important: Handle DHT's 'signal' events for WebRTC
// The signaling transport (e.g., WebSocket) connected via connectSignaling
// is responsible for relaying these WebRTC handshake messages between peers.
dht.on('signal', (signalData, peerId) => {
  // The 'signalData' should be sent to the target peer (or broadcast if an offer).
  // The transport configured via connectSignaling should handle this.
  // For example, a WebSocket transport would send this data over the WebSocket connection.
  console.log(`DHT generated signal for peer ${peerId ? peerId.substring(0,8) : 'N/A'}. Data:`, signalData.type);
  // No explicit action needed here if transport handles relay, but good for logging.
});

dht.on('peer:connect', (peerId) => {
  console.log(`Connected to peer: ${peerId.substring(0,8)}`);
});

dht.on('peer:disconnect', (peerId) => {
  console.log(`Disconnected from peer: ${peerId.substring(0,8)}`);
});
```

**5. Disconnecting from the Signaling Server:**

When your application is shutting down or you no longer need the signaling connection, use `disconnectSignaling`.

```javascript
// Example: Call this when cleaning up
async function teardownSignalingConnection() {
  try {
    await disconnectSignaling();
    console.log('Disconnected from signaling server.');
  } catch (error) {
    console.error('Error disconnecting from signaling server:', error);
  }
}

// window.addEventListener('beforeunload', () => {
//   teardownSignalingConnection();
// });
```

This comprehensive example should clarify how `api.js` helpers integrate with transports for signaling in WebDHT.


## Transports

### WebSocketTransport

-   **Type**: `websocket`
-   **Usage**: Default simple signaling via WebSocket server.
-   **Options**:
    -   `url` (string): WebSocket server URL.

### AzureTransport

-   **Type**: `azure`
-   **Usage**: Signaling via Azure Web PubSub or SignalR Service.
-   **Options**:
    -   `connectionString` (string)
    -   `hubName` (string)

## Examples

See the `example/` directory for full demos.

-   **Browser**: `example/browser.js` — open `index.html` on a local server
-   **Node.js CLI**: `example/node.js` — run with `--autoconnect` to link peers automatically

```bash
node server.js
# In browsers: visit http://localhost:3000
# In terminal: node example/node.js --autoconnect
```

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
