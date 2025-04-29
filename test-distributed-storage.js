#!/usr/bin/env node

import WebDHT from "./src/index.js";
import WebSocket from "ws";

// Configuration for test
const NUM_NODES = 4;         // Number of DHT nodes to create
const TEST_KEYS = [          // Test keys to store
  "test-key-1",
  "test-key-2",
  "test-key-3",
];
const TEST_VALUES = [        // Test values to store
  "test-value-1",
  "test-value-2",
  "test-value-3",
];
const REPLICATION_WAIT = 5000;  // Time to wait for replication (ms)
const CONNECT_WAIT = 1000;      // Time to wait between connections (ms)

// DHT nodes and node IDs
const nodes = [];
const nodeIds = [];

// Test results
let passedTests = 0;
let failedTests = 0;

// Create a logger with timestamps and color support
function createLogger(name, color) {
  const colorCodes = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    reset: "\x1b[0m",
  };
  
  return function log(...args) {
    const timestamp = new Date().toISOString().substring(11, 23);
    console.log(
      `${colorCodes[color] || ""}[${timestamp}][${name}]${colorCodes.reset}`,
      ...args
    );
  };
}

// Create a global logger
const logger = createLogger("TEST", "yellow");

// Initialize all nodes
async function initializeNodes() {
  logger("Initializing", NUM_NODES, "DHT nodes...");
  
  // Mock document for events
  global.document = {
    dispatchEvent: (event) => {
      logger(`Event dispatched: ${event.type}`);
    },
    addEventListener: () => {}, // no-op
  };
  
  global.CustomEvent = class CustomEvent {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts?.detail || {};
    }
  };
  
  for (let i = 0; i < NUM_NODES; i++) {
    const nodeLogger = createLogger(`NODE-${i+1}`, i % 2 === 0 ? "cyan" : "magenta");
    
    const dhtOptions = {
      k: 20,
      alpha: 3,
      bucketCount: 160,
      maxStoreSize: 100,
      replicateInterval: 1000,  // Use shorter intervals for testing
      republishInterval: 5000,
      maxPeers: 10,
      debug: true,
      dhtSignalThreshold: 2,
    };
    
    const node = new WebDHT(dhtOptions);
    
    // Add logging to node events
    node.on("peer:connect", (peerId) => {
      nodeLogger(`Peer connected: ${peerId.substring(0, 8)}...`);
    });
    
    node.on("peer:disconnect", (peerId) => {
      nodeLogger(`Peer disconnected: ${peerId.substring(0, 8)}...`);
    });
    
    node.on("value:stored", (data) => {
      nodeLogger(`Stored value for key: ${data.key.substring(0, 8)}...`);
    });
    
    // Enhanced debugging for network messages
    node.networkManager.on('message', (message, peerId) => {
      nodeLogger(`Network message: ${message.type} from/to peer: ${peerId?.substring(0, 8) || 'unknown'}`);
    });
    
    // Add specific handlers for storage-related messages
    node.networkManager.on('message:store', (data) => {
      nodeLogger(`STORE message received for key: ${data.key.substring(0, 8)}... from ${data.sender.substring(0, 8)}...`);
    });
    
    // Log replication events
    node.storageEngine.on('value:replicate', (data) => {
      nodeLogger(`Replicating key: ${data.key.substring(0, 8)}...`);
    });
    
    // Log republish events
    node.storageEngine.on('value:republish', (data) => {
      nodeLogger(`Republishing key: ${data.key.substring(0, 8)}...`);
    });
    
    // Log value request events
    node.storageEngine.on('value:requested', (data) => {
      nodeLogger(`Value requested: ${data.key.substring(0, 8)}...`);
    });
    
    nodes.push(node);
    
    // Wait for node to be ready
    await new Promise(resolve => {
      node.on("ready", (nodeId) => {
        nodeLogger("Node ready with ID:", nodeId.substring(0, 8) + "...");
        nodeIds.push(nodeId);
        resolve();
      });
    });
  }
  
  logger("All nodes initialized");
}

// Enhanced connection logging
function logPeerConnections() {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeLogger = createLogger(`NODE-${i+1}`, i % 2 === 0 ? "cyan" : "magenta");
    
    // Log PeerManager state
    const peerManagerPeers = node.peerManager.getConnectedPeerIds();
    nodeLogger(`PeerManager connected peers: [${Array.from(peerManagerPeers).map(id => id.substring(0, 8)).join(', ')}]`);
    
    // Log direct peers from node.peers
    const directPeers = Array.from(node.peers?.keys() || []);
    nodeLogger(`Direct connected peers: [${directPeers.map(id => id.substring(0, 8)).join(', ')}]`);
    
    // Log routing table state
    const routingPeers = node.routingTable.getAllNodes().map(n => n.id);
    nodeLogger(`Routing table nodes: [${routingPeers.map(id => id.substring(0, 8)).join(', ')}]`);
  }
}

// Connect nodes to form a network
async function connectNodes() {
  logger("Connecting nodes to form a network...");
  
  // Create a mesh network: each node connects to the next node in a ring
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeIdx = i;
    const targetIdx = (i + 1) % nodes.length;
    const targetId = nodeIds[targetIdx];
    
    logger(`Connecting node ${nodeIdx+1} to node ${targetIdx+1}...`);
    
    try {
      await node.connect({ id: targetId });
      logger(`Connected node ${nodeIdx+1} to node ${targetIdx+1}`);
    } catch (err) {
      logger(`Failed to connect node ${nodeIdx+1} to node ${targetIdx+1}: ${err.message}`);
    }
    
    // Wait between connections
    await new Promise(resolve => setTimeout(resolve, CONNECT_WAIT));
  }
  
  // Let's add some additional connections to make the network more connected
  // Each node will connect to node i+2 (wrapping around)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeIdx = i;
    const targetIdx = (i + 2) % nodes.length;  // Connect to node 2 steps ahead
    const targetId = nodeIds[targetIdx];
    
    logger(`Adding additional connection: node ${nodeIdx+1} to node ${targetIdx+1}...`);
    
    try {
      await node.connect({ id: targetId });
      logger(`Connected node ${nodeIdx+1} to node ${targetIdx+1}`);
    } catch (err) {
      logger(`Failed to connect node ${nodeIdx+1} to node ${targetIdx+1}: ${err.message}`);
    }
    
    // Wait between connections
    await new Promise(resolve => setTimeout(resolve, CONNECT_WAIT));
  }
  
  // Log the network topology
  logger("Network topology from PeerManager:");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const connectedPeers = Array.from(node.peerManager.getConnectedPeerIds());
    logger(`Node ${i+1} (${nodeIds[i].substring(0, 8)}...) is connected to: [${connectedPeers.map(id => id.substring(0, 8)).join(', ')}]`);
  }
  
  // Also log direct peers from the node.peers Map
  logger("Network topology from direct peer connections:");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const directPeers = Array.from(node.peers?.keys() || []);
    logger(`Node ${i+1} (${nodeIds[i].substring(0, 8)}...) direct peers: [${directPeers.map(id => id.substring(0, 8)).join(', ')}]`);
  }
}

// Store test values on the first node
async function storeTestValues() {
  logger("Storing test values on node 1...");
  const sourceNode = nodes[0];
  
  for (let i = 0; i < TEST_KEYS.length; i++) {
    const key = TEST_KEYS[i];
    const value = TEST_VALUES[i];
    
    logger(`Storing key: "${key}", value: "${value}"`);
    
    try {
      const keyHash = await sourceNode.put(key, value);
      logger(`Successfully stored "${key}" with hash ${keyHash.substring(0, 8)}...`);
    } catch (err) {
      logger(`Failed to store "${key}": ${err.message}`);
    }
  }
  
  // Check what's stored locally on each node before replication
  logger("Current storage state before waiting for replication:");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeLogger = createLogger(`NODE-${i+1}`, i % 2 === 0 ? "cyan" : "magenta");
    const storedKeys = node.storageEngine.getKeys();
    nodeLogger(`Has ${storedKeys.length} keys stored locally: [${storedKeys.map(k => k.substring(0, 8)).join(', ')}]`);
  }
  
  // Wait for replication to occur
  logger(`Waiting ${REPLICATION_WAIT}ms for replication...`);
  await new Promise(resolve => setTimeout(resolve, REPLICATION_WAIT));
  
  // Check what's stored locally on each node after replication
  logger("Current storage state after waiting for replication:");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeLogger = createLogger(`NODE-${i+1}`, i % 2 === 0 ? "cyan" : "magenta");
    const storedKeys = node.storageEngine.getKeys();
    nodeLogger(`Has ${storedKeys.length} keys stored locally: [${storedKeys.map(k => k.substring(0, 8)).join(', ')}]`);
  }
}

// Retrieve values from all nodes
async function retrieveValues() {
  logger("Retrieving values from all nodes...");
  
  for (let i = 0; i < TEST_KEYS.length; i++) {
    const key = TEST_KEYS[i];
    const expectedValue = TEST_VALUES[i];
    
    logger(`Testing retrieval of key: "${key}"`);
    
    // Try retrieving from each node
    for (let j = 0; j < nodes.length; j++) {
      const node = nodes[j];
      const nodeLogger = createLogger(`NODE-${j+1}`, j % 2 === 0 ? "cyan" : "magenta");
      
      try {
        nodeLogger(`Retrieving key: "${key}"`);
        const value = await node.get(key);
        
        if (value === expectedValue) {
          nodeLogger(`✅ Successfully retrieved "${key}" = "${value}"`);
          passedTests++;
        } else if (value === null) {
          nodeLogger(`❌ Key "${key}" not found`);
          failedTests++;
        } else {
          nodeLogger(`❌ Retrieved incorrect value for "${key}": expected "${expectedValue}", got "${value}"`);
          failedTests++;
        }
      } catch (err) {
        nodeLogger(`❌ Failed to retrieve "${key}": ${err.message}`);
        failedTests++;
      }
    }
  }
}

// Debug peer properties
function debugPeerObjects() {
  logger("Debugging peer objects:");
  
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeLogger = createLogger(`NODE-${i+1}`, i % 2 === 0 ? "cyan" : "magenta");
    
    if (node.peers) {
      for (const [peerId, peer] of node.peers.entries()) {
        const shortPeerId = peerId.substring(0, 8);
        nodeLogger(`Peer ${shortPeerId}... props: connected=${peer.connected}, destroyed=${peer._destroyed}`);
      }
    } else {
      nodeLogger("No peers property found on node");
    }
  }
}

// Report test results
function reportResults() {
  logger("------------------------------");
  logger("Test Results");
  logger("------------------------------");
  logger(`Total tests: ${passedTests + failedTests}`);
  logger(`Passed: ${passedTests}`);
  logger(`Failed: ${failedTests}`);
  logger("------------------------------");
  
  if (failedTests > 0) {
    logger("❌ Some tests failed!");
  } else {
    logger("✅ All tests passed!");
  }
  
  // Exit with appropriate code
  process.exit(failedTests === 0 ? 0 : 1);
}

// Run the tests
async function runTests() {
  try {
    logger("Starting distributed storage tests");
    logger("------------------------------");
    
    await initializeNodes();
    await connectNodes();
    
    // Debug peer properties after connections
    debugPeerObjects();
    
    // Log peer connections in detail
    logPeerConnections();
    
    await storeTestValues();
    
    // Debug peer properties before retrieving values
    debugPeerObjects();
    
    await retrieveValues();
    
    reportResults();
  } catch (err) {
    logger("Test failed with error:", err);
    process.exit(1);
  }
}

// Start the tests
runTests();