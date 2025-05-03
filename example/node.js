import WebDHT from "../src/index.js";
import readline from "readline";
import {
  initializeApi,
  connectSignaling,
  putValue,
  getValue,
  connectToPeer,
  sendMessageToPeer,
  createTransport,
  getAvailableTransports
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
  lastStatus: null,
  lastStatusTime: 0,
  updateStatus: function(message, isError = false) {
    // Implement deduplication - only show status if it's changed or 5 seconds have passed
    const now = Date.now();
    if (message !== this.lastStatus || now - this.lastStatusTime > 5000) {
      console.log(isError ? `❌ ERROR: ${message}` : `🔔 Status: ${message}`);
      this.lastStatus = message;
      this.lastStatusTime = now;
    }
  },

  // Track last peer list to avoid duplicate messages
  lastPeerList: null,
  updatePeerList: function(peerIds) {
    // Convert to string for comparison (handles array order differences)
    const peerListString = JSON.stringify(peerIds.sort());
    if (peerListString !== this.lastPeerList) {
      console.log("🌐 Available peers:", peerIds);
      this.lastPeerList = peerListString;
    }
  },

  addMessage: (peerId, message, isOutgoing) =>
    console.log(
      `${isOutgoing ? "📤" : "📥"} Message ${
        isOutgoing ? "to" : "from"
      } ${peerId.substring(0, 8)}: ${message}`
    ),

  // Using the new transport system
  transportAdapter: {
    createTransport: (transportType, options = {}) => {
      return createTransport(transportType, {
        ...options,
        debug: true,
        validateSignals: true
      });
    }
  },

  // Track last connected peers list to avoid duplicate messages
  lastConnectedPeerList: null,
  updateConnectedPeers: function(peers) {
    // Always check against the DHT's actual connected peers (source of truth)
    // Only print if we have the DHT instance available
    let connectedPeers = peers;
    
    if (dht) {
      connectedPeers = [...dht.peers.keys()].filter(peerId => {
        const peer = dht.peers.get(peerId);
        return peer && peer.connected;
      });
    }
    
    // Convert to string for comparison (handles array order differences)
    const peerListString = JSON.stringify(connectedPeers.sort());
    if (peerListString !== this.lastConnectedPeerList) {
      console.log(
        `🔌 Connected peers (${connectedPeers.length}): ${connectedPeers
          .map((p) => p.substring(0, 8) + "...")
          .join(", ")}`
      );
      this.lastConnectedPeerList = peerListString;
    }
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
    
    // Connect using WebSocket transport
    connectSignaling("ws://localhost:3001", {
      transport: 'websocket',
      reconnectAttempts: 0,
      validateSignals: true
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
const processedRegistrations = new Set(); // Track processed registration events

async function handleRegisteredEvent(detail) {
  // Generate a unique ID for this registration event to prevent duplicates
  const eventId = JSON.stringify(detail.peers);
  if (processedRegistrations.has(eventId)) {
    return; // Skip if we've already processed this exact registration
  }
  processedRegistrations.add(eventId);
  
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
const processedNewPeers = new Set(); // Track processed new peer events

async function handleNewPeerEvent(detail) {
  const peerId = detail.peerId;
  
  // Skip if we've already processed this peer event recently
  if (processedNewPeers.has(peerId)) {
    return;
  }
  processedNewPeers.add(peerId);
  
  // Clear old entries from the processed set after a delay to allow re-processing after some time
  setTimeout(() => {
    processedNewPeers.delete(peerId);
  }, 30000); // Clear after 30 seconds
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