/**
 * Browser example for WebDHT
 *
 * This example shows how to use WebDHT in a browser environment
 * with WebRTC peer connections through a signaling server.
 */

// Import WebDHT and the SHA1 functionality
import WebDHT, { generateRandomId } from "/src/index.js";

// Import the consolidated API functions
import {
  initializeApi,
  connectToPeer,
  sendMessageToPeer,
  startDhtPeerDiscovery,
  stopDhtPeerDiscovery, // Assuming this might be needed later
  putValue, // Assuming this might be needed later
  getValue, // Assuming this might be needed later
} from "/src/api.js";

// Import the transport manager
import transportManager from "../transports/index.js";

// Track connection attempts with metadata (peer ID, timestamps, retry counts, etc.)
const connectionAttempts = new Map();

// Signal timeout configuration
const SIGNAL_TIMEOUT = 15000; // 15 seconds timeout for signal exchange
const MAX_CONNECTION_RETRIES = 5; // Maximum number of connection retries

// UI Elements Cache
const uiElements = {};
function cacheUIElements() {
  uiElements.peerId = document.getElementById("peerId");
  uiElements.status = document.getElementById("status");
  uiElements.signalingUrl = document.getElementById("signalingUrl");
  uiElements.connectSignalingBtn = document.getElementById(
    "connectSignalingBtn"
  );
  uiElements.peerList = document.getElementById("peerList");
  uiElements.connectPeerId = document.getElementById("connectPeerId");
  uiElements.connectPeerBtn = document.getElementById("connectPeerBtn");
  uiElements.messagePeerId = document.getElementById("messagePeerId");
  uiElements.messageInput = document.getElementById("messageInput");
  uiElements.sendMessageBtn = document.getElementById("sendMessageBtn");
  uiElements.chatMessages = document.getElementById("chatMessages");
  uiElements.putKey = document.getElementById("putKey");
  uiElements.putValue = document.getElementById("putValue");
  uiElements.putBtn = document.getElementById("putBtn");
  uiElements.getKey = document.getElementById("getKey");
  uiElements.getBtn = document.getElementById("getBtn");
  uiElements.getResult = document.getElementById("getResult");
  uiElements.peers = document.getElementById("peers"); // <<< ADDED: Cache the connected peers div
  uiElements.connectionStatus = document.getElementById("connectionStatus"); // For signaling connection status
}

