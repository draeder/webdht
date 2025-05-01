import WebDHT from "../src/index.js";
import readline from "readline";
import transportManager from "../transports/index.js";
import {
  initializeApi,
  connectSignaling,
  putValue,
  getValue,
  connectToPeer,
  sendMessageToPeer
} from "../src/api.js";

let dht = null;
let autoconnectEnabled = false;

// CLI setup
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function printCommands() {
  console.log(`
==============================
  WebDHT Node CLI Commands
==============================
connect <peerId>   - Connect to a peer
put <key> <value>  - Store a value in DHT
get <key>          - Retrieve a value from DHT
peers              - List connected peers
exit               - Quit the app
==============================
`);
}

// Create a Node.js–compatible UI adapter for the API
const nodeAdapter = {
  updateStatus: (message, isError = false) =>
    console.log(isError ? `❌ ERROR: ${message}` : `🔔 Status: ${message}`),

  updatePeerList: (peerIds) =>
    console.log("🌐 Available peers:", peerIds),

  addMessage: (peerId, message, isOutgoing) =>
    console.log(
      `${isOutgoing ? "📤" : "📥"} Message ${
        isOutgoing ? "to" : "from"
      } ${peerId.substring(0, 8)}: ${message}`
    ),

  getWebSocket: (url) => {
    if (!url) {
      console.warn("API: Empty WebSocket URL provided");
      const WebSocketClass = transportManager.getWebSocket();
      return {
        OPEN: WebSocketClass.OPEN,
        CLOSED: WebSocketClass.CLOSED,
      };
    }
    try {
      const wsTransport = transportManager.create('websocket', { url });
      
      // Create a wrapper that adapts WebSocketTransport to the WebSocket API
      const wsWrapper = {
        // Properties
        _handlers: {
          open: null,
          close: null,
          error: null,
          message: null
        },
        
        // Methods
        send: (data) => {
          // API sends JSON strings, so we parse them
          try {
            const parsedData = JSON.parse(data);
            return wsTransport.send(parsedData);
          } catch (err) {
            console.error('Failed to parse WebSocket data:', err);
            return false;
          }
        },
        
        close: () => wsTransport.disconnect(),
        
        // Event handlers with getters/setters
        get onopen() { return this._handlers.open; },
        set onopen(handler) {
          this._handlers.open = handler;
          if (handler) {
            wsTransport.on('connect', () => {
              if (this._handlers.open) this._handlers.open();
            });
          }
        },
        
        get onclose() { return this._handlers.close; },
        set onclose(handler) {
          this._handlers.close = handler;
          if (handler) {
            wsTransport.on('disconnect', (event) => {
              if (this._handlers.close) this._handlers.close({
                wasClean: true,  // Assume clean by default
                code: 1000,      // Normal closure
                reason: ''
              });
            });
          }
        },
        
        get onerror() { return this._handlers.error; },
        set onerror(handler) {
          this._handlers.error = handler;
          if (handler) {
            wsTransport.on('error', (err) => {
              if (this._handlers.error) this._handlers.error(err);
            });
          }
        },
        
        get onmessage() { return this._handlers.message; },
        set onmessage(handler) {
          this._handlers.message = handler;
          if (handler) {
            wsTransport.on('registered', (peerId, peers) => {
              if (this._handlers.message) {
                this._handlers.message({
                  data: JSON.stringify({
                    type: 'registered',
                    peerId: peerId,
                    peers: peers
                  })
                });
              }
            });
            
            wsTransport.on('new_peer', (peerId) => {
              if (this._handlers.message) {
                this._handlers.message({
                  data: JSON.stringify({
                    type: 'new_peer',
                    peerId: peerId
                  })
                });
              }
            });
            
            wsTransport.on('signal', (peerId, signal) => {
              // Validate the incoming signal before forwarding it
              if (!peerId || typeof peerId !== 'string' || peerId.length !== 40) {
                console.error('Invalid peer ID in incoming signal:', peerId);
                return;
              }

              // Validate signal structure
              if (!signal || typeof signal !== 'object' || !signal.type) {
                console.error('Invalid signal structure from server:', signal);
                return;
              }
              
              // Validate signal type
              const validSignalTypes = ['offer', 'answer', 'candidate', 'renegotiate', 'PING'];
              if (!validSignalTypes.includes(signal.type)) {
                console.warn(`Unknown signal type: ${signal.type} - allowing it anyway for compatibility`);
              }
              
              // Skip further processing for PING signals
              if (signal.type === 'PING') {
                return;
              }
              
              // Validate and fix signal contents based on type
              if ((signal.type === 'offer' || signal.type === 'answer') && !signal.sdp) {
                console.error(`Invalid ${signal.type} signal: missing SDP`, signal);
                return;
              }
              
              if (signal.type === 'candidate' && !signal.candidate) {
                console.error('Invalid ICE candidate: missing candidate data', signal);
                return;
              }
              
              // Fix potentially corrupted ICE candidate strings
              if (signal.type === 'candidate' && signal.candidate) {
                if (typeof signal.candidate === 'string' &&
                    !signal.candidate.includes('candidate:') &&
                    !signal.candidate.includes('a=candidate:')) {
                  console.warn('Attempting to repair malformed ICE candidate:', signal.candidate);
                  // Try to add the missing prefix
                  signal.candidate = 'candidate:' + signal.candidate;
                }
              }

              // Signal validation passed, forward to message handler
              if (this._handlers.message) {
                this._handlers.message({
                  data: JSON.stringify({
                    type: 'signal',
                    peerId: peerId,
                    signal: signal
                  })
                });
              }
            });
            
            wsTransport.on('server_error', (message) => {
              if (this._handlers.message) {
                this._handlers.message({
                  data: JSON.stringify({
                    type: 'error',
                    message: message
                  })
                });
              }
            });
            
            wsTransport.on('unknown_message', (message) => {
              if (this._handlers.message && this._handlers.message) {
                this._handlers.message({
                  data: JSON.stringify(message)
                });
              }
            });
          }
        },
        
        // Constants
        OPEN: 1,
        CLOSED: 3,
        
        // Dynamic readyState getter
        get readyState() {
          return wsTransport.connected ? 1 : 3; // 1=OPEN, 3=CLOSED
        }
      };
      
      // Set up initial connection handler
      wsTransport.on('connect', () => {
        if (wsWrapper._handlers.open) wsWrapper._handlers.open();
      });
      
      return wsWrapper;
    } catch (err) {
      console.error(`WebSocketTransport creation error: ${err.message}`);
      const WebSocketClass = transportManager.getWebSocket();
      return {
        OPEN: WebSocketClass.OPEN,
        CLOSED: WebSocketClass.CLOSED,
      };
    }
  },

  updateConnectedPeers: (peers) => {
    console.log(
      `🔌 Connected peers (${peers.length}): ${peers
        .map((p) => p.substring(0, 8) + "...")
        .join(", ")}`
    );
  },
};

