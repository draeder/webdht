/**
 * Browser example for WebDHT
 *
 * This example shows how to use WebDHT in a browser environment
 * with WebRTC peer connections through a signaling server.
 */

// Import WebDHT and the SHA1 functionality
import WebDHT from "/src/index.js";
import { generateRandomId } from "/src/sha1.js";

// WebSocket connection for signaling
let signalingSocket = null;

// Initialize the application
async function initApp() {
  try {
    console.log("Creating WebDHT instance...");
    // Create a WebDHT instance
    const dht = new WebDHT();

    // Set up the UI and event listeners once DHT is ready
    dht.on("ready", (nodeId) => {
      document.getElementById("peerId").textContent = nodeId;
      document.getElementById("status").textContent =
        "DHT node created with ID: " + nodeId;

      // Connect to signaling server
      connectToSignalingServer(dht, nodeId);

      // Set up the UI with the DHT instance
      setupUI(dht);
      console.log("Your peer ID is:", nodeId);
    });

    return dht;
  } catch (err) {
    console.error("Error initializing WebDHT:", err);
    document.getElementById("status").textContent = `Error: ${err.message}`;
  }
}

// Helper function to update status with optional error styling
function updateStatus(message, isError = false) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  statusEl.textContent = message;

  if (isError) {
    statusEl.style.color = "red";
  } else {
    statusEl.style.color = ""; // Reset to default
  }

  console.log(isError ? "ERROR: " + message : "Status: " + message);
}