// UI Adapter for api.js
const browserUiAdapter = {
  // Track last status message to prevent duplicates
  lastStatusMessage: "",
  lastDiscoveryCount: 0,
  // Keep track of repetitive discovery messages
  discoveryInProgress: false,
  updateStatus: (message, isError = false) => {
    if (!uiElements.status) return;

    // Handle "Discovering peers through DHT..." message
    if (message === "Discovering peers through DHT...") {
      if (browserUiAdapter.discoveryInProgress) {
        return; // Skip repeated discovery-in-progress messages
      }
      browserUiAdapter.discoveryInProgress = true;
    } else if (
      message.includes("Discovered") &&
      message.includes("unique peers through DHT")
    ) {
      // Reset discovery in progress flag when discovery result is shown
      browserUiAdapter.discoveryInProgress = false;

      // Extract the number from "Discovered X unique peers through DHT"
      const match = message.match(/Discovered (\d+) unique peers through DHT/);
      if (match) {
        const count = parseInt(match[1]);
        // Only show the message if the count changed
        if (count === browserUiAdapter.lastDiscoveryCount) {
          return; // Skip duplicate discovery result message
        }
        browserUiAdapter.lastDiscoveryCount = count;
      }
    } else {
      // Any other message resets the discovery in progress flag
      browserUiAdapter.discoveryInProgress = false;
    }
    
    // Special handling for connection status messages - normalize them for comparison
    // by removing the colon if present and standardizing format
    const isConnectionStatusMessage = message.includes("Connecting to") ||
                                      message.includes("Connected to");
    
    // Detect disconnection messages to avoid duplication
    const isDisconnectMessage = message.includes("Peer disconnected:");
                                      
    // Detect peer availability messages coming from different sources but meaning the same thing
    const isPeerAvailabilityMessage = message.includes("peers available") ||
                                     message.match(/Available peers: \d+/);
    
    let normalizedMessage = message;
    if (isConnectionStatusMessage) {
      normalizedMessage = message
        .replace("Connecting to:", "Connecting to")
        .replace("Connected to:", "Connected to")
        .replace("Connected to peer:", "Connected to");
    } else if (isDisconnectMessage) {
      // Extract peer ID from disconnection message and normalize
      const peerIdMatch = message.match(/Peer disconnected: ([a-f0-9]+)\.{3}/i);
      if (peerIdMatch && peerIdMatch[1]) {
        normalizedMessage = `DISCONNECT:${peerIdMatch[1]}`;
      }
    } else if (isPeerAvailabilityMessage) {
      // Extract just the peer count from both message formats
      // "Connected! X peers available" and "Available peers: X"
      const peerCountMatch = message.match(/(\d+) peers available/) ||
                            message.match(/Available peers: (\d+)/);
      if (peerCountMatch && peerCountMatch[1]) {
        normalizedMessage = `PEERS:${peerCountMatch[1]}`;
      }
    }
    
    let normalizedLastMessage = browserUiAdapter.lastStatusMessage;
    if (isConnectionStatusMessage && browserUiAdapter.lastStatusMessage) {
      normalizedLastMessage = browserUiAdapter.lastStatusMessage
        .replace("Connecting to:", "Connecting to")
        .replace("Connected to:", "Connected to")
        .replace("Connected to peer:", "Connected to");
    } else if (isDisconnectMessage && browserUiAdapter.lastStatusMessage) {
      // Extract peer ID from last disconnection message if it was one
      const peerIdMatch = browserUiAdapter.lastStatusMessage.match(/Peer disconnected: ([a-f0-9]+)\.{3}/i);
      if (peerIdMatch && peerIdMatch[1]) {
        normalizedLastMessage = `DISCONNECT:${peerIdMatch[1]}`;
      }
    } else if (isPeerAvailabilityMessage && browserUiAdapter.lastStatusMessage) {
      // Normalize the last message in the same way if it was a peer availability message
      const peerCountMatch = browserUiAdapter.lastStatusMessage.match(/(\d+) peers available/) ||
                            browserUiAdapter.lastStatusMessage.match(/Available peers: (\d+)/);
      if (peerCountMatch && peerCountMatch[1]) {
        normalizedLastMessage = `PEERS:${peerCountMatch[1]}`;
      }
    }

    // Skip if this is semantically the same as the last non-error status message
    if ((normalizedMessage === normalizedLastMessage) && !isError) {
      return;
    }

    // Update the status and remember this message
    browserUiAdapter.lastStatusMessage = message;
    uiElements.status.textContent = message;
    uiElements.status.style.color = isError ? "red" : "";
    console.log(isError ? "ERROR: " + message : "Status: " + message);
  },
  updatePeerList: (peerIds) => {
    if (!uiElements.peerList) return;
    uiElements.peerList.innerHTML = ""; // Clear current list
    const messagePeerSelect = uiElements.messagePeerId;
    const currentSelectedPeer = messagePeerSelect.value;
    messagePeerSelect.innerHTML = '<option value="">Select Peer</option>'; // Clear and add default

    peerIds.forEach((peerId) => {
      const shortId = peerId.substring(0, 8) + "...";
      // Add to available peers list
      const li = document.createElement("li");
      // li.textContent = shortId;
      li.textContent = peerId;
      li.dataset.peerId = peerId;
      li.style.cursor = "pointer";
      li.onclick = () => {
        uiElements.connectPeerId.value = peerId;
        uiElements.messagePeerId.value = peerId;
      };
      uiElements.peerList.appendChild(li);

      // Add to message dropdown
      const option = document.createElement("option");
      option.value = peerId;
      option.textContent = shortId;
      messagePeerSelect.appendChild(option);
    });

    // Restore selection if possible
    if (peerIds.includes(currentSelectedPeer)) {
      messagePeerSelect.value = currentSelectedPeer;
    }
  },
  addMessage: (peerId, message, isOutgoing) => {
    if (!uiElements.chatMessages) return;
    const shortId = peerId.substring(0, 8) + "...";
    const prefix = isOutgoing ? `To ${shortId}:` : `From ${shortId}:`;
    const messageDiv = document.createElement("div");
    messageDiv.textContent = `${prefix} ${message}`;
    messageDiv.classList.add(
      isOutgoing ? "outgoing-message" : "incoming-message"
    );
    uiElements.chatMessages.appendChild(messageDiv);
    // Scroll to bottom
    uiElements.chatMessages.scrollTop = uiElements.chatMessages.scrollHeight;
  },
  // Provide the browser's WebSocket implementation
  getWebSocket: (url) => transportManager.getWebSocket(url),
  // Transport instance
  webSocketTransport: null,
  // New function to update the list of *connected* peers
  updateConnectedPeers: (connectedPeerIds) => {
    const peersDiv = uiElements.peers; // Assuming 'peers' is cached
    if (!peersDiv) {
      console.error("UI Element Error: 'peers' div not found in cache.");
      return;
    }
    peersDiv.innerHTML = ""; // Clear current list

    if (connectedPeerIds.length === 0) {
      peersDiv.textContent = "No connected peers";
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "peer-list"; // Reuse existing style
    connectedPeerIds.forEach((peerId) => {
      const li = document.createElement("li");
      li.className = "peer-list-item";

      // Create a span with the full ID that can be clicked to toggle
      const idSpan = document.createElement("span");
      idSpan.textContent = peerId;
      idSpan.title = "Click to toggle full/short ID";
      idSpan.style.cursor = "pointer";

      // Toggle between full and short ID on click
      let showingFullId = true;
      idSpan.addEventListener("click", () => {
        if (showingFullId) {
          idSpan.textContent = peerId.substring(0, 8) + "...";
        } else {
          idSpan.textContent = peerId;
        }
        showingFullId = !showingFullId;
      });

      li.appendChild(idSpan);
      // Optional: Add disconnect button or other actions here
      ul.appendChild(li);
    });
    peersDiv.appendChild(ul);
  },
  // Add connection status updates
  updateConnectionStatus: (status) => {
    if (uiElements.connectionStatus) {
      uiElements.connectionStatus.textContent = status;

      // Set appropriate color based on status
      if (status.includes("Connected")) {
        uiElements.connectionStatus.style.color = "green";
      } else if (
        status.includes("Connecting") ||
        status.includes("Reconnecting")
      ) {
        uiElements.connectionStatus.style.color = "orange";
      } else {
        uiElements.connectionStatus.style.color = "red";
      }
    }
  },
};

// Setup tabs functionality
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const tabContents = document.querySelectorAll(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      // Remove active class from all tabs and contents
      tabs.forEach((t) => t.classList.remove("active"));
      tabContents.forEach((content) => content.classList.remove("active"));

      // Add active class to clicked tab
      tab.classList.add("active");

      // Show corresponding content
      const tabId = tab.getAttribute("data-tab");
      const content = document.getElementById(`${tabId}-content`);
      if (content) {
        content.classList.add("active");
      }
    });
  });
}

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
  aggressiveDiscovery: false,
  dhtRouteRefreshInterval: 60000, // Less frequent route refresh
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
    // Enable trickle for faster connection establishment
    trickle: false,
    // Improved SDP transformation to be more robust to WebRTC spec changes
    sdpTransform: (sdp) => {
      // Ensure we have ice-options:trickle for better connectivity
      if (!sdp.includes('a=ice-options:trickle')) {
        sdp = sdp.replace(/a=ice-options:/g, 'a=ice-options:trickle ');
      } else {
        // Add renomination for better candidate selection
        sdp = sdp.replace(/a=ice-options:trickle\r\n/g, 'a=ice-options:trickle renomination\r\n');
      }
      
      // Increase connection timeout for complex NAT scenarios
      if (!sdp.includes('a=connection-timeout')) {
        sdp = sdp.replace(/a=setup:actpass\r\n/g, 'a=setup:actpass\r\na=connection-timeout:30\r\n');
      }
      
      // Ensure proper ICE restart support
      if (!sdp.includes('a=ice-options:renomination')) {
        sdp = sdp.replace(/a=ice-options:/g, 'a=ice-options:renomination ');
      }
      
      return sdp;
    },
  },
};

