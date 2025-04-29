#!/usr/bin/env node

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
connect <peerId>        - Connect to a peer
send <peerId> <message> - Send a chat message to a peer
put <key> <value>       - Store a value in DHT
get <key>               - Retrieve a value from DHT
peers                   - List connected peers
exit                    - Quit the app
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
      return { OPEN: WebSocket.OPEN, CLOSED: WebSocket.CLOSED };
    }
    try {
      const ws = new WebSocket(url);
      return Object.defineProperties(ws, {
        OPEN: { get: () => WebSocket.OPEN, enumerable: true },
        CLOSED: { get: () => WebSocket.CLOSED, enumerable: true },
      });
    } catch (err) {
      console.error(`WebSocket creation error: ${err.message}`);
      return { OPEN: WebSocket.OPEN, CLOSED: WebSocket.CLOSED };
    }
  },

  updateConnectedPeers: (peerIds) =>
    console.log("🔌 Connected peers updated:", peerIds),
};

// Mock browser globals for events
global.document = {
  dispatchEvent: (event) => {
    if (event.type === "api:registered" && autoconnectEnabled) {
      handleRegisteredEvent(event.detail);
    } else if (event.type === "api:new_peer" && autoconnectEnabled) {
      handleNewPeerEvent(event.detail);
    }
    console.log(`🔔 Event dispatched: ${event.type}`);
  },
  addEventListener: () => {}, // no-op
};

global.CustomEvent = class CustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.detail = opts?.detail || {};
  }
};

async function init() {
  autoconnectEnabled = process.argv.includes("--autoconnect");

  const dhtOptions = {
    k: 20,
    alpha: 3,
    bucketCount: 160,
    maxStoreSize: 1000,
    maxKeySize: 1024,
    maxValueSize: 64000,
    replicateInterval: 60_000,
    republishInterval: 300_000,
    maxPeers: 3,
    debug: false,
    dhtSignalThreshold: 2,
    dhtRouteRefreshInterval: 15_000,
    aggressiveDiscovery: true,
    simplePeerOptions: {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
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
        ],
        iceCandidatePoolSize: 10,
        iceTransportPolicy: "all",
      },
      trickle: false,
      sdpTransform: (sdp) =>
        sdp
          .replace(/a=ice-options:trickle\r\n/g, "a=ice-options:trickle renomination\r\n")
          .replace(/a=setup:actpass\r\n/g, "a=setup:actpass\r\na=connection-timeout:10\r\n"),
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

// Auto-connect handlers
const connectionAttempts = new Set();

async function handleRegisteredEvent({ peers }) {
  console.log(`🔍 Found ${peers.length} existing peers, connecting...`);
  for (let i = 0; i < peers.length; i++) {
    const peerId = peers[i];
    if (connectionAttempts.has(peerId) || dht.peerManager.getPeer(peerId)) continue;
    const shouldInitiate = dht.nodeId < peerId;
    if (shouldInitiate) {
      await new Promise((r) => setTimeout(r, i * 1000));
      console.log(`🔗 Auto-connecting to ${peerId}`);
      connectionAttempts.add(peerId);
      try {
        await connectToPeer(peerId);
        console.log(`✅ Auto-connected to ${peerId}`);
      } catch (e) {
        console.error(`Auto-connect failed: ${e.message}`);
      } finally {
        connectionAttempts.delete(peerId);
      }
    }
  }
}

async function handleNewPeerEvent({ peerId }) {
  if (connectionAttempts.has(peerId) || dht.peerManager.getPeer(peerId)) return;
  const shouldInitiate = dht.nodeId < peerId;
  if (shouldInitiate) {
    console.log(`🔗 Auto-connecting to new peer ${peerId}`);
    connectionAttempts.add(peerId);
    try {
      await connectToPeer(peerId);
      console.log(`✅ Auto-connected to ${peerId}`);
    } catch (e) {
      console.error(`Auto-connect failed: ${e.message}`);
    } finally {
      connectionAttempts.delete(peerId);
    }
  }
}

// CLI REPL
function promptCLI() {
  rl.question("> ", async (input) => {
    const [cmd, ...rest] = input.trim().split(" ");
    try {
      switch (cmd) {
        case "connect": {
          const peerId = rest[0];
          if (!peerId) return console.log("Usage: connect <peerId>");
          console.log(`📞 Connecting to ${peerId}...`);
          await connectToPeer(peerId);
          break;
        }
        case "send": {
          const [peerId, ...msgParts] = rest;
          if (!peerId || msgParts.length === 0)
            return console.log("Usage: send <peerId> <message>");
          const msg = msgParts.join(" ");
          await sendMessageToPeer(peerId, msg);
          break;
        }
        case "put": {
          const [key, ...valueParts] = rest;
          if (!key || valueParts.length === 0)
            return console.log("Usage: put <key> <value>");
          await putValue(key, valueParts.join(" "));
          console.log("📝 Stored.");
          break;
        }
        case "get": {
          const key = rest[0];
          if (!key) return console.log("Usage: get <key>");
          const val = await getValue(key);
          console.log("📦 Value:", val);
          break;
        }
        case "peers":
          console.log("Connected peers:", [...dht.peers.keys()]);
          break;
        case "exit":
          rl.close();
          process.exit(0);
        default:
          console.log(`Unknown command: ${cmd}`);
          printCommands();
      }
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    promptCLI();
  });
}

console.log(`Usage: node node.js [--autoconnect]`);
init();