// Connect to the signaling server
function connectToSignalingServer(dht, nodeId) {
  console.log("Connecting to signaling server...");

  // Get the WebSocket URL from the current page URL
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;

  // Close any existing connection
  if (signalingSocket && signalingSocket.readyState !== WebSocket.CLOSED) {
    signalingSocket.close();
  }

  // Connect to the WebSocket signaling server
  signalingSocket = new WebSocket(`ws://${window.location.host}`);

  // Keep track of connected peers for demo
  const connectedPeers = new Set();

  // Track ongoing connection attempts
  const pendingConnections = new Map();

  // Setup signaling events
  signalingSocket.onopen = () => {
    console.log("Connected to signaling server");
    updateStatus("Connected to signaling server");

    // Register this peer with the signaling server
    const peerId = dht.nodeId;
    console.log(`Registering as peer: ${peerId}`);
    signalingSocket.send(
      JSON.stringify({
        type: "register",
        peerId: peerId,
      })
    );
  };

  signalingSocket.onerror = (error) => {
    console.error("WebSocket error:", error);
    updateStatus("Signaling connection error", true);
  };

  signalingSocket.onclose = () => {
    console.log("Disconnected from signaling server");
    updateStatus("Disconnected from signaling server", true);
  };

  // Function to update the available peer list in UI
  function updatePeerList(peerIds) {
    const peerListEl = document.getElementById("availablePeers");
    if (!peerListEl) return;

    // Clear the current list
    peerListEl.innerHTML = "";

    if (!peerIds || peerIds.length === 0) {
      const nopeersEl = document.createElement("li");
      nopeersEl.textContent = "No other peers available";
      peerListEl.appendChild(nopeersEl);
      return;
    }

    // Add each peer to the list
    peerIds.forEach((peerId) => {
      const peerEl = document.createElement("li");

      // Create a clickable element for easy connection
      const peerLink = document.createElement("a");
      peerLink.href = "#";
      peerLink.textContent = `${peerId.substring(0, 12)}...`;
      peerLink.onclick = (e) => {
        e.preventDefault();
        // Fill the target peer input with this ID
        const targetInput =
          document.getElementById("targetPeerId") ||
          document.getElementById("peerInfo");
        if (targetInput) {
          targetInput.value = peerId;
        }
      };

      peerEl.appendChild(peerLink);
      peerListEl.appendChild(peerEl);
    });
  }

  // Handle incoming messages from the signaling server
  signalingSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("Received:", data.type, data);

      // Handle different message types
      switch (data.type) {
        case "registered":
          // Successfully registered with the server
          console.log(`Registered as peer: ${data.peerId}`);
          console.log("Available peers:", data.peers);

          // Store our peer ID in the UI for easy reference
          const peerIdElement = document.getElementById("peerId");
          if (peerIdElement) {
            peerIdElement.textContent = data.peerId;
          }

          // Populate the peer list in UI
          if (data.peers && data.peers.length > 0) {
            updateStatus(`Connected! ${data.peers.length} peers available`);
            updatePeerList(data.peers);
          } else {
            updateStatus("Connected! No other peers available yet.");
          }
          break;

        case "new_peer":
          // A new peer has joined the network
          if (data.peerId) {
            console.log(`New peer joined: ${data.peerId}`);

            // Get the current peer list element
            const peerListEl = document.getElementById("availablePeers");
            if (peerListEl) {
              // Check if this peer is already in our list
              let peerExists = false;
              for (const child of peerListEl.children) {
                if (
                  child.textContent &&
                  child.textContent.includes(data.peerId)
                ) {
                  peerExists = true;
                  break;
                }
              }

              // If this is a new peer, add it to the list
              if (!peerExists) {
                updateStatus(
                  `New peer discovered: ${data.peerId.substring(0, 8)}...`
                );

                // Create a new list item for this peer
                const peerEl = document.createElement("li");

                // Create a clickable element for easy connection
                const peerLink = document.createElement("a");
                peerLink.href = "#";
                peerLink.textContent = `${data.peerId.substring(0, 12)}...`;
                peerLink.onclick = (e) => {
                  e.preventDefault();
                  // Fill the target peer input with this ID
                  const targetInput = document.getElementById("peerInfo");
                  if (targetInput) {
                    targetInput.value = data.peerId;
                  }
                };

                peerEl.appendChild(peerLink);
                peerListEl.appendChild(peerEl);
              }
            }
          }
          break;

        case "signal":
          // Received a WebRTC signal from another peer
          if (!data.peerId || !data.signal) {
            console.error("Invalid signal data received:", data);
            return;
          }

          console.log(
            `Signal from: ${data.peerId?.substring(0, 8)}...`,
            data.signal
          );

          // Mark this peer as attempting to connect if we haven't seen it
          if (
            !connectedPeers.has(data.peerId) &&
            !pendingConnections.has(data.peerId)
          ) {
            pendingConnections.set(data.peerId, Date.now());
            updateStatus(
              `Incoming connection from: ${data.peerId.substring(0, 8)}...`
            );
          }

          // Pass the signal to our DHT
          // NOTE: DHT.signal expects { id, signal } format, not { peerId, signal }
          try {
            console.log(
              `Processing signal from: ${data.peerId.substring(0, 8)}...`
            );
            dht.signal({
              id: data.peerId, // Convert to the format DHT.signal expects
              signal: data.signal,
            });
          } catch (signalError) {
            console.error("Error processing signal:", signalError);
            updateStatus(`Signal error: ${signalError.message}`, true);
          }
          break;

        case "error":
          // Server reported an error
          console.log("Server error:", data.message);
          updateStatus(`Error: ${data.message}`, true);
          break;

        default:
          console.log("Unknown message type:", data.type);
      }
    } catch (err) {
      console.error("Error processing message:", err);
      updateStatus("Error processing message from server", true);
    }
  };

  // Handle connection close
  signalingSocket.onclose = () => {
    console.log("Disconnected from signaling server");
    updateStatus("Disconnected from signaling server", true);
  };

  // Listen for signal events from the DHT and forward them
  dht.on("signal", (data) => {
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN)
      return;

    // Data should contain both the peer ID and the signal data
    if (data && data.id && data.signal) {
      console.log("Sending signal to:", data.id.substr(0, 8) + "...");

      // Send the signal through our signaling server
      signalingSocket.send(
        JSON.stringify({
          type: "signal",
          target: data.id,
          signal: data.signal,
        })
      );
    }
  });
}

