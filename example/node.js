import WebDHT from "../src/index.js";
import WebSocket from "ws";
import readline from "readline";
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

// Create a Node.js-compatible UI adapter for the API
const nodeAdapter = {
  updateStatus: (message, isError = false) => console.log(isError ? `❌ ERROR: ${message}` : `🔔 Status: ${message}`),
  updatePeerList: (peerIds) => console.log("🌐 Available peers:", peerIds),
  addMessage: (peerId, message, isOutgoing) => console.log(`${isOutgoing ? '📤' : '📥'} Message ${isOutgoing ? 'to' : 'from'} ${peerId.substring(0,8)}: ${message}`),
  getWebSocket: (url) => {
    // Validate URL before creating WebSocket to prevent errors
    if (!url) {
      console.warn("API: Empty WebSocket URL provided");
      // Return WebSocket constants directly without creating an invalid socket
      return {
        OPEN: WebSocket.OPEN,
        CLOSED: WebSocket.CLOSED
      };
    }

    try {
      // Create a WebSocket instance with valid URL
      const ws = new WebSocket(url);
      
      // Instead of modifying the ws instance directly (which causes TypeError),
      // return a wrapped version that provides access to the WebSocket constants
      return Object.defineProperties(ws, {
        // Define OPEN and CLOSED as getter properties that return WebSocket's constants
        "OPEN": {
          get: () => WebSocket.OPEN,
          enumerable: true
        },
        "CLOSED": {
          get: () => WebSocket.CLOSED,
          enumerable: true
        }
      });
    } catch (err) {
      console.error(`WebSocket creation error: ${err.message}`);
      // Return mock object with WebSocket constants
      return {
        OPEN: WebSocket.OPEN,
        CLOSED: WebSocket.CLOSED
      };
    }
  },
  // Keep track of connected peers for UI updates
  updateConnectedPeers: (peerIds) => console.log(`🔌 Connected peers updated:`, peerIds)
};

// Create mocks for browser-specific objects used in the API
global.document = {
  dispatchEvent: (event) => {
    // Mock event handling for Node.js environment
    if (event.type === 'api:registered' && autoconnectEnabled) {
      handleRegisteredEvent(event.detail);
    } else if (event.type === 'api:new_peer' && autoconnectEnabled) {
      handleNewPeerEvent(event.detail);
    }
    console.log(`🔔 Event dispatched: ${event.type}`);
  },
  addEventListener: () => {} // No-op since we handle events directly
};

global.CustomEvent = class CustomEvent {
  constructor(eventType, options) {
    this.type = eventType;
    this.detail = options?.detail || {};
  }
};

// Initialize DHT and API
async function init() {
  autoconnectEnabled = process.argv.includes("--autoconnect");

  // Configure DHT with Kademlia and simple-peer options
  const dhtOptions = {
    // Kademlia parameters
    k: 20, // Size of k-buckets
    alpha: 3, // Number of parallel lookups
    bucketCount: 160, // Number of k-buckets (SHA1 = 160 bits)
    maxStoreSize: 1000, // Maximum number of stored key-value pairs
    maxKeySize: 1024, // Maximum key size in bytes (1KB)
    maxValueSize: 64000, // Maximum value size in bytes (64KB)

    // Maintenance intervals
    replicateInterval: 60000, // Reduce to 1 minute
    republishInterval: 300000, // Reduce to 5 minutes

    // Network parameters
    maxPeers: 3, // Increased from 4 to 6 to allow more connections
    debug: true, // Enable debug logging
    
    // DHT signaling optimization parameters
    dhtSignalThreshold: 2, // Reduced from default 3 to 2
    dhtRouteRefreshInterval: 15000, // Reduced from default 30s to 15s
    aggressiveDiscovery: true, // Always enable aggressive discovery

    // WebRTC configuration with improved ICE servers
    simplePeerOptions: {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
          // Add free TURN servers for better NAT traversal
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject"
          },
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
          }
        ],
        iceCandidatePoolSize: 10,
        iceTransportPolicy: "all"
      },
      trickle: false, // Enable trickle ICE for better connection success
      sdpTransform: (sdp) => {
        // Add aggressive ICE restart and connection timeout settings
        return sdp.replace(/a=ice-options:trickle\r\n/g,
                          "a=ice-options:trickle renomination\r\n")
                 .replace(/a=setup:actpass\r\n/g,
                          "a=setup:actpass\r\na=connection-timeout:10\r\n");
      }
    },
  };

  dht = new WebDHT(dhtOptions);

  dht.on("ready", (nodeId) => {
    console.log(`🟢 DHT ready. Your peer ID: ${nodeId}`);
    
    // Initialize the API with the DHT instance and Node.js adapter
    initializeApi(dht, nodeAdapter);
    
    // Connect to signaling server using the API
    connectSignaling("ws://localhost:3001", { reconnectAttempts: 0 });
    
    printCommands();
    promptCLI();
  });

  dht.on("error", (err) => {
    console.error("❌ DHT Error:", err);
  });
}