// Initialize the application
async function initApp() {
  cacheUIElements(); // Cache UI elements references
  setupTabs(); // Setup tab functionality

  try {
    console.log("Creating WebDHT instance...");
    // Create a WebDHT instance with signal batching and compression enabled
    const dht = new WebDHT(dhtOptions);

    // Initialize the consolidated API with the DHT instance and UI adapter
    // This needs the dht instance, but doesn't need it to be 'ready'
    initializeApi(dht, browserUiAdapter);

    // Set default signaling URL - Moved outside 'ready' handler
    const defaultWsUrl = `${
      window.location.protocol === "https:" ? "wss:" : "ws:"
    }//${window.location.host}`;
    // Check if the element exists before setting its value
    if (uiElements.signalingUrl) {
      uiElements.signalingUrl.value = defaultWsUrl;
    } else {
      console.error("Error: signalingUrl element not found after caching!");
      browserUiAdapter.updateStatus(
        "Error: UI element 'signalingUrl' missing.",
        true
      );
    }

    // Set up DHT event handler for signals to be sent through the transport
    dht.on("signal", async (data) => {
      // Validate signal before forwarding
      if (!data) {
        console.error('Empty signal received');
        return;
      }

      // Check for remote peer ID validity
      if (!data.id || typeof data.id !== 'string' || data.id.length !== 40) {
        console.error('Invalid peer ID in signal:', data);
        return;
      }

      const targetPeerId = data.id;
      const peerShortId = targetPeerId.substring(0, 8);

      // Implement signal cancellation and rate limiting for peers
      if (connectionAttempts.has(targetPeerId)) {
        const peerState = connectionAttempts.get(targetPeerId);
        const now = Date.now();
        
        // If peer marked as unavailable, drop signals
        if (peerState.status === 'unavailable') {
          console.log(`Dropping signal to unavailable peer ${peerShortId}...`);
          return;
        }
        
        // Rate limit PING signals to once every 10 seconds per peer
        if (data.signal.type === 'PING') {
          const lastPingTime = peerState.lastPingTime || 0;
          if (now - lastPingTime < 10000) {
            // Silently drop excessive pings
            return;
          }
          // Update last ping time
          peerState.lastPingTime = now;
          connectionAttempts.set(targetPeerId, peerState);
        }
        
        // If this is a new signal attempt with a peer we've previously tried to connect to
        if (!peerState.signalStartTime) {
          // Set signal start time for timeout tracking
          peerState.signalStartTime = Date.now();
          
          // Create a timeout to detect stalled signal exchanges
          const timeoutId = setTimeout(() => {
            console.warn(`Signal exchange with ${peerShortId}... timed out after ${SIGNAL_TIMEOUT}ms`);
            
            // Update connection state
            if (connectionAttempts.has(targetPeerId)) {
              const currentState = connectionAttempts.get(targetPeerId);
              const retryCount = (currentState.retries || 0) + 1;
              
              if (retryCount > MAX_CONNECTION_RETRIES) {
                // Mark peer as temporarily unavailable after max retries
                connectionAttempts.set(targetPeerId, {
                  ...currentState,
                  status: 'unavailable',
                  retries: retryCount,
                  lastTried: Date.now()
                });
                
                browserUiAdapter.updateStatus(
                  `Connection to ${peerShortId}... failed after ${MAX_CONNECTION_RETRIES} attempts`,
                  true
                );
              } else {
                // Track retry attempt
                connectionAttempts.set(targetPeerId, {
                  ...currentState,
                  status: 'timeout',
                  retries: retryCount,
                  lastTried: Date.now()
                });
              }
            }
          }, SIGNAL_TIMEOUT);
          
          // Store the timeout ID so we can clear it if connection succeeds
          peerState.timeoutId = timeoutId;
          connectionAttempts.set(targetPeerId, peerState);
        }
      } else {
        // New connection attempt
        connectionAttempts.set(targetPeerId, {
          status: 'signaling',
          signalStartTime: Date.now(),
          retries: 0
        });
      }
      
      // Validate signal structure
      if (!browserUiAdapter.webSocketTransport?.connected) {
        console.error('WebSocket transport not connected');
        browserUiAdapter.updateStatus('Cannot send signal: Signaling server disconnected', true);
        return;
      }
      
      if (!data.signal || typeof data.signal !== 'object' || !data.signal.type) {
        console.error('Invalid signal structure:', data);
        return;
      }
      
      // Validate signal type - include PING as a valid type
      if (!['offer', 'answer', 'candidate', 'renegotiate', 'PING'].includes(data.signal.type)) {
        console.warn(`Unknown signal type: ${data.signal.type} - allowing it anyway for compatibility`);
        // Don't return/block unknown signal types, just log a warning
      }
      
      // Only log non-PING signals to reduce console noise
      if (data.signal.type !== 'PING') {
        console.log(`Sending validated ${data.signal.type} signal to ${peerShortId}...`);
      }
      
      // Validate signal contents based on type
      if (data.signal.type === 'offer' && !data.signal.sdp) {
        console.error('Invalid offer signal: missing SDP', data);
        return;
      }
      if (data.signal.type === 'answer' && !data.signal.sdp) {
        console.error('Invalid answer signal: missing SDP', data);
        return;
      }
      if (data.signal.type === 'candidate' && !data.signal.candidate) {
        console.error('Invalid ICE candidate: missing candidate', data);
        return;
      }
      
      // Signal validation passed, send through transport
      try {
        browserUiAdapter.webSocketTransport.signal(targetPeerId, data.signal);
      } catch (err) {
        console.error('Signal transport error:', err);
        browserUiAdapter.updateStatus(`Signal error: ${err.message}`, true);
        
        // Update connection attempt state
        if (connectionAttempts.has(targetPeerId)) {
          const currentState = connectionAttempts.get(targetPeerId);
          connectionAttempts.set(targetPeerId, {
            ...currentState,
            status: 'error',
            lastError: err.message,
            lastErrorTime: Date.now()
          });
        }
      }
    });

    // Set up the UI event listeners (buttons, inputs etc.) - Moved outside 'ready' handler
    setupUIEventListeners();

    // Set up actions to perform once DHT is ready
    dht.on("ready", (nodeId) => {
      // Only nodeId-dependent things remain here
      if (uiElements.peerId) {
        uiElements.peerId.textContent = nodeId;
      }
      browserUiAdapter.updateStatus("DHT node created with ID: " + nodeId);

      // Automatically connect to signaling server on ready
      console.log("Auto-connecting to signaling server...");
      connectToSignalingServerWithRetry(defaultWsUrl); // Use our new connection function with WebSocketTransport

      console.log("Your peer ID is:", nodeId);
      console.log("Signal batching and compression enabled");

      // Start periodic peer discovery through DHT via API
      console.log("Starting DHT peer discovery via API...");
      startDhtPeerDiscovery(); // Use API function
    });

    // DHT 'error' event listener (optional, API might handle internally)
    dht.on("error", (err) => {
      console.error("DHT Global Error:", err);
      browserUiAdapter.updateStatus(`DHT Global Error: ${err.message}`, true);
    });

    return dht;
  } catch (err) {
    console.error("Error initializing WebDHT:", err);
    browserUiAdapter.updateStatus(`Initialization Error: ${err.message}`, true);
  }
}