// Store original emit function to restore later if needed
let originalDhtEmit = null;

// Initiate a connection to a peer
async function initiateConnection(dht, peerId) {
  if (!peerId) {
    console.error("No peer ID provided");
    return;
  }

  console.log(`Initiating connection to peer: ${peerId}`);

  // Override the DHT's emit method ONLY ONCE to handle signaling
  if (!originalDhtEmit) {
    console.log("Setting up DHT signal handler (once)");
    originalDhtEmit = dht.emit;

    dht.emit = function (event, data) {
      if (event === "signal" && data && data.signal && data.peerId) {
        console.log(`Forwarding signal to: ${data.peerId.substring(0, 8)}...`);

        // Forward the signal via our signaling server
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "signal",
              target: data.peerId,
              signal: data.signal,
            })
          );
          return true; // Signal handled
        } else {
          console.error("Cannot send signal: WebSocket not connected");
        }
      }

      // For non-signal events, use default behavior
      if (originalDhtEmit) {
        return originalDhtEmit.call(dht, event, data);
      }
      return false;
    };
  }

  try {
    // Connect to the peer through the DHT
    // Note: DHT.connect expects an object with an 'id' property, not just a string
    console.log(`Connecting to DHT peer: ${peerId}`);
    const peer = await dht.connect({
      id: peerId,
    });

    // Set up event handlers for this peer connection
    peer.on("connect", () => {
      console.log(`Connected to peer: ${peerId}`);
      document.getElementById(
        "status"
      ).textContent = `Connected to: ${peerId.substring(0, 8)}...`;
    });

    peer.on("data", (data) => {
      const message = data.toString();
      console.log(`Received data from ${peerId.substring(0, 8)}...:`, message);

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
      console.error(`Peer connection error: ${err.message}`);
      document.getElementById(
        "status"
      ).textContent = `Connection error: ${err.message}`;
    });

    return peer;
  } catch (err) {
    console.error("Failed to connect:", err);
    document.getElementById(
      "status"
    ).textContent = `Connection failed: ${err.message}`;
    throw err;
  }
}

