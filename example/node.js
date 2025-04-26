import WebDHT from "../src/index.js";
import WebSocket from "ws";
import readline from "readline";

let signalingSocket = null;
let dht = null;

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

// Initialize DHT
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
    maxPeers: 4, // Maximum number of concurrent peer connections
    debug: false, // Debug logging

    // WebRTC configuration
    simplePeerOptions: {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
      trickle: false,
    },
  };

  dht = new WebDHT(dhtOptions);

  dht.on("ready", (nodeId) => {
    console.log(`🟢 DHT ready. Your peer ID: ${nodeId}`);
    printCommands();
    connectToSignalingServer(dht, nodeId);
    setupDHTEventListeners(dht);
    promptCLI();
  });

  dht.on("error", (err) => {
    console.error("❌ DHT Error:", err);
  });
}

// Connect to signaling server
function connectToSignalingServer(dht, nodeId) {
  signalingSocket = new WebSocket("ws://localhost:3000");

  signalingSocket.on("open", () => {
    console.log("🔌 Connected to signaling server");
    signalingSocket.send(
      JSON.stringify({
        type: "register",
        peerId: nodeId,
      })
    );
  });

  signalingSocket.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "registered") {
        console.log(`🆔 Registered as ${data.peerId}`);
        if (data.peers.length) {
          console.log(`🌐 Available peers: ${data.peers.join(", ")}`);
        } else {
          console.log("🌐 No other peers available yet.");
        }
      }

      if (data.type === "new_peer") {
        console.log(`➕ New peer joined: ${data.peerId}`);
      }

      if (data.type === "peer_left") {
        console.log(`➖ Peer left: ${data.peerId}`);
      }

      if (data.type === "signal" && data.peerId && data.signal) {
        console.log(`📩 Signal received from ${data.peerId}`);

        const peer = dht.signal({ id: data.peerId, signal: data.signal });

        if (peer && typeof peer.on === "function") {
          attachPeerEvents(peer, data.peerId);
        }
      }

      if (data.type === "error") {
        console.error(`❌ Server error: ${data.message}`);
      }
    } catch (err) {
      console.error("❌ Failed to process server message:", err);
    }
  });

  signalingSocket.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
  });

  signalingSocket.on("close", () => {
    console.log("⚠️ Disconnected from signaling server");
  });

  // DHT to signaling server: outgoing signals
  dht.on("signal", (data) => {
    if (signalingSocket?.readyState === WebSocket.OPEN) {
      if (data && data.id && data.signal) {
        console.log(`📤 Sending signal to ${data.id}`);
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: data.id,
            signal: data.signal,
          })
        );
      }
    }
  });
}

// Attach peer events (used for both connect and signal)
function attachPeerEvents(peer, peerId) {
  if (peer._eventsAttached) return; // Prevent duplicate listeners
  peer._eventsAttached = true;

  peer.on("connect", () => {
    console.log(`🟢 Connected to ${peerId}`);
    peer.send(`Hello from ${dht.nodeId}`);
  });

  peer.on("data", (data) => {
    if (!dht.debug) return;
    const message = data.toString();
    console.log(`📨 Message from ${peerId}:`, message);

    // Add to messages list if it exists
    const messagesList = document.getElementById("messagesList");
    if (messagesList) {
      // Add formatted message to the list
      const formattedMessage = formatMessage(peerId, message, false);
      messagesList.appendChild(formattedMessage);

      // Scroll to the bottom of the messages list
      messagesList.scrollTop = messagesList.scrollHeight;
    }
  });

  peer.on("error", (err) => {
    console.error(`❌ Peer ${peerId} error:`, err);
  });

  peer.on("close", () => {
    console.log(`🔌 Peer ${peerId} connection closed.`);
  });
}

// DHT-level peer tracking
let autoconnectEnabled = false;

function setupDHTEventListeners(dht) {
  // Add autoconnect logic for new peers and registered peers
  if (autoconnectEnabled) {
    // Handle new peers
    signalingSocket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Connect to new peers
        if (data.type === "new_peer" && data.peerId) {
          console.log(`🔗 Auto-connecting to new peer: ${data.peerId}`);
          setTimeout(() => {
            dht.connect({ id: data.peerId })
              .then(peer => {
                console.log(`✅ Auto-connected to peer: ${data.peerId}`);
                attachPeerEvents(peer, data.peerId);
              })
              .catch(err =>
                console.error(`Auto-connect failed: ${err && err.message ? err.message : err}`)
              );
          }, 1000); // Small delay to ensure signaling is ready
        }
        
        // Also connect to existing peers when we first register
        if (data.type === "registered" && data.peers && data.peers.length > 0) {
          console.log(`🔍 Found ${data.peers.length} existing peers, connecting...`);
          
          // Connect to each existing peer with a small delay between connections
          data.peers.forEach((peerId, index) => {
            setTimeout(() => {
              console.log(`🔗 Auto-connecting to existing peer: ${peerId}`);
              dht.connect({ id: peerId })
                .then(peer => {
                  console.log(`✅ Auto-connected to existing peer: ${peerId}`);
                  attachPeerEvents(peer, peerId);
                })
                .catch(err =>
                  console.error(`Auto-connect to existing peer failed: ${err && err.message ? err.message : err}`)
                );
            }, index * 1000); // Stagger connections by 1 second
          });
        }
      } catch (err) {
        console.error("❌ Error processing message for autoconnect:", err);
      }
    });
  }
  dht.on("peer:connect", (peerId) => {
    console.log(`✅ DHT reports connected to peer: ${peerId}`);
  });

  dht.on("peer:disconnect", (peerId) => {
    console.log(`❌ DHT reports disconnected from peer: ${peerId}`);
  });

  dht.on("peer:error", (peerId, err) => {
    const idStr =
      typeof peerId === "string"
        ? peerId
        : peerId && peerId.id
        ? peerId.id
        : JSON.stringify(peerId);
    const errStr = err && err.message ? err.message : JSON.stringify(err);
    console.error(`❌ DHT error with peer ${idStr}: ${errStr}`);
  });
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
            const peer = await dht.connect({ id: peerId });
            attachPeerEvents(peer, peerId);
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
            await dht.put(args[1], args.slice(2).join(" "));
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
            const value = await dht.get(args[1]);
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
        signalingSocket?.close();
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