/**
 * Connect to signaling server with automatic reconnection logic using WebSocketTransport
 * @param {string} url - The WebSocket URL to connect to
 */
function connectToSignalingServerWithRetry(url) {
  // Validate URL format
  if (!isValidSignalingUrl(url)) {
    browserUiAdapter.updateStatus(
      "Invalid signaling server URL format. Should be ws:// or wss://",
      true
    );
    return;
  }

  browserUiAdapter.updateConnectionStatus("Connecting to signaling server...");
  browserUiAdapter.updateStatus("Connecting to signaling server...");

  // Create a WebSocketTransport instance if we don't have one already
  if (!browserUiAdapter.webSocketTransport) {
    const transport = transportManager.create('websocket', {
      url: url,
      autoReconnect: true,
      // Proper exponential backoff with jitter for reconnection
      reconnectDelay: (retryCount) => {
        // Base delay starts at 1s and increases exponentially
        const baseDelay = Math.min(30000, 1000 * Math.pow(2, retryCount));
        // Add jitter of ±30% to prevent thundering herd problem
        return baseDelay * (0.7 + Math.random() * 0.6);
      },
      // Set reasonable maximum retry limit to prevent infinite reconnection attempts
      maxReconnectAttempts: 10,
      // Faster initial backoff, then slower increase
      reconnectBackoffMultiplier: 1.5,
      // Store peer information between reconnects
      preservePeerInfo: true,
      debug: dhtOptions.debug
    });

    // Store the transport instance in the UI adapter for access
    browserUiAdapter.webSocketTransport = transport;

    // Set up event listeners for the transport
    transport.on('connect', () => {
      browserUiAdapter.updateConnectionStatus("Connected to signaling server");
      browserUiAdapter.updateStatus("Connected to signaling server");
      
      // Register with the transport if we have a DHT node ID
      if (window.dhtInstance && window.dhtInstance.nodeId) {
        transport.register(window.dhtInstance.nodeId);
      }
    });

    transport.on('registered', (peerId, peers) => {
      browserUiAdapter.updateStatus(`Registered with ID: ${peerId}`);
      browserUiAdapter.updateStatus(`Available peers: ${peers.length}`);
      browserUiAdapter.updatePeerList(peers);
      
      // Dispatch event for auto-connection similar to api.js
      if (peers.length > 0) {
        document.dispatchEvent(new CustomEvent('api:registered', {
          detail: { peers: peers }
        }));
      }
    });

    transport.on('new_peer', (peerId) => {
      browserUiAdapter.updateStatus(`New peer discovered: ${peerId.substring(0, 8)}...`);
      
      // Update the peer list with all registered peers
      const allPeers = transport.getRegisteredPeers();
      browserUiAdapter.updatePeerList(allPeers);
      
      // Dispatch event for auto-connection similar to api.js
      document.dispatchEvent(new CustomEvent('api:new_peer', {
        detail: { peerId: peerId }
      }));
    });

    transport.on('signal', (peerId, signal) => {
      // Process and validate incoming signals with consistent validation
      if (!window.dhtInstance) {
        console.error('DHT instance not available for signal processing');
        return;
      }
      
      // Validate peer ID format
      if (!peerId || typeof peerId !== 'string' || peerId.length !== 40) {
        console.error('Invalid peer ID in incoming signal:', peerId);
        return;
      }
      
      const peerShortId = peerId.substring(0, 8);
      
      // Validate signal structure
      if (!signal || typeof signal !== 'object' || !signal.type) {
        console.error('Invalid signal structure from server:', signal);
        browserUiAdapter.updateStatus(`Malformed signal from ${peerShortId}...`, true);
        
        // Track problematic peer signals
        const peerState = connectionAttempts.get(peerId) || {
          status: 'error',
          errorCount: 0,
          firstErrorTime: Date.now()
        };
        
        peerState.errorCount++;
        peerState.lastErrorTime = Date.now();
        connectionAttempts.set(peerId, peerState);
        
        // If we see consistent errors from a peer, implement recovery strategy
        if (peerState.errorCount > 3 && peerState.errorCount <= 5) {
          // Attempt reconnection after several errors
          const timeSinceFirstError = Date.now() - peerState.firstErrorTime;
          if (timeSinceFirstError > 30000) { // Only if errors persisted for > 30s
            console.log(`Attempting transport recovery due to bad signals from ${peerShortId}...`);
            
            // Implement exponential backoff with jitter
            const backoffDelay = Math.min(
              30000, // Cap at 30 seconds max delay
              1000 * Math.pow(1.5, peerState.errorCount) * (0.5 + Math.random()) // Base exponential backoff with jitter
            );
            
            // Schedule reconnection
            setTimeout(() => {
              if (browserUiAdapter.webSocketTransport?.connected) {
                console.log(`Reconnecting transport after backoff`);
                browserUiAdapter.webSocketTransport.disconnect();
                setTimeout(() => browserUiAdapter.webSocketTransport.connect(), 500);
              }
            }, backoffDelay);
          }
        } else if (peerState.errorCount > 5) {
          // Mark peer as temporarily unavailable after too many errors
          peerState.status = 'unavailable';
          connectionAttempts.set(peerId, peerState);
          console.warn(`Marked peer ${peerShortId}... as unavailable due to persistent signal errors`);
        }
        return;
      }
      
      // Validate signal type - make consistent with outgoing signal validation
      if (!['offer', 'answer', 'candidate', 'renegotiate', 'PING'].includes(signal.type)) {
        console.error('Unknown signal type from server:', signal.type);
        return;
      }
      
      // Skip further processing for PING signals - they're just keepalives
      if (signal.type === 'PING') {
        // Just acknowledge we received a ping, no need to process further
        return;
      }
      
      // Validate signal contents based on type
      let isValidSignal = true;
      let validationError = '';
      
      if ((signal.type === 'offer' || signal.type === 'answer') && !signal.sdp) {
        isValidSignal = false;
        validationError = `Invalid ${signal.type} signal: missing SDP`;
      } else if (signal.type === 'candidate' && !signal.candidate) {
        isValidSignal = false;
        validationError = 'Invalid ICE candidate: missing candidate data';
      }
      
      if (!isValidSignal) {
        console.error(validationError, signal);
        browserUiAdapter.updateStatus(`${validationError} from ${peerShortId}...`, true);
        return;
      }
      
      // Handle partial/corrupted signals - attempt repair for candidate signals
      if (signal.type === 'candidate' && signal.candidate) {
        // Fix potentially corrupted ICE candidate strings
        if (typeof signal.candidate === 'string' &&
            !signal.candidate.includes('candidate:') &&
            !signal.candidate.includes('a=candidate:')) {
          console.warn('Attempting to repair malformed ICE candidate:', signal.candidate);
          // Try to add the missing prefix
          signal.candidate = 'candidate:' + signal.candidate;
        }
      }
      
      // Signal validation passed, forward to DHT
      try {
        console.log(`Processing valid ${signal.type} signal from ${peerShortId}...`);
        
        // Clear any timeouts for this peer's connection
        if (connectionAttempts.has(peerId)) {
          const peerState = connectionAttempts.get(peerId);
          if (peerState.timeoutId) {
            clearTimeout(peerState.timeoutId);
          }
          
          // Update peer state to reflect active signaling
          connectionAttempts.set(peerId, {
            ...peerState,
            status: 'active',
            lastSignalTime: Date.now(),
            timeoutId: null,
            // Reset error count if we receive valid signals
            errorCount: 0
          });
        }
        
        // Forward validated signal to DHT
        window.dhtInstance.signal({
          id: peerId,
          signal: signal,
          viaDht: false
        });
      } catch (err) {
        console.error('Error processing signal:', err);
        browserUiAdapter.updateStatus(`Signal processing error: ${err.message}`, true);
      }
    });

    transport.on('disconnect', () => {
      browserUiAdapter.updateStatus("Disconnected from signaling server", true);
      browserUiAdapter.updateConnectionStatus("Disconnected from signaling server");
    });

    transport.on('error', (err) => {
      browserUiAdapter.updateStatus(`Signaling connection error: ${err.message}`, true);
      browserUiAdapter.updateConnectionStatus("Connection error");
    });

    // Connect to the signaling server
    transport.connect();
  } else {
    // If we already have a transport instance, just reconnect it
    browserUiAdapter.webSocketTransport.connect(url);
  }
}