// Set up the UI and event handlers
function setupUI(dht) {
  // DOM Elements
  const statusEl = document.getElementById("status");
  const peerIdEl = document.getElementById("peerId");
  const connectForm = document.getElementById("connectForm");
  const peerInfoEl = document.getElementById("peerInfo");
  const storeForm = document.getElementById("storeForm");
  const retrieveForm = document.getElementById("retrieveForm");
  const resultEl = document.getElementById("result");
  const peersEl = document.getElementById("peers");

  // Set up connected peers tracking
  const connectedPeers = new Set();

  // Handle signals from DHT that need to be sent to peers
  dht.on("signal", (data) => {
    if (data && data.peerId && data.signal) {
      console.log(
        `Signal from DHT for peer: ${data.peerId.substring(0, 8)}...`
      );

      // Send signal through signaling server
      if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: data.peerId,
            signal: data.signal,
          })
        );
      } else {
        console.error("Cannot send signal: WebSocket not connected");
        statusEl.textContent = "Signaling error: WebSocket disconnected";
      }
    }
  });

  // Handle peer connections
  dht.on("peer:connect", (peerId) => {
    console.log(`Connected to peer: ${peerId.substring(0, 8)}...`);
    statusEl.textContent =
      "Connected to peer: " + peerId.substring(0, 8) + "...";
    connectedPeers.add(peerId);
    updatePeersList();

    // Send a test message to confirm connection works
    const peer = dht.peers.get(peerId);
    if (peer) {
      try {
        peer.send("Hello! Connection established!");
      } catch (err) {
        console.error("Error sending test message:", err);
      }
    }
  });

  // Handle peer disconnections
  dht.on("peer:disconnect", (peerId) => {
    console.log(`Disconnected from peer: ${peerId.substring(0, 8)}...`);
    statusEl.textContent =
      "Disconnected from peer: " + peerId.substring(0, 8) + "...";
    connectedPeers.delete(peerId);
    updatePeersList();
  });

  // Handle peer errors
  dht.on("peer:error", ({ peer, error }) => {
    console.error(`Peer error: ${peer.substring(0, 8)}...`, error);
    statusEl.textContent =
      "Error with peer: " + peer.substring(0, 8) + "... - " + error;
  });

  // Connect to a peer using ID
  connectForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const peerIdInput = peerInfoEl.value.trim();
      if (!peerIdInput) {
        statusEl.textContent = "Please enter a valid peer ID";
        return;
      }

      // Just call initiateConnection - we'll handle all the signaling there
      statusEl.textContent = `Connecting to: ${peerIdInput.substring(0, 8)}...`;
      const peer = await initiateConnection(dht, peerIdInput);

      if (peer) {
        statusEl.textContent = `Connected to: ${peerIdInput.substring(
          0,
          8
        )}...`;
      }
    } catch (err) {
      console.error("Connection error:", err);
      statusEl.textContent = `Connection error: ${err.message}`;
    }
  });

  // Store a value
  storeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const key = document.getElementById("storeKey").value;
    const value = document.getElementById("storeValue").value;

    if (!key || !value) {
      resultEl.textContent = "Key and value are required";
      return;
    }

    statusEl.textContent = "Storing value...";

    try {
      const success = await dht.put(key, value);
      resultEl.textContent = success
        ? "Value stored successfully"
        : "Failed to store value";
      statusEl.textContent = success
        ? "Value stored successfully for key: " + key
        : "Failed to store value for key: " + key;
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      statusEl.textContent = "Error: " + err.message;
    }
  });

  // Retrieve a value
  retrieveForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const key = document.getElementById("retrieveKey").value;

    if (!key) {
      resultEl.textContent = "Key is required";
      return;
    }

    statusEl.textContent = "Retrieving value...";

    try {
      const value = await dht.get(key);
      resultEl.textContent =
        value !== null ? "Retrieved value: " + value : "Value not found";
      statusEl.textContent =
        value !== null
          ? "Retrieved value for key: " + key
          : "Value not found for key: " + key;
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      statusEl.textContent = "Error: " + err.message;
    }
  });

  // Update the list of connected peers
  function updatePeersList() {
    peersEl.innerHTML = "";

    if (connectedPeers.size === 0) {
      peersEl.textContent = "No connected peers";

      // Clear the select dropdown for sending messages
      const sendPeerIdEl = document.getElementById("sendPeerId");
      if (sendPeerIdEl) {
        sendPeerIdEl.innerHTML = '<option value="">Select a peer</option>';
      }
      return;
    }

    // Update the list of connected peers
    for (const peerId of connectedPeers) {
      const peerEl = document.createElement("div");
      peerEl.textContent = peerId.substring(0, 16) + "...";

      // Add a small disconnect button
      const disconnectBtn = document.createElement("button");
      disconnectBtn.textContent = "Disconnect";
      disconnectBtn.className = "button";
      disconnectBtn.style.marginLeft = "10px";
      disconnectBtn.style.padding = "3px 6px";
      disconnectBtn.style.fontSize = "0.8em";
      disconnectBtn.onclick = () => {
        dht.disconnect(peerId);
      };

      peerEl.appendChild(disconnectBtn);
      peersEl.appendChild(peerEl);
    }

    // Update the select dropdown for sending messages
    const sendPeerIdEl = document.getElementById("sendPeerId");
    if (sendPeerIdEl) {
      sendPeerIdEl.innerHTML = '<option value="">Select a peer</option>';
      for (const peerId of connectedPeers) {
        const option = document.createElement("option");
        option.value = peerId;
        option.textContent = peerId.substring(0, 12) + "...";
        sendPeerIdEl.appendChild(option);
      }
    }
  }

  // Set up the send message button
  const sendButton = document.getElementById("sendButton");
  const messageInput = document.getElementById("messageInput");
  const sendPeerIdEl = document.getElementById("sendPeerId");
  const messagesList = document.getElementById("messagesList");

  if (sendButton && messageInput && sendPeerIdEl && messagesList) {
    sendButton.addEventListener("click", () => {
      const selectedPeerId = sendPeerIdEl.value;
      const message = messageInput.value.trim();

      if (!selectedPeerId || !message) {
        updateStatus("Please select a peer and enter a message", true);
        return;
      }

      try {
        // Get the peer from our DHT
        const peer = dht.peers.get(selectedPeerId);
        if (!peer) {
          updateStatus(
            `Peer ${selectedPeerId.substring(0, 8)}... not found`,
            true
          );
          return;
        }

        // Send the message
        peer.send(message);
        console.log(`Sent to ${selectedPeerId.substring(0, 8)}...:`, message);

        // Add to the messages list with formatting
        const formattedMessage = formatMessage(selectedPeerId, message, true);
        messagesList.appendChild(formattedMessage);

        // Scroll to the bottom of the messages list
        messagesList.scrollTop = messagesList.scrollHeight;

        // Clear the message input
        messageInput.value = "";
      } catch (err) {
        console.error("Failed to send message:", err);
        updateStatus(`Failed to send: ${err.message}`, true);
      }
    });
  }
}

