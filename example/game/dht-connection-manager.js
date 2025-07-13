/**
 * DHT Connection Manager - Shares DHT connections across browser tabs/pages
 */

// Storage keys for sharing DHT state
const DHT_STORAGE_KEYS = {
    CONNECTION_STATE: 'webdht_connection_state',
    PEER_ID: 'webdht_peer_id',
    SIGNALING_URL: 'webdht_signaling_url',
    PEER_LIST: 'webdht_peer_list'
};

class DHTConnectionManager {
    constructor() {
        this.dht = null;
        this.isConnected = false;
        this.signalingUrl = null;
        this.peerId = null;
        this.connectedPeers = new Set();
        
        // Listen for storage events to sync across tabs
        window.addEventListener('storage', (e) => {
            this.handleStorageChange(e);
        });
        
        // Check for existing connection on init
        this.checkExistingConnection();
    }
    
    checkExistingConnection() {
        const connectionState = localStorage.getItem(DHT_STORAGE_KEYS.CONNECTION_STATE);
        const peerId = localStorage.getItem(DHT_STORAGE_KEYS.PEER_ID);
        const signalingUrl = localStorage.getItem(DHT_STORAGE_KEYS.SIGNALING_URL);
        
        if (connectionState === 'connected' && peerId && signalingUrl) {
            console.log('Found existing DHT connection info, connecting to same network...');
            this.signalingUrl = signalingUrl;
            // Note: We'll create a new connection to the same network rather than 
            // trying to share the exact same WebRTC connections
            return { signalingUrl, peerId };
        }
        
        return null;
    }
    
    async attemptConnectionReuse() {
        try {
            // Try to create a new DHT instance with the same configuration
            // This won't reuse the exact same connection but will connect to the same network
            const WebDHT = (await import('../src/index.js')).default;
            
            this.dht = new WebDHT({
                signalingUrl: this.signalingUrl,
                nodeId: this.peerId, // Try to reuse the same node ID
                debug: true
            });
            
            // Set up event listeners
            this.setupDHTEventListeners();
            
            // Connect to the network
            await this.dht.connect();
            
            console.log('Successfully reused DHT connection');
            return true;
            
        } catch (error) {
            console.error('Failed to reuse DHT connection:', error);
            // Clear invalid connection state
            this.clearConnectionState();
            return false;
        }
    }
    
    async createNewConnection(signalingUrl, options = {}) {
        try {
            const WebDHT = (await import('../src/index.js')).default;
            
            this.dht = new WebDHT({
                debug: true,
                ...options
            });
            
            this.signalingUrl = signalingUrl;
            
            // Set up event listeners
            this.setupDHTEventListeners();
            
            // Wait for DHT to be ready
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('DHT initialization timeout'));
                }, 10000);
                
                this.dht.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            
            // Now set up transport connection using the API
            const { initializeApi } = await import('../src/api.js');
            const transportManager = (await import('../transports/index.js')).default;
            
            // Initialize API with a simple adapter
            initializeApi(this.dht, {
                updateStatus: (msg) => console.log('DHT Status:', msg),
                updatePeerList: (peers) => console.log('Available peers:', peers?.length || 0),
                addMessage: () => {},
                updateConnectedPeers: (peers) => {
                    if (peers && peers.length > 0) {
                        this.connectedPeers.clear();
                        peers.forEach(p => this.connectedPeers.add(p));
                        this.updatePeerList();
                    }
                }
            }, true);
            
            // Create WebSocket transport
            const transport = transportManager.create('websocket', {
                url: signalingUrl,
                autoReconnect: true,
                debug: true
            });
            
            // Set up transport event listeners
            transport.on('connect', () => {
                console.log('Connected to signaling server');
            });
            
            transport.on('registered', (peerId, peers) => {
                console.log(`Registered with ID: ${peerId}, Available peers: ${peers?.length || 0}`);
                this.peerId = peerId;
                this.isConnected = true;
                this.saveConnectionState();
            });
            
            // Connect to the transport
            await transport.connect();
            
            return true;
            
        } catch (error) {
            console.error('Failed to create new DHT connection:', error);
            throw error;
        }
    }
    
    setupDHTEventListeners() {
        if (!this.dht) return;
        
        this.dht.on('ready', (nodeId) => {
            console.log('DHT ready with node ID:', nodeId);
            this.peerId = nodeId;
        });
        
        this.dht.on('peer_connected', (peerId) => {
            this.connectedPeers.add(peerId);
            this.updatePeerList();
            console.log('DHT peer connected:', peerId);
        });
        
        this.dht.on('peer_disconnected', (peerId) => {
            this.connectedPeers.delete(peerId);
            this.updatePeerList();
            console.log('DHT peer disconnected:', peerId);
        });
    }
    
    saveConnectionState(connectionInfo = null) {
        if (connectionInfo) {
            // Save external connection info
            localStorage.setItem(DHT_STORAGE_KEYS.CONNECTION_STATE, 'connected');
            localStorage.setItem(DHT_STORAGE_KEYS.PEER_ID, connectionInfo.peerId);
            localStorage.setItem(DHT_STORAGE_KEYS.SIGNALING_URL, connectionInfo.signalingUrl);
        } else {
            // Save own connection state
            localStorage.setItem(DHT_STORAGE_KEYS.CONNECTION_STATE, 'connected');
            localStorage.setItem(DHT_STORAGE_KEYS.PEER_ID, this.peerId);
            localStorage.setItem(DHT_STORAGE_KEYS.SIGNALING_URL, this.signalingUrl);
        }
        this.updatePeerList();
    }
    
    updatePeerList() {
        const peerArray = Array.from(this.connectedPeers);
        localStorage.setItem(DHT_STORAGE_KEYS.PEER_LIST, JSON.stringify(peerArray));
    }
    
    clearConnectionState() {
        localStorage.removeItem(DHT_STORAGE_KEYS.CONNECTION_STATE);
        localStorage.removeItem(DHT_STORAGE_KEYS.PEER_ID);
        localStorage.removeItem(DHT_STORAGE_KEYS.SIGNALING_URL);
        localStorage.removeItem(DHT_STORAGE_KEYS.PEER_LIST);
    }
    
    handleStorageChange(event) {
        // Handle changes from other tabs
        if (event.key === DHT_STORAGE_KEYS.CONNECTION_STATE) {
            if (event.newValue === 'connected' && !this.isConnected) {
                // Another tab connected, try to sync
                this.checkExistingConnection();
            } else if (event.newValue === null && this.isConnected) {
                // Connection was cleared, disconnect
                this.disconnect();
            }
        }
    }
    
    async connect(signalingUrl) {
        // First check if we have connection info from another tab
        const existingConnection = this.checkExistingConnection();
        
        if (existingConnection) {
            // Connect to the same network as the other tab
            console.log('Connecting to same DHT network as other tab...');
            await this.createNewConnection(existingConnection.signalingUrl);
            return this.dht;
        }
        
        // Create new connection
        await this.createNewConnection(signalingUrl);
        return this.dht;
    }
    
    disconnect() {
        if (this.dht) {
            this.dht.disconnect();
            this.dht = null;
        }
        this.isConnected = false;
        this.clearConnectionState();
    }
    
    getDHT() {
        return this.dht;
    }
    
    getConnectionInfo() {
        return {
            isConnected: this.isConnected,
            peerId: this.peerId,
            signalingUrl: this.signalingUrl,
            connectedPeers: Array.from(this.connectedPeers)
        };
    }
}

// Create a singleton instance
const dhtConnectionManager = new DHTConnectionManager();

export default dhtConnectionManager;