/**
 * Validate signaling URL format
 * @param {string} url - The URL to validate
 * @returns {boolean} Whether the URL is valid
 */
function isValidSignalingUrl(url) {
  if (!url) return false;

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:";
  } catch (e) {
    return false;
  }
}

/**
 * Implement automatic peer connection similar to node.js implementation
 * @param {string} peerId - The ID of the peer to connect to
 */
function attemptAutomaticPeerConnection(peerId) {
  if (!peerId) return;
  
  const peerShortId = peerId.substring(0, 8);

  // Get current DHT instance
  const dhtInstance = window.dhtInstance;
  if (!dhtInstance) {
    console.error("DHT instance not available for auto-connection");
    return;
  }

  // Skip if we're already connected to this peer
  if (dhtInstance.peers.has(peerId)) {
    console.log(`Already connected to peer: ${peerShortId}...`);
    return;
  }

  // Check connection attempt state
  if (connectionAttempts.has(peerId)) {
    const peerState = connectionAttempts.get(peerId);
    
    // Prevent duplicate connection attempts
    if (peerState.status === 'connecting' || peerState.status === 'signaling') {
      console.log(
        `Skipping auto-connect to ${peerShortId}... - connection already in progress (${peerState.status})`
      );
      return;
    }
    
    // Check if we recently tried and failed to connect to this peer
    if (peerState.status === 'failed' || peerState.status === 'timeout') {
      const retryCount = peerState.retries || 0;
      
      // Check if we've reached the maximum retry limit
      if (retryCount >= MAX_CONNECTION_RETRIES) {
        console.log(
          `Skipping auto-connect to ${peerShortId}... - reached maximum retry limit (${MAX_CONNECTION_RETRIES})`
        );
        
        // Allow retrying after a longer cooldown period (5 minutes)
        const lastAttemptTime = peerState.lastTried || 0;
        const now = Date.now();
        if (now - lastAttemptTime < 5 * 60 * 1000) {
          return;
        }
        
        console.log(`Retry cooldown period elapsed for ${peerShortId}... - attempting final retry`);
        // Reset retry count after cooldown
        peerState.retries = 0;
      }
      
      // Calculate exponential backoff delay with jitter
      const baseDelay = Math.min(
        30000, // Cap at 30 seconds
        1000 * Math.pow(2, retryCount)
      );
      const jitterFactor = 0.7 + Math.random() * 0.6; // 30% jitter
      const delayWithJitter = Math.floor(baseDelay * jitterFactor);
      
      // Only retry if enough time has passed since last attempt
      const lastAttemptTime = peerState.lastTried || 0;
      const now = Date.now();
      if (now - lastAttemptTime < delayWithJitter) {
        console.log(
          `Skipping auto-connect to ${peerShortId}... - in backoff period (${Math.floor((delayWithJitter - (now - lastAttemptTime)) / 1000)}s remaining)`
        );
        return;
      }
    }
    
    // Handle unavailable peers
    if (peerState.status === 'unavailable') {
      const lastAttemptTime = peerState.lastTried || 0;
      const now = Date.now();
      // Only retry unavailable peers after a much longer timeout (15 minutes)
      if (now - lastAttemptTime < 15 * 60 * 1000) {
        console.log(`Skipping auto-connect to unavailable peer ${peerShortId}...`);
        return;
      }
      
      console.log(`Unavailable peer ${peerShortId}... cooldown elapsed - attempting reconnection`);
    }
  }

  // Use lexicographical comparison to determine who initiates the connection
  const shouldInitiate = dhtInstance.nodeId < peerId;

  if (shouldInitiate) {
    console.log(`Auto-connecting to peer: ${peerShortId}... (we are initiator)`);
    browserUiAdapter.updateStatus(
      `Auto-connecting to peer: ${peerShortId}...`
    );

    // Update connection attempt state
    const retryCount = connectionAttempts.has(peerId) ?
      (connectionAttempts.get(peerId).retries || 0) : 0;
      
    connectionAttempts.set(peerId, {
      status: 'connecting',
      startTime: Date.now(),
      retries: retryCount,
      lastTried: Date.now()
    });

    // Attempt connection with a small delay to ensure signaling is ready
    setTimeout(() => {
      // Double-check we haven't connected in the meantime
      if (dhtInstance.peers.has(peerId)) {
        console.log(`Already connected to peer ${peerShortId}... before attempt started`);
        
        // Update state
        if (connectionAttempts.has(peerId)) {
          connectionAttempts.set(peerId, {
            ...connectionAttempts.get(peerId),
            status: 'connected'
          });
        }
        return;
      }
      
      // Analyze failure causes from past attempts
      const peerState = connectionAttempts.get(peerId);
      let connectionTimeoutMs = 30000; // Default 30s timeout
      
      // Adjust timeout based on failure history
      if (peerState && peerState.lastError) {
        if (peerState.lastError.includes('ICE') || peerState.lastError.includes('connectivity')) {
          // Extend timeout for NAT traversal issues
          connectionTimeoutMs = 45000;
          console.log(`Extending connection timeout for potentially complex NAT scenario`);
        }
      }
      
      // Store connection start time for timeout tracking
      connectionAttempts.set(peerId, {
        ...connectionAttempts.get(peerId),
        connectionStartTime: Date.now()
      });
      
      // Attempt the connection
      connectToPeer(peerId)
        .then(() => {
          console.log(`Auto-connected to peer: ${peerShortId}...`);
          
          // Update connection state
          connectionAttempts.set(peerId, {
            ...connectionAttempts.get(peerId),
            status: 'connected',
            connectedAt: Date.now()
          });
          
          // Ensure UI reflects the new connection
          if (browserUiAdapter.updateConnectedPeers && dhtInstance.peers) {
            const connectedPeerIds = Array.from(dhtInstance.peers.keys());
            browserUiAdapter.updateConnectedPeers(connectedPeerIds);
          }
        })
        .catch((err) => {
          const errorMsg = err && err.message ? err.message : String(err);
          console.error(`Auto-connect failed: ${errorMsg}`);
          
          browserUiAdapter.updateStatus(
            `Auto-connect to ${peerShortId}... failed: ${errorMsg}`,
            true
          );
          
          // Update connection state with error details for analysis
          const currentState = connectionAttempts.get(peerId) || {};
          const newRetryCount = (currentState.retries || 0) + 1;
          
          connectionAttempts.set(peerId, {
            ...currentState,
            status: 'failed',
            lastError: errorMsg,
            lastTried: Date.now(),
            retries: newRetryCount
          });
          
          // Analyze error type to determine if retry is appropriate
          const shouldRetry = errorMsg.includes("timeout") ||
                             errorMsg.includes("failed to connect") ||
                             errorMsg.includes("ICE") ||
                             errorMsg.includes("connection") ||
                             errorMsg.includes("signal");
                             
          if (shouldRetry && newRetryCount <= MAX_CONNECTION_RETRIES) {
            console.log(`Will retry connection to ${peerShortId}... (attempt ${newRetryCount}/${MAX_CONNECTION_RETRIES})`);
            
            // Implement exponential backoff with jitter
            const baseDelay = Math.min(30000, 1000 * Math.pow(2, newRetryCount));
            const jitterFactor = 0.7 + Math.random() * 0.6; // 30% jitter
            const delayWithJitter = Math.floor(baseDelay * jitterFactor);
            
            setTimeout(() => attemptAutomaticPeerConnection(peerId), delayWithJitter);
          } else if (newRetryCount > MAX_CONNECTION_RETRIES) {
            console.log(`Not retrying connection to ${peerShortId}... - reached maximum retry limit`);
            
            // Update status to reflect giving up
            connectionAttempts.set(peerId, {
              ...connectionAttempts.get(peerId),
              status: 'maxRetries'
            });
          } else {
            console.log(`Not retrying connection to ${peerShortId}... - error type indicates retry wouldn't help`);
          }
        });
    }, 1000);
  } else {
    console.log(`Waiting for peer ${peerShortId}... to initiate connection to us`);
    
    // Store information that we're waiting for this peer to connect to us
    connectionAttempts.set(peerId, {
      status: 'waiting',
      startTime: Date.now()
    });
  }
}