// Show SHA1 performance demonstration
async function demonstrateSHA1() {
  const resultEl = document.getElementById("result");
  resultEl.innerHTML = "";

  try {
    // Generate multiple peer IDs to demonstrate SHA1 performance
    const peers = [];
    const startTime = performance.now();

    // Generate 5 peer IDs in sequence
    for (let i = 0; i < 5; i++) {
      const id = await generateRandomId();
      peers.push(id);

      // Display each generated ID with better formatting
      const peerEl = document.createElement("div");
      peerEl.style.padding = "6px 0";
      peerEl.style.borderBottom = "1px solid #eaecef";
      peerEl.style.fontFamily = "monospace";
      peerEl.innerHTML = `<strong>Peer ${i + 1}:</strong> ${id.substring(
        0,
        8
      )}...${id.substring(
        id.length - 8
      )} <button class="button button-secondary" style="font-size: 12px; padding: 2px 6px; margin-left: 10px;" onclick="navigator.clipboard.writeText('${id}')">Copy</button>`;
      resultEl.appendChild(peerEl);
    }

    const endTime = performance.now();
    const timeEl = document.createElement("div");
    timeEl.style.marginTop = "10px";
    timeEl.textContent = `Generated 5 SHA1 peer IDs in ${(
      endTime - startTime
    ).toFixed(2)}ms`;
    resultEl.appendChild(timeEl);
  } catch (err) {
    resultEl.textContent = `Error in SHA1 demo: ${err.message}`;
  }
}

// Handle the tabbed interface
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const tabContents = document.querySelectorAll(".tab-content");

  if (!tabs.length) return; // No tabs found

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      // Remove active class from all tabs and contents
      tabs.forEach((t) => t.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));

      // Add active class to clicked tab and its content
      tab.classList.add("active");
      const tabId = tab.getAttribute("data-tab");
      document.getElementById(`${tabId}-content`).classList.add("active");
    });
  });
}

// Format messages for better display
function formatMessage(peerId, message, isOutgoing = false) {
  const listItem = document.createElement("li");
  listItem.className = isOutgoing ? "outgoing" : "incoming";

  if (isOutgoing) {
    listItem.textContent = `${message}`;
  } else {
    listItem.textContent = `${message}`;
  }

  return listItem;
}

// Start initialization when the document is loaded
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("status").textContent = "Initializing WebDHT...";
  let dht = initApp();

  // Set up the tabbed interface
  setupTabs();

  // If demo button exists, add event listener
  const demoButton = document.getElementById("demoButton");
  if (demoButton) {
    demoButton.addEventListener("click", demonstrateSHA1);
  }
});