// Mocks for browser-specific globals
global.document = {
  dispatchEvent: (event) => {
    if (event.type === "api:registered" && autoconnectEnabled) {
      handleRegisteredEvent(event.detail);
    } else if (event.type === "api:new_peer" && autoconnectEnabled) {
      handleNewPeerEvent(event.detail);
    }
    console.log(`🔔 Event dispatched: ${event.type}`);
  },
  addEventListener: () => {},
};

global.CustomEvent = class CustomEvent {
  constructor(eventType, options) {
    this.type = eventType;
    this.detail = options?.detail || {};
  }
};

// Initialize DHT and API
async function init() {
  autoconnectEnabled = process.argv.includes("--auto");

  const dhtOptions = {
    k: 20,
    alpha: 3,
    bucketCount: 160,
    maxStoreSize: 1000,
    maxKeySize: 1024,
    maxValueSize: 64000,
    replicateInterval: 60000,
    republishInterval: 300000,
    maxPeers: 3,
    debug: false,
    dhtSignalThreshold: 2,
    dhtRouteRefreshInterval: 15000,
    aggressiveDiscovery: true,
    simplePeerOptions: {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
        iceCandidatePoolSize: 10,
        iceTransportPolicy: "all",
      },
      trickle: false,
      sdpTransform: (sdp) =>
        sdp
          .replace(
            /a=ice-options:trickle\r\n/g,
            "a=ice-options:trickle renomination\r\n"
          )
          .replace(
            /a=setup:actpass\r\n/g,
            "a=setup:actpass\r\na=connection-timeout:10\r\n"
          ),
    },
  };

  dht = new WebDHT(dhtOptions);

  dht.on("ready", (nodeId) => {
    console.log(`🟢 DHT ready. Your peer ID: ${nodeId}`);
    initializeApi(dht, nodeAdapter);
    connectSignaling("ws://localhost:3001", {
      reconnectAttempts: 0
    });
    printCommands();
    promptCLI();
  });

  dht.on("error", (err) => {
    console.error("❌ DHT Error:", err);
  });
}