// Setup UI event listeners
function setupUIEventListeners() {
  // Helper function to safely add event listeners
  const safeAddEventListener = (elementKey, eventType, handler) => {
    if (uiElements[elementKey]) {
      uiElements[elementKey][eventType] = handler;
    } else {
      console.error(
        `UI Element Error: Element with key '${elementKey}' not found in cache. Cannot attach ${eventType} listener.`
      );
      browserUiAdapter.updateStatus(
        `Error: UI Element '${elementKey}' missing.`,
        true
      );
    }
  };

  const safeAddGenericEventListener = (elementKey, eventType, handler) => {
    if (uiElements[elementKey]) {
      uiElements[elementKey].addEventListener(eventType, handler);
    } else {
      console.error(
        `UI Element Error: Element with key '${elementKey}' not found in cache. Cannot attach ${eventType} listener.`
      );
      browserUiAdapter.updateStatus(
        `Error: UI Element '${elementKey}' missing.`,
        true
      );
    }
  };

  // Connect to Signaling Server Button
  safeAddEventListener("connectSignalingBtn", "onclick", () => {
    const url = uiElements.signalingUrl.value;
    if (url) {
      connectToSignalingServerWithRetry(url); // Use our new connection function with WebSocketTransport
    } else {
      browserUiAdapter.updateStatus(
        "Please enter a signaling server URL.",
        true
      );
    }
  });

  // Connect to Peer Button
  safeAddEventListener("connectPeerBtn", "onclick", () => {
    const peerId = uiElements.connectPeerId.value;
    if (peerId) {
      connectToPeer(peerId); // Use API function
    } else {
      browserUiAdapter.updateStatus("Please enter a Peer ID to connect.", true);
    }
  });

  // Send Message Button
  safeAddEventListener("sendMessageBtn", "onclick", () => {
    const peerId = uiElements.messagePeerId.value;
    const message = uiElements.messageInput.value;
    if (peerId && message) {
      sendMessageToPeer(peerId, message); // Use API function
      uiElements.messageInput.value = ""; // Clear input after sending
    } else {
      browserUiAdapter.updateStatus(
        "Please select a peer and enter a message",
        true
      );
    }
  });

  // Allow sending message with Enter key
  safeAddGenericEventListener("messageInput", "keypress", function (e) {
    if (e.key === "Enter") {
      // Ensure sendMessageBtn exists before trying to click it
      if (uiElements.sendMessageBtn) {
        uiElements.sendMessageBtn.click(); // Trigger button click
      } else {
        console.error("Cannot simulate click: sendMessageBtn not found.");
      }
    }
  });

  // Put Key-Value Button
  safeAddEventListener("putBtn", "onclick", async (event) => {
    // Added event parameter
    event.preventDefault(); // <<< ADDED: Prevent default form submission
    const key = uiElements.putKey.value;
    const value = uiElements.putValue.value;
    if (key && value) {
      try {
        browserUiAdapter.updateStatus(`Storing ${key}...`); // Add status update

        // Check if we have minimum connected peers
        const dhtInstance = window.dhtInstance;
        if (dhtInstance && dhtInstance.peers.size < 2) {
          browserUiAdapter.updateStatus(
            `Warning: Only ${dhtInstance.peers.size} peer(s) connected. DHT operations may fail.`,
            true
          );
        }

        await putValue(key, value); // Use API function
        browserUiAdapter.updateStatus(`Stored ${key} successfully.`); // Add success status
        if (uiElements.putKey) uiElements.putKey.value = "";
        if (uiElements.putValue) uiElements.putValue.value = "";
      } catch (err) {
        // Handle network failures with more detailed error information
        browserUiAdapter.updateStatus(
          `Failed to store ${key}: ${err.message || "Unknown error"}`,
          true
        );
        // Offer retry option
        if (confirm(`Failed to store value. Retry?`)) {
          setTimeout(async () => {
            try {
              browserUiAdapter.updateStatus(
                `Retrying store operation for ${key}...`
              );
              await putValue(key, value);
              browserUiAdapter.updateStatus(
                `Stored ${key} successfully on retry.`
              );
              if (uiElements.putKey) uiElements.putKey.value = "";
              if (uiElements.putValue) uiElements.putValue.value = "";
            } catch (retryErr) {
              browserUiAdapter.updateStatus(
                `Retry failed: ${retryErr.message || "Unknown error"}`,
                true
              );
            }
          }, 2000); // Wait 2 seconds before retry
        }
      }
    } else {
      browserUiAdapter.updateStatus(
        "Please enter both key and value to store.",
        true
      );
    }
  });

  // Get Value Button
  safeAddEventListener("getBtn", "onclick", async (event) => {
    // Added event parameter
    event.preventDefault(); // <<< ADDED: Prevent default form submission
    const key = uiElements.getKey.value;
    if (key) {
      try {
        browserUiAdapter.updateStatus(`Retrieving ${key}...`); // Add status update

        // Check if we have minimum connected peers
        const dhtInstance = window.dhtInstance;
        if (dhtInstance && dhtInstance.peers.size < 2) {
          browserUiAdapter.updateStatus(
            `Warning: Only ${dhtInstance.peers.size} peer(s) connected. DHT operations may fail.`,
            true
          );
        }

        const retrievedValue = await getValue(key); // Use API function
        if (uiElements.getResult) {
          uiElements.getResult.textContent =
            retrievedValue !== null
              ? `Retrieved: ${retrievedValue}`
              : "Value not found.";
        }
        browserUiAdapter.updateStatus(
          retrievedValue !== null
            ? `Retrieved value for ${key}.`
            : `Value for ${key} not found.`
        ); // Add status update
      } catch (err) {
        if (uiElements.getResult) {
          uiElements.getResult.textContent = `Error: ${err.message}`;
        }

        // Enhanced error handling
        browserUiAdapter.updateStatus(
          `Failed to retrieve ${key}: ${err.message || "Unknown error"}`,
          true
        );

        // Offer retry option
        if (confirm(`Failed to retrieve value. Retry?`)) {
          setTimeout(async () => {
            try {
              browserUiAdapter.updateStatus(
                `Retrying retrieve operation for ${key}...`
              );
              const retrievedValue = await getValue(key);
              if (uiElements.getResult) {
                uiElements.getResult.textContent =
                  retrievedValue !== null
                    ? `Retrieved on retry: ${retrievedValue}`
                    : "Value not found on retry.";
              }
              browserUiAdapter.updateStatus(
                retrievedValue !== null
                  ? `Retrieved value for ${key} on retry.`
                  : `Value for ${key} not found on retry.`
              );
            } catch (retryErr) {
              if (uiElements.getResult) {
                uiElements.getResult.textContent = `Retry error: ${retryErr.message}`;
              }
              browserUiAdapter.updateStatus(
                `Retry failed: ${retryErr.message || "Unknown error"}`,
                true
              );
            }
          }, 2000); // Wait 2 seconds before retry
        }
      }
    } else {
      browserUiAdapter.updateStatus("Please enter a key to retrieve.", true);
      if (uiElements.getResult) {
        uiElements.getResult.textContent = "";
      }
    }
  });

  // Listen for signals from the API.js when new peers are discovered
  document.addEventListener("api:new_peer", (event) => {
    const { peerId } = event.detail;
    if (peerId) {
      attemptAutomaticPeerConnection(peerId);
    }
  });

  // Listen for signals when a peer registration happens to connect to existing peers
  document.addEventListener("api:registered", (event) => {
    const { peers } = event.detail;
    if (peers && peers.length > 0) {
      console.log(
        `Found ${peers.length} existing peers via registration, connecting...`
      );

      // Connect to each existing peer with a small delay between connections
      peers.forEach((peerId, index) => {
        // Use setTimeout to stagger connection attempts
        setTimeout(() => {
          attemptAutomaticPeerConnection(peerId);
        }, index * 1000); // Stagger by 1 second per peer
      });
    }
  });

  // SHA1 Demo Button Listener
  const demoButton = document.getElementById("demoButton"); // Get button directly as it wasn't cached
  if (demoButton) {
    demoButton.onclick = demonstrateSHA1;
  } else {
    console.error(
      "UI Element Error: 'demoButton' not found. Cannot attach listener."
    );
  }
}

