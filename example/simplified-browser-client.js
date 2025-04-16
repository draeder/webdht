/**
 * Simplified DHT Browser Integration
 * This file demonstrates how to use the simplified DHT in a browser environment
 */

// SimplifiedDHT integration for browser signaling example
class SimplifiedDHTClient {
  constructor() {
    // Create SimplifiedDHT instance
    this.dht = new SimplifiedDHT({
      debug: true
    });
    
    this.connectedPeers = new Map();
    this.socket = null;
    
    this.initUI();
  }
  
  initUI() {
    // Create DHT operations interface
    this.createDHTInterface();
    
    // Initialize signaling connection
    this.initSignalingConnection();
  }
  
  createDHTInterface() {
    // Create a simple UI for DHT operations if it doesn't exist
    if (!document.getElementById('dht-operations')) {
      const container = document.createElement('div');
      container.id = 'dht-operations';
      container.style = 'margin-top: 20px; border: 1px solid #ccc; padding: 10px; border-radius: 5px;';
      
      const heading = document.createElement('h3');
      heading.textContent = 'Simplified DHT Operations';
      container.appendChild(heading);
      
      // Key input
      const keyLabel = document.createElement('label');
      keyLabel.textContent = 'Key: ';
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.id = 'dht-key';
      container.appendChild(keyLabel);
      container.appendChild(keyInput);
      container.appendChild(document.createElement('br'));
      
      // Value input
      const valueLabel = document.createElement('label');
      valueLabel.textContent = 'Value: ';
      const valueInput = document.createElement('textarea');
      valueInput.id = 'dht-value';
      valueInput.rows = 3;
      valueInput.style = 'width: 80%; margin-top: 5px;';
      container.appendChild(valueLabel);
      container.appendChild(document.createElement('br'));
      container.appendChild(valueInput);
      container.appendChild(document.createElement('br'));
      
      // Buttons
      const putButton = document.createElement('button');
      putButton.textContent = 'Store Value (PUT)';
      putButton.onclick = () => this.putValue();
      
      const getButton = document.createElement('button');
      getButton.textContent = 'Retrieve Value (GET)';
      getButton.onclick = () => this.getValue();
      
      container.appendChild(putButton);
      container.appendChild(' ');
      container.appendChild(getButton);
      
      // Result display
      const resultDiv = document.createElement('div');
      resultDiv.id = 'dht-result';
      resultDiv.style = 'margin-top: 10px; padding: 10px; background: #f5f5f5; min-height: 50px;';
      container.appendChild(resultDiv);
      
      // Add to document
      document.body.appendChild(container);
    }
  }
  
  initSignalingConnection() {
    // Listen for peer connections
    document.addEventListener('webdht-peer-connected', (event) => {
      const peerId = event.detail.peerId;
      const peerObj = event.detail.peer; // This is the WebRTC peer
      
      // Create a wrapper peer object for our SimplifiedDHT
      const dhtPeer = {
        send: (message) => {
          try {
            // Convert to string if needed
            const strMessage = typeof message === 'string' ? 
              message : JSON.stringify(message);
            
            // Send via the WebRTC peer
            peerObj.send(strMessage);
            return true;
          } catch (err) {
            console.error(`Error sending to peer ${peerId.substring(0, 8)}...`, err);
            return false;
          }
        },
        connected: true
      };
      
      // Add to our DHT
      this.dht.addPeer(peerId, dhtPeer);
      this.connectedPeers.set(peerId, dhtPeer);
      
      // Show message
      this.showResult(`Connected to peer: ${peerId.substring(0, 8)}...`);
      
      // Setup message handler for this peer
      peerObj.on('data', (data) => {
        try {
          // Parse the data if it's a string
          const message = typeof data === 'string' ? JSON.parse(data) : data;
          
          // Process in DHT
          this.dht.handleMessage(message, peerId);
        } catch (err) {
          console.error('Error processing peer message', err);
        }
      });
    });
    
    // Listen for peer disconnections
    document.addEventListener('webdht-peer-disconnected', (event) => {
      const peerId = event.detail.peerId;
      
      // Remove from DHT
      if (this.connectedPeers.has(peerId)) {
        this.dht.removePeer(peerId);
        this.connectedPeers.delete(peerId);
      }
    });
  }
  
  async putValue() {
    const keyElem = document.getElementById('dht-key');
    const valueElem = document.getElementById('dht-value');
    
    if (!keyElem || !valueElem) return;
    
    const key = keyElem.value.trim();
    const value = valueElem.value;
    
    if (!key) {
      this.showResult('Please enter a key');
      return;
    }
    
    try {
      this.showResult(`Storing key "${key}"...`);
      await this.dht.put(key, value);
      this.showResult(`Successfully stored key "${key}" with value "${value}"`);
    } catch (err) {
      this.showResult(`Error storing value: ${err.message}`);
    }
  }
  
  async getValue() {
    const keyElem = document.getElementById('dht-key');
    if (!keyElem) return;
    
    const key = keyElem.value.trim();
    if (!key) {
      this.showResult('Please enter a key to retrieve');
      return;
    }
    
    try {
      this.showResult(`Retrieving key "${key}"...`);
      const result = await this.dht.get(key);
      
      if (result !== null) {
        this.showResult(`Retrieved value for key "${key}": "${result}"`);
      } else {
        this.showResult(`No value found for key "${key}"`);
      }
    } catch (err) {
      this.showResult(`Error retrieving value: ${err.message}`);
    }
  }
  
  showResult(message) {
    const resultElem = document.getElementById('dht-result');
    if (resultElem) {
      resultElem.textContent = message;
    }
  }
}

// Create and expose the SimplifiedDHT client
window.simplifiedDHTClient = new SimplifiedDHTClient();
