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

        // Only try to establish DHT routes AFTER the connection is fully established
        // This prevents WebRTC signaling state conflicts
        const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer' || data.signal.candidate);
        
        // Don't try to establish DHT routes during WebRTC signaling
        if (!isWebRTCSignal && dht.peers.size > 2 && Math.random() < 0.5) { // Only 50% chance and only if we have more than 2 peers
          console.log(`🔄 Attempting to establish DHT route to ${data.peerId.substring(0, 8)}...`);
          
          // Try to find a route through the DHT
          const otherPeers = Array.from(dht.peers.entries())
            .filter(([id, p]) => id !== data.peerId && p.connected)
            .slice(0, 1); // Limit to 1 other peer to reduce traffic
            
          if (otherPeers.length > 0) {
            const [routePeerId, routePeer] = otherPeers[0];
            console.log(`🔄 Establishing DHT route to ${data.peerId.substring(0, 8)}... via ${routePeerId.substring(0, 8)}...`);
            routePeer.send({
              type: "SIGNAL",
              sender: dht.nodeId,
              originalSender: dht.nodeId,
              signal: { type: "PING" },
              target: data.peerId,
              ttl: 3,
              viaDht: true,
              signalPath: [dht.nodeId]
            });
          }
        }
        
        // Process the signal
        const peer = dht.signal({
          id: data.peerId,
          signal: data.signal,
          viaDht: false // Mark as not coming through DHT
        });

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
    if (data && data.id && data.signal) {
      // Check if this signal came through the DHT
      const viaDht = data.viaDht === true;
      
      // If the signal came through the DHT, log it but don't send it through the server again
      if (viaDht) {
        console.log(`📤 Signal from ${data.id} received via DHT, not forwarding to server`);
        return;
      }
      
      // Detect WebRTC signaling messages
      const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer' || data.signal.candidate);
      
      // For initial peers or WebRTC signaling, ALWAYS use the server
      const peerCount = dht.peers.size;
      const useServer = peerCount <= 2 || isWebRTCSignal;
      
      // Try to route through DHT only for established connections and non-WebRTC signals
      let signalSent = false;
      
      if (!useServer && Math.random() < 0.8) { // 80% chance to try DHT routing for non-critical signals
        try {
          // If the peer is directly connected, send the signal directly
          if (dht.peers.has(data.id)) {
            console.log(`📤 Peer ${data.id.substring(0, 8)}... is directly connected, sending signal through DHT`);
            
            // Get the peer from our DHT
            const directPeer = dht.peers.get(data.id);
            if (directPeer && directPeer.connected) {
              console.log(`📤 Sending signal directly through DHT to peer ${data.id.substring(0, 8)}...`);
              
              // Send the signal directly through the peer connection
              directPeer.send({
                type: "SIGNAL",
                sender: dht.nodeId,
                originalSender: dht.nodeId,
                signal: data.signal,
                target: data.id,
                viaDht: true,
                signalPath: [dht.nodeId]
              });
              
              signalSent = true;
            }
          } else if (peerCount > 2) { // Only try routing through others if we have more than 2 peers
            // Try to route through other peers
            console.log(`📤 Trying to route signal to ${data.id.substring(0, 8)}... through DHT`);
            
            // Find closest peers to route through
            const closestPeers = Array.from(dht.peers.entries())
              .filter(([peerId, peer]) => peer.connected)
              .map(([peerId, peer]) => ({
                id: peerId,
                peer
              }))
              .slice(0, 2); // Take up to 2 peers
            
            if (closestPeers.length > 0) {
              // Only use one peer for routing to reduce traffic
              const {id: routePeerId, peer: routePeer} = closestPeers[0];
              console.log(`📤 Routing signal to ${data.id.substring(0, 8)}... via ${routePeerId.substring(0, 8)}...`);
              
              routePeer.send({
                type: "SIGNAL",
                sender: dht.nodeId,
                originalSender: dht.nodeId,
                signal: data.signal,
                target: data.id,
                ttl: 3,
                viaDht: true,
                signalPath: [dht.nodeId]
              });
              
              signalSent = true;
            }
          }
        } catch (err) {
          console.warn("❌ Error routing through DHT:", err.message);
        }
      }
      
      // Fall back to signaling server if DHT routing failed or wasn't attempted
      if (!signalSent && signalingSocket?.readyState === WebSocket.OPEN) {
        console.log(`📤 Sending signal to ${data.id} via server`);
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
    // Keep track of connection attempts to prevent simultaneous connections
    const connectionAttempts = new Set();
    
    // Handle new peers
    signalingSocket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Connect to new peers
        if (data.type === "new_peer" && data.peerId) {
          // Skip if we're already attempting to connect to this peer
          if (connectionAttempts.has(data.peerId)) {
            console.log(`⏭️ Skipping auto-connect to ${data.peerId} - connection already in progress`);
            return;
          }
          
          // Use lexicographical comparison to determine who initiates the connection
          // This ensures only one side tries to be the initiator
          const shouldInitiate = dht.nodeId < data.peerId;
          
          if (shouldInitiate) {
            console.log(`🔗 Auto-connecting to new peer: ${data.peerId} (we are initiator)`);
            connectionAttempts.add(data.peerId);
            
            setTimeout(() => {
              dht.connect({ id: data.peerId, initiator: true })
                .then(peer => {
                  console.log(`✅ Auto-connected to peer: ${data.peerId}`);
                  attachPeerEvents(peer, data.peerId);
                  connectionAttempts.delete(data.peerId);
                })
                .catch(err => {
                  console.error(`Auto-connect failed: ${err && err.message ? err.message : err}`);
                  connectionAttempts.delete(data.peerId);
                });
            }, 1000); // Small delay to ensure signaling is ready
          } else {
            console.log(`⏳ Waiting for peer ${data.peerId} to initiate connection to us`);
          }
        }
        
        // Also connect to existing peers when we first register
        if (data.type === "registered" && data.peers && data.peers.length > 0) {
          console.log(`🔍 Found ${data.peers.length} existing peers, connecting...`);
          
          // Connect to each existing peer with a small delay between connections
          // But only if we should be the initiator based on ID comparison
          data.peers.forEach((peerId, index) => {
            // Skip if we're already attempting to connect to this peer
            if (connectionAttempts.has(peerId)) {
              console.log(`⏭️ Skipping auto-connect to ${peerId} - connection already in progress`);
              return;
            }
            
            // Use lexicographical comparison to determine who initiates the connection
            const shouldInitiate = dht.nodeId < peerId;
            
            if (shouldInitiate) {
              setTimeout(() => {
                console.log(`🔗 Auto-connecting to existing peer: ${peerId} (we are initiator)`);
                connectionAttempts.add(peerId);
                
                dht.connect({ id: peerId, initiator: true })
                  .then(peer => {
                    console.log(`✅ Auto-connected to existing peer: ${peerId}`);
                    attachPeerEvents(peer, peerId);
                    connectionAttempts.delete(peerId);
                  })
                  .catch(err => {
                    console.error(`Auto-connect to existing peer failed: ${err && err.message ? err.message : err}`);
                    connectionAttempts.delete(peerId);
                  });
              }, index * 1000); // Stagger connections by 1 second
            } else {
              console.log(`⏳ Waiting for peer ${peerId} to initiate connection to us`);
            }
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
            
            // Use lexicographical comparison to determine who initiates the connection
            const shouldInitiate = dht.nodeId < peerId;
            console.log(`${shouldInitiate ? "We are" : "We are not"} the initiator for this connection`);
            
            const peer = await dht.connect({
              id: peerId,
              initiator: shouldInitiate
            });
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