// Demonstrate SHA1 function
async function demonstrateSHA1() {
  const resultDiv = document.querySelector("#tools-content .result");
  if (!resultDiv) {
    console.error("Could not find result div for SHA1 demo");
    return;
  }

  resultDiv.innerHTML = "<p>Generating random peer IDs...</p>";

  try {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await generateRandomId();
      ids.push(id);
    }

    resultDiv.innerHTML = `<p>Generated ${ids.length} random SHA1 IDs:</p>
      <ul style="font-family: monospace; list-style: none; padding: 0;">
        ${ids.map((id) => `<li>${id}</li>`).join("")}
      </ul>`;
  } catch (err) {
    resultDiv.innerHTML = `<p style="color: red;">Error generating IDs: ${err.message}</p>`;
  }
}

// We use WebSocketTransport for signaling server communication
// instead of direct WebSocket connections

// Make the DHT instance globally accessible (needed for auto-connection)
window.initApp = async function () {
  window.dhtInstance = await initApp();
  return window.dhtInstance;
};

// Properly clean up resources when window is closed or refreshed
window.addEventListener('beforeunload', () => {
  if (browserUiAdapter.webSocketTransport) {
    console.log("Cleaning up WebSocketTransport...");
    browserUiAdapter.webSocketTransport.destroy();
  }
});

// Auto-initialize the app when loaded
document.addEventListener("DOMContentLoaded", window.initApp);