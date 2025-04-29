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
      return {
        OPEN: WebSocket.OPEN,
        CLOSED: WebSocket.CLOSED,
      };
    }
    try {
      const ws = new WebSocket(url);
      return Object.defineProperties(ws, {
        OPEN: {
          get: () => WebSocket.OPEN,
          enumerable: true,
        },
        CLOSED: {
          get: () => WebSocket.CLOSED,
          enumerable: true,
        },
      });
    } catch (err) {
      console.error(`WebSocket creation error: ${err.message}`);
      return {
        OPEN: WebSocket.OPEN,
        CLOSED: WebSocket.CLOSED,
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
  autoconnectEnabled = process.argv.includes("--autoconnect");

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
    connectSignaling("ws://localhost:3001", { reconnectAttempts: 0 });
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