// Handle registered event (for autoconnect)
const connectionAttempts = new Set();
async function handleRegisteredEvent(detail) {
  const peers = detail.peers;
  console.log(`🔍 Found ${peers.length} existing peers, connecting...`);
  
  // Connect to each existing peer with a delay between attempts
  for (let i = 0; i < peers.length; i++) {
    const peerId = peers[i];
    
    // Skip if we're already attempting to connect
    if (connectionAttempts.has(peerId) || dht.peers.has(peerId)) {
      console.log(`⏭️ Skipping auto-connect to ${peerId} - connection already in progress`);
      continue;
    }
    
    // Use lexicographical comparison to determine who initiates
    const shouldInitiate = dht.nodeId < peerId;
    
    if (shouldInitiate) {
      await new Promise(resolve => setTimeout(resolve, i * 1000)); // Stagger connections
      
      console.log(`🔗 Auto-connecting to existing peer: ${peerId} (we are initiator)`);
      connectionAttempts.add(peerId);
      
      try {
        await connectToPeer(peerId);
        console.log(`✅ Auto-connected to existing peer: ${peerId}`);
      } catch (err) {
        console.error(`Auto-connect to existing peer failed: ${err.message}`);
      } finally {
        connectionAttempts.delete(peerId);
      }
    } else {
      console.log(`⏳ Waiting for peer ${peerId} to initiate connection to us`);
    }
  }
}

// Handle new peer event (for autoconnect)
async function handleNewPeerEvent(detail) {
  const peerId = detail.peerId;
  
  // Skip if we're already attempting to connect
  if (connectionAttempts.has(peerId) || dht.peers.has(peerId)) {
    console.log(`⏭️ Skipping auto-connect to ${peerId} - connection already in progress`);
    return;
  }
  
  // Use lexicographical comparison to determine who initiates
  const shouldInitiate = dht.nodeId < peerId;
  
  if (shouldInitiate) {
    console.log(`🔗 Auto-connecting to new peer: ${peerId} (we are initiator)`);
    connectionAttempts.add(peerId);
    
    try {
      await connectToPeer(peerId);
      console.log(`✅ Auto-connected to peer: ${peerId}`);
    } catch (err) {
      console.error(`Auto-connect failed: ${err.message}`);
    } finally {
      connectionAttempts.delete(peerId);
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
            const peerId = args[1];
            console.log(`📞 Connecting to ${peerId}...`);
            await connectToPeer(peerId);
          } catch (err) {
            console.error(`❌ Connection to ${args[1]} failed:`, err.message);
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
            const value = await getValue(args[1]);
            console.log("📦 Retrieved value:", value);
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

// Update usage display
console.log(`
Usage: node node.js [--autoconnect]
`);
init();