// Auto-connect on registration
const connectionAttempts = new Set();
async function handleRegisteredEvent(detail) {
  const peers = detail.peers;
  console.log(`🔍 Found ${peers.length} existing peers, connecting...`);

  for (let i = 0; i < peers.length; i++) {
    const peerId = peers[i];
    if (connectionAttempts.has(peerId) || dht.peers.has(peerId)) {
      console.log(
        `⏭️ Skipping auto-connect to ${peerId} - already in progress`
      );
      continue;
    }

    const shouldInitiate = dht.nodeId < peerId;
    if (shouldInitiate) {
      await new Promise((r) => setTimeout(r, i * 1000));
      console.log(`🔗 Auto-connecting to existing peer: ${peerId}`);
      connectionAttempts.add(peerId);

      const timeout = 10000;
      try {
        await Promise.race([
          connectToPeer(peerId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection timeout")), timeout)
          ),
        ]);
        console.log(`✅ Auto-connected to existing peer: ${peerId}`);
        nodeAdapter.updateConnectedPeers([...dht.peers.keys()]);
      } catch (err) {
        console.error(`Auto-connect failed: ${err.message}`);
        nodeAdapter.updateConnectedPeers([...dht.peers.keys()]);
      }
    } else {
      console.log(
        `⏳ Waiting for peer ${peerId} to initiate connection to us`
      );
    }
  }
}

// Auto-connect on new-peer events
async function handleNewPeerEvent(detail) {
  const peerId = detail.peerId;
  if (connectionAttempts.has(peerId) || dht.peers.has(peerId)) {
    console.log(
      `⏭️ Skipping auto-connect to ${peerId} - already in progress`
    );
    return;
  }

  const shouldInitiate = dht.nodeId < peerId;
  if (shouldInitiate) {
    console.log(`🔗 Auto-connecting to new peer: ${peerId}`);
    connectionAttempts.add(peerId);

    const timeout = 10000;
    try {
      await Promise.race([
        connectToPeer(peerId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timeout")), timeout)
        ),
      ]);
      console.log(`✅ Auto-connected to peer: ${peerId}`);
      nodeAdapter.updateConnectedPeers([...dht.peers.keys()]);
    } catch (err) {
      console.error(`Auto-connect failed: ${err.message}`);
      nodeAdapter.updateConnectedPeers([...dht.peers.keys()]);
    }
  } else {
    console.log(`⏳ Waiting for peer ${peerId} to initiate connection to us`);
  }
}

// CLI REPL
function promptCLI() {
  rl.question("> ", async (input) => {
    const args = input.trim().split(/\s+/);
    const cmd = args[0];

    switch (cmd) {
      case "connect":
        if (!args[1]) {
          console.log("Usage: connect <peerId>");
        } else {
          try {
            console.log(`📞 Connecting to ${args[1]}...`);
            await connectToPeer(args[1]);
          } catch (err) {
            console.error(`❌ Connection failed: ${err.message}`);
          }
        }
        break;

      case "put":
        if (args.length < 3) {
          console.log("Usage: put <key> <value>");
        } else {
          try {
            await putValue(args[1], args.slice(2).join(" "));
            console.log("📝 Value stored successfully.");
          } catch (err) {
            console.error("❌ Failed to store value:", err);
          }
        }
        break;

      case "get":
        if (!args[1]) {
          console.log("Usage: get <key>");
        } else {
          try {
            const val = await getValue(args[1]);
            console.log("📦 Retrieved value:", val);
          } catch (err) {
            console.error("❌ Failed to retrieve value:", err);
          }
        }
        break;

      case "peers":
        console.log("Connected peers:", [...dht.peers.keys()]);
        break;

      case "exit":
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`Unknown command: ${cmd}`);
        printCommands();
    }

    promptCLI();
  });
}

// Initial usage hint & kick off
console.log(`
Usage: node node.js [--autoconnect]
`);
init();