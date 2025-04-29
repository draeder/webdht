import Peer from '../peer.js';
import { KADEMLIA_MESSAGE_TYPES } from '../constants.js';
import EventEmitter from '../event-emitter.js';

export class NetworkManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.peers = new Map();
    this.messageHandlers = new Map();
    this.debug = options.debug || false;
    this.nodeId = options.nodeId;
    this.simplePeerOptions = options.simplePeerOptions || {};
    
    // Register core message handlers
    this.registerMessageHandler('PING', this.handlePing.bind(this));
    this.registerMessageHandler('STORE', this.handleStore.bind(this));
    this.registerMessageHandler('FIND_NODE', this.handleFindNode.bind(this));
    this.registerMessageHandler('FIND_NODE_RESPONSE', this.handleFindNodeResponse.bind(this));
    this.registerMessageHandler('FIND_VALUE', this.handleFindValue.bind(this));
    this.registerMessageHandler('FIND_VALUE_RESPONSE', this.handleFindValueResponse.bind(this));
    this.registerMessageHandler('SIGNAL', this.handleSignal.bind(this));
  }

  async connect(peerInfo) {
    if (this.peers.has(peerInfo.id)) {
      return this.peers.get(peerInfo.id);
    }

    const peer = new Peer({
      id: peerInfo.id,
      simplePeerOptions: this.simplePeerOptions,
      debug: this.debug
    });

    this.peers.set(peerInfo.id, peer);
    
    peer.on('connect', () => {
      if (this.debug) console.debug(`[NetworkManager] Peer ${peerInfo.id.substring(0, 8)}... connected`);
      this.handlePeerConnect(peer);
      this.emit('peer:connect', peerInfo.id, peer);
    });
    
    peer.on('data', (data) => this.handlePeerData(peer, data));
    
    peer.on('close', () => {
      if (this.debug) console.debug(`[NetworkManager] Peer ${peerInfo.id.substring(0, 8)}... disconnected`);
      this.handlePeerDisconnect(peer);
      this.emit('peer:disconnect', peerInfo.id);
    });
    
    peer.on('error', (err) => {
      if (this.debug) console.debug(`[NetworkManager] Peer ${peerInfo.id.substring(0, 8)}... error:`, err.message);
      this.emit('peer:error', peerInfo.id, err);
    });

    if (peerInfo.signal) {
      await peer.signal(peerInfo.signal);
    }

    return peer;
  }

  registerMessageHandler(type, handler) {
    if (!Object.values(KADEMLIA_MESSAGE_TYPES).includes(type)) {
      throw new Error(`Invalid message type: ${type}`);
    }
    this.messageHandlers.set(type, handler);
  }

  sendMessage(targetId, message) {
    const peer = this.peers.get(targetId);
    if (peer?.connected) {
      peer.send(message);
      return true;
    }
    return false;
  }

  broadcast(message, filter = () => true) {
    Array.from(this.peers.values())
      .filter(p => p.connected && filter(p))
      .forEach(p => p.send(message));
  }

  handlePeerConnect(peer) {
    // Exchange routing information on connect
    if (peer.connected) {
      try {
        peer.send({ type: 'PING', sender: this.nodeId });
        if (this.debug) console.debug(`[NetworkManager] Sent PING to peer ${peer.id.substring(0, 8)}...`);
      } catch (err) {
        console.error(`[NetworkManager] Error sending PING to peer ${peer.id.substring(0, 8)}...`, err);
      }
    } else {
      if (this.debug) console.debug(`[NetworkManager] Cannot send PING, peer ${peer.id.substring(0, 8)}... not connected`);
    }
  }

  handlePeerData(peer, data) {
    try {
      let message;
      if (typeof data === 'string') {
        message = JSON.parse(data);
      } else if (data instanceof Buffer || data instanceof Uint8Array) {
        message = JSON.parse(data.toString());
      } else if (typeof data === 'object') {
        message = data;
      } else {
        throw new Error(`Unknown data format: ${typeof data}`);
      }
      
      if (this.debug) console.debug(`[NetworkManager] Received ${message.type} from ${peer.id.substring(0, 8)}...`);
      
      // Emit a general message event for debugging/logging
      this.emit('message', message, peer.id);
      
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        handler(message, peer.id);
      } else {
        console.warn(`[NetworkManager] No handler for message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error handling peer data:', error);
    }
  }

  handlePeerDisconnect(peer) {
    if (this.debug) console.debug(`[NetworkManager] Handling disconnect for peer ${peer.id.substring(0, 8)}...`);
    this.peers.delete(peer.id);
  }

  // Core message handlers
  handlePing(message, peerId) {
    this.sendMessage(peerId, { 
      type: 'PONG', 
      sender: this.nodeId,
      timestamp: Date.now() 
    });
  }

  handleStore(message, peerId) {
    // Forward to storage engine via event
    this.emit('store', {
      key: message.key,
      value: message.value,
      publisher: peerId,
      timestamp: message.timestamp
    });
  }

  handleFindNode(message, peerId) {
    // Forward to routing table via event
    this.emit('find-node', {
      target: message.target,
      requester: peerId
    });
  }

  handleSignal(message, peerId) {
    // Forward to signaling system via event
    this.emit('signal', {
      signal: message.signal,
      target: message.target,
      viaDht: message.viaDht,
      originalSender: message.originalSender,
      ttl: message.ttl
    });
  }
  
  handleFindValue(message, peerId) {
    // Forward to DHT for lookup in local storage
    this.emit('message:find_value', {
      key: message.key,
      requester: peerId,
      lookupId: message.lookupId
    });
  }
  
  handleFindValueResponse(message, peerId) {
    // Emit the response to be handled by the DHT
    this.emit('message:find_value_response', {
      key: message.key,
      value: message.value,
      sender: peerId,
      lookupId: message.lookupId
    });
  }
  
  handleFindNodeResponse(message, peerId) {
    // Emit the response to be handled by the DHT
    this.emit('message:find_node_response', {
      key: message.key,
      nodes: message.nodes,
      sender: peerId,
      lookupId: message.lookupId
    });
  }

  findRoute(targetId) {
    // Check direct connection first
    if (this.peers.has(targetId)) {
      return [{ peerId: targetId, hops: 0 }];
    }

    // Check DHT routes
    const routes = [];
    for (const [sourceId, peers] of this.dhtRoutes) {
      if (peers.has(targetId)) {
        routes.push({ peerId: sourceId, hops: 1 });
      }
    }
    return routes;
  }
}