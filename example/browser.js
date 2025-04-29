/**
 * Browser example for WebDHT
 *
 * This example shows how to use WebDHT in a browser environment
 * with WebRTC peer connections through a signaling server.
 */

// Import WebDHT and the SHA1 functionality
import WebDHT from "/src/index.js";
import { generateRandomId } from "/src/sha1.js";
// Import the consolidated API functions
import {
  initializeApi,
  connectSignaling,
  connectToPeer,
  sendMessageToPeer,
  startDhtPeerDiscovery,
  stopDhtPeerDiscovery, // Assuming this might be needed later
  putValue, // Assuming this might be needed later
  getValue // Assuming this might be needed later
} from "../src/api.js";

// Track connection attempts to prevent duplicate connections
const connectionAttempts = new Set();

// UI Elements Cache
const uiElements = {};
function cacheUIElements() {
  uiElements.peerId = document.getElementById("peerId");
  uiElements.status = document.getElementById("status");
  uiElements.signalingUrl = document.getElementById("signalingUrl");
  uiElements.connectSignalingBtn = document.getElementById("connectSignalingBtn");
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
  updateStatus: (message, isError = false) => {
    if (!uiElements.status) return;
    uiElements.status.textContent = message;
    uiElements.status.style.color = isError ? "red" : "";
    console.log(isError ? "ERROR: " + message : "Status: " + message);
  },
  updatePeerList: (peerIds) => {
    if (!uiElements.peerList) return;
    uiElements.peerList.innerHTML = ''; // Clear current list
    const messagePeerSelect = uiElements.messagePeerId;
    const currentSelectedPeer = messagePeerSelect.value;
    messagePeerSelect.innerHTML = '<option value="">Select Peer</option>'; // Clear and add default

    peerIds.forEach(peerId => {
      const shortId = peerId.substring(0, 8) + '...';
      // Add to available peers list
      const li = document.createElement('li');
      // li.textContent = shortId;
      li.textContent = peerId
      li.dataset.peerId = peerId;
      li.style.cursor = 'pointer';
      li.onclick = () => {
        uiElements.connectPeerId.value = peerId;
        uiElements.messagePeerId.value = peerId;
      };
      uiElements.peerList.appendChild(li);

      // Add to message dropdown
      const option = document.createElement('option');
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
    const shortId = peerId.substring(0, 8) + '...';
    const prefix = isOutgoing ? `To ${shortId}:` : `From ${shortId}:`;
    const messageDiv = document.createElement('div');
    messageDiv.textContent = `${prefix} ${message}`;
    messageDiv.classList.add(isOutgoing ? 'outgoing-message' : 'incoming-message');
    uiElements.chatMessages.appendChild(messageDiv);
    // Scroll to bottom
    uiElements.chatMessages.scrollTop = uiElements.chatMessages.scrollHeight;
  },
  // Provide the browser's WebSocket implementation
  getWebSocket: (url) => new WebSocket(url),
  // New function to update the list of *connected* peers
  updateConnectedPeers: (connectedPeerIds) => {
    const peersDiv = uiElements.peers; // Assuming 'peers' is cached
    if (!peersDiv) {
      console.error("UI Element Error: 'peers' div not found in cache.");
      return;
    }
    peersDiv.innerHTML = ''; // Clear current list

    if (connectedPeerIds.length === 0) {
      peersDiv.textContent = 'No connected peers';
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'peer-list'; // Reuse existing style
    connectedPeerIds.forEach(peerId => {
      const li = document.createElement('li');
      li.className = 'peer-list-item';
      
      // Create a span with the full ID that can be clicked to toggle
      const idSpan = document.createElement('span');
      idSpan.textContent = peerId;
      idSpan.title = "Click to toggle full/short ID";
      idSpan.style.cursor = 'pointer';
      
      // Toggle between full and short ID on click
      let showingFullId = true;
      idSpan.addEventListener('click', () => {
        if (showingFullId) {
          idSpan.textContent = peerId.substring(0, 8) + '...';
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
      } else if (status.includes("Connecting") || status.includes("Reconnecting")) {
        uiElements.connectionStatus.style.color = "orange";
      } else {
        uiElements.connectionStatus.style.color = "red";
      }
    }
  }
};

// Setup tabs functionality
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs and contents
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      
      // Add active class to clicked tab
      tab.classList.add('active');
      
      // Show corresponding content
      const tabId = tab.getAttribute('data-tab');
      const content = document.getElementById(`${tabId}-content`);
      if (content) {
        content.classList.add('active');
      }
    });
  });
}

// Initialize the application
async function initApp() {
  cacheUIElements(); // Cache UI elements references
  setupTabs(); // Setup tab functionality
  
  try {
    console.log("Creating WebDHT instance...");
    // Create a WebDHT instance with signal batching and compression enabled
    const dht = new WebDHT({
      signalBatchInterval: 100, // Batch signals for 100ms
      signalCompression: true,  // Enable signal compression
      debug: false,              // Enable debug logging
      dhtSignalThreshold: 2,    // Reduced from default 3 to 2
      dhtRouteRefreshInterval: 15000, // Reduced from default 30s to 15s
      aggressiveDiscovery: true, // Always enable aggressive discovery
      simplePeerOptions: {
        trickle: false // Disable trickle ICE to reduce signaling traffic
      }
    });

    // Initialize the consolidated API with the DHT instance and UI adapter
    // This needs the dht instance, but doesn't need it to be 'ready'
    initializeApi(dht, browserUiAdapter);

    // Set default signaling URL - Moved outside 'ready' handler
    const defaultWsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    // Check if the element exists before setting its value
    if (uiElements.signalingUrl) {
        uiElements.signalingUrl.value = defaultWsUrl;
    } else {
        console.error("Error: signalingUrl element not found after caching!");
        browserUiAdapter.updateStatus("Error: UI element 'signalingUrl' missing.", true);
    }

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
      connectToSignalingServerWithRetry(defaultWsUrl); // Use our new connection function with retry

      console.log("Your peer ID is:", nodeId);
      console.log("Signal batching and compression enabled");

      // Start periodic peer discovery through DHT via API
      console.log("Starting DHT peer discovery via API...");
      startDhtPeerDiscovery(); // Use API function
    });

    // DHT 'error' event listener (optional, API might handle internally)
    dht.on('error', (err) => {
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
 * Connect to signaling server with automatic reconnection logic
 * @param {string} url - The WebSocket URL to connect to
 */
function connectToSignalingServerWithRetry(url) {
  // Validate URL format
  if (!isValidSignalingUrl(url)) {
    browserUiAdapter.updateStatus("Invalid signaling server URL format. Should be ws:// or wss://", true);
    return;
  }

  browserUiAdapter.updateConnectionStatus("Connecting to signaling server...");
  browserUiAdapter.updateStatus("Connecting to signaling server...");
  
  // Use the API's connectSignaling function
  connectSignaling(url);
  
  // Setup the reconnection logic and custom message handling using event listeners
  // rather than modifying WebSocket.prototype (which causes illegal invocation errors)
  document.addEventListener('signaling:connected', () => {
    browserUiAdapter.updateConnectionStatus("Connected to signaling server");
  });
  
  document.addEventListener('signaling:disconnected', (event) => {
    const wasClean = event.detail?.wasClean || false;
    if (!wasClean) {
      browserUiAdapter.updateStatus("Signaling connection lost. Attempting to reconnect...", true);
      browserUiAdapter.updateConnectionStatus("Connection lost. Reconnecting...");
      
      // Schedule reconnection with exponential backoff
      const reconnectAttempts = event.detail?.attempts || 1;
      const delay = Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
      
      browserUiAdapter.updateStatus(`Will attempt to reconnect in ${delay/1000} seconds...`);
      
      setTimeout(() => {
        browserUiAdapter.updateStatus(`Reconnecting to signaling server (attempt ${reconnectAttempts})...`);
        browserUiAdapter.updateConnectionStatus(`Reconnecting (attempt ${reconnectAttempts})...`);
        connectSignaling(url, { reconnectAttempts });
      }, delay);
    } else {
      browserUiAdapter.updateConnectionStatus("Disconnected from signaling server");
    }
  });
  
  document.addEventListener('signaling:error', () => {
    browserUiAdapter.updateStatus("Signaling connection error", true);
    browserUiAdapter.updateConnectionStatus("Connection error");
  });
  
  // These events will be dispatched from the api.js connectSignaling handler
  // when it processes these signaling server messages
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
    return parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:';
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
  
  // Skip if we're already attempting to connect to this peer
  if (connectionAttempts.has(peerId)) {
    console.log(`Skipping auto-connect to ${peerId} - connection already in progress`);
    return;
  }
  
  // Use lexicographical comparison to determine who initiates the connection
  const dhtInstance = window.dhtInstance; // Assuming it's globally accessible
  if (!dhtInstance) {
    console.error("DHT instance not available for auto-connection");
    return;
  }
  
  // Skip if we're already connected to this peer
  if (dhtInstance.peers.has(peerId)) {
    console.log(`Already connected to peer: ${peerId}`);
    return;
  }
  
  const shouldInitiate = dhtInstance.nodeId < peerId;
  
  if (shouldInitiate) {
    console.log(`Auto-connecting to peer: ${peerId} (we are initiator)`);
    browserUiAdapter.updateStatus(`Auto-connecting to peer: ${peerId.substring(0, 8)}...`);
    
    // Add to connection attempts set
    connectionAttempts.add(peerId);
    
    // Log attempt for debugging
    console.log(`Connection attempts before: ${Array.from(connectionAttempts)}`);
    
    // Attempt connection with a small delay to ensure signaling is ready
    setTimeout(() => {
      connectToPeer(peerId)
        .then(() => {
          console.log(`Auto-connected to peer: ${peerId}`);
          connectionAttempts.delete(peerId);
          // Ensure UI reflects the new connection
          if (browserUiAdapter.updateConnectedPeers && dhtInstance.peers) {
            const connectedPeerIds = Array.from(dhtInstance.peers.keys());
            browserUiAdapter.updateConnectedPeers(connectedPeerIds);
          }
        })
        .catch(err => {
          console.error(`Auto-connect failed: ${err && err.message ? err.message : err}`);
          browserUiAdapter.updateStatus(`Auto-connect to ${peerId.substring(0, 8)}... failed: ${err.message}`, true);
          connectionAttempts.delete(peerId);
          
          // Retry after a delay if this was a timing issue
          if (err.message && (err.message.includes('timeout') || err.message.includes('failed to connect'))) {
            console.log(`Will retry connection to ${peerId} after delay`);
            setTimeout(() => attemptAutomaticPeerConnection(peerId), 5000);
          }
        });
    }, 1000);
  } else {
    console.log(`Waiting for peer ${peerId} to initiate connection to us`);
  }
}

// Setup UI event listeners
function setupUIEventListeners() {
  // Helper function to safely add event listeners
  const safeAddEventListener = (elementKey, eventType, handler) => {
    if (uiElements[elementKey]) {
      uiElements[elementKey][eventType] = handler;
    } else {
      console.error(`UI Element Error: Element with key '${elementKey}' not found in cache. Cannot attach ${eventType} listener.`);
      browserUiAdapter.updateStatus(`Error: UI Element '${elementKey}' missing.`, true);
    }
  };

  const safeAddGenericEventListener = (elementKey, eventType, handler) => {
    if (uiElements[elementKey]) {
      uiElements[elementKey].addEventListener(eventType, handler);
    } else {
      console.error(`UI Element Error: Element with key '${elementKey}' not found in cache. Cannot attach ${eventType} listener.`);
      browserUiAdapter.updateStatus(`Error: UI Element '${elementKey}' missing.`, true);
    }
  };

  // Connect to Signaling Server Button
  safeAddEventListener('connectSignalingBtn', 'onclick', () => {
    const url = uiElements.signalingUrl.value;
    if (url) {
      connectToSignalingServerWithRetry(url); // Use our new connection function with retry
    } else {
      browserUiAdapter.updateStatus("Please enter a signaling server URL.", true);
    }
  });

  // Connect to Peer Button
  safeAddEventListener('connectPeerBtn', 'onclick', () => {
    const peerId = uiElements.connectPeerId.value;
    if (peerId) {
      connectToPeer(peerId); // Use API function
    } else {
      browserUiAdapter.updateStatus("Please enter a Peer ID to connect.", true);
    }
  });

  // Send Message Button
  safeAddEventListener('sendMessageBtn', 'onclick', () => {
    const peerId = uiElements.messagePeerId.value;
    const message = uiElements.messageInput.value;
    if (peerId && message) {
      sendMessageToPeer(peerId, message); // Use API function
      uiElements.messageInput.value = ''; // Clear input after sending
    } else {
      browserUiAdapter.updateStatus("Please select a peer and enter a message", true);
    }
  });

  // Allow sending message with Enter key
  safeAddGenericEventListener('messageInput', 'keypress', function (e) {
    if (e.key === 'Enter') {
      // Ensure sendMessageBtn exists before trying to click it
      if (uiElements.sendMessageBtn) {
        uiElements.sendMessageBtn.click(); // Trigger button click
      } else {
        console.error("Cannot simulate click: sendMessageBtn not found.");
      }
    }
  });

  // Put Key-Value Button
  safeAddEventListener('putBtn', 'onclick', async (event) => { // Added event parameter
    event.preventDefault(); // <<< ADDED: Prevent default form submission
    const key = uiElements.putKey.value;
    const value = uiElements.putValue.value;
    if (key && value) {
      try {
        browserUiAdapter.updateStatus(`Storing ${key}...`); // Add status update
        
        // Check if we have minimum connected peers
        const dhtInstance = window.dhtInstance;
        if (dhtInstance && dhtInstance.peers.size < 2) {
          browserUiAdapter.updateStatus(`Warning: Only ${dhtInstance.peers.size} peer(s) connected. DHT operations may fail.`, true);
        }
        
        await putValue(key, value); // Use API function
        browserUiAdapter.updateStatus(`Stored ${key} successfully.`); // Add success status
        if (uiElements.putKey) uiElements.putKey.value = '';
        if (uiElements.putValue) uiElements.putValue.value = '';
      } catch (err) {
        // Handle network failures with more detailed error information
        browserUiAdapter.updateStatus(`Failed to store ${key}: ${err.message || 'Unknown error'}`, true);
        // Offer retry option
        if (confirm(`Failed to store value. Retry?`)) {
          setTimeout(async () => {
            try {
              browserUiAdapter.updateStatus(`Retrying store operation for ${key}...`);
              await putValue(key, value);
              browserUiAdapter.updateStatus(`Stored ${key} successfully on retry.`);
              if (uiElements.putKey) uiElements.putKey.value = '';
              if (uiElements.putValue) uiElements.putValue.value = '';
            } catch (retryErr) {
              browserUiAdapter.updateStatus(`Retry failed: ${retryErr.message || 'Unknown error'}`, true);
            }
          }, 2000); // Wait 2 seconds before retry
        }
      }
    } else {
      browserUiAdapter.updateStatus("Please enter both key and value to store.", true);
    }
  });

  // Get Value Button
  safeAddEventListener('getBtn', 'onclick', async (event) => { // Added event parameter
    event.preventDefault(); // <<< ADDED: Prevent default form submission
    const key = uiElements.getKey.value;
    if (key) {
      try {
        browserUiAdapter.updateStatus(`Retrieving ${key}...`); // Add status update
        
        // Check if we have minimum connected peers
        const dhtInstance = window.dhtInstance;
        if (dhtInstance && dhtInstance.peers.size < 2) {
          browserUiAdapter.updateStatus(`Warning: Only ${dhtInstance.peers.size} peer(s) connected. DHT operations may fail.`, true);
        }
        
        const retrievedValue = await getValue(key); // Use API function
        if (uiElements.getResult) {
          uiElements.getResult.textContent = retrievedValue !== null ? `Retrieved: ${retrievedValue}` : "Value not found.";
        }
        browserUiAdapter.updateStatus(retrievedValue !== null ? `Retrieved value for ${key}.` : `Value for ${key} not found.`); // Add status update
      } catch (err) {
        if (uiElements.getResult) {
          uiElements.getResult.textContent = `Error: ${err.message}`;
        }
        
        // Enhanced error handling
        browserUiAdapter.updateStatus(`Failed to retrieve ${key}: ${err.message || 'Unknown error'}`, true);
        
        // Offer retry option
        if (confirm(`Failed to retrieve value. Retry?`)) {
          setTimeout(async () => {
            try {
              browserUiAdapter.updateStatus(`Retrying retrieve operation for ${key}...`);
              const retrievedValue = await getValue(key);
              if (uiElements.getResult) {
                uiElements.getResult.textContent = retrievedValue !== null ? `Retrieved on retry: ${retrievedValue}` : "Value not found on retry.";
              }
              browserUiAdapter.updateStatus(retrievedValue !== null ? `Retrieved value for ${key} on retry.` : `Value for ${key} not found on retry.`);
            } catch (retryErr) {
              if (uiElements.getResult) {
                uiElements.getResult.textContent = `Retry error: ${retryErr.message}`;
              }
              browserUiAdapter.updateStatus(`Retry failed: ${retryErr.message || 'Unknown error'}`, true);
            }
          }, 2000); // Wait 2 seconds before retry
        }
      }
    } else {
      browserUiAdapter.updateStatus("Please enter a key to retrieve.", true);
      if (uiElements.getResult) {
        uiElements.getResult.textContent = '';
      }
    }
  });

  // Listen for signals from the API.js when new peers are discovered
  document.addEventListener('api:new_peer', (event) => {
    const { peerId } = event.detail;
    if (peerId) {
      attemptAutomaticPeerConnection(peerId);
    }
  });

  // Listen for signals when a peer registration happens to connect to existing peers
  document.addEventListener('api:registered', (event) => {
    const { peers } = event.detail;
    if (peers && peers.length > 0) {
      console.log(`Found ${peers.length} existing peers via registration, connecting...`);
      
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
  const demoButton = document.getElementById('demoButton'); // Get button directly as it wasn't cached
  if (demoButton) {
    demoButton.onclick = demonstrateSHA1;
  } else {
    console.error("UI Element Error: 'demoButton' not found. Cannot attach listener.");
  }
}

// Demonstrate SHA1 function
async function demonstrateSHA1() {
  const resultDiv = document.querySelector('#tools-content .result');
  if (!resultDiv) {
    console.error("Could not find result div for SHA1 demo");
    return;
  }
  
  resultDiv.innerHTML = '<p>Generating random peer IDs...</p>';
  
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await generateRandomId();
      ids.push(id);
    }
    
    resultDiv.innerHTML = `<p>Generated ${ids.length} random SHA1 IDs:</p>
      <ul style="font-family: monospace; list-style: none; padding: 0;">
        ${ids.map(id => `<li>${id}</li>`).join('')}
      </ul>`;
  } catch (err) {
    resultDiv.innerHTML = `<p style="color: red;">Error generating IDs: ${err.message}</p>`;
  }
}

// We now handle WebSocket messages directly in the onmessage handler
// instead of overriding the send method

// Make the DHT instance globally accessible (needed for auto-connection)
window.initApp = async function() {
  window.dhtInstance = await initApp();
  return window.dhtInstance;
};

// Auto-initialize the app when loaded
document.addEventListener('DOMContentLoaded', window.initApp);

