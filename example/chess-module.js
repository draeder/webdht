/**
 * Chess Module for WebDHT Browser Example
 * Integrates chess game functionality with the main DHT instance
 * 
 * This module implements a FULLY DHT-BASED chess matchmaking and gameplay system:
 * 
 * MATCHMAKING:
 * - Players wanting a game read the 'chess_matchmaking' DHT key (shared array)
 * - They add themselves to the array if not already present
 * - When exactly 2 players are in the array, they match and both remove themselves
 * - Game starts automatically with deterministic color assignment based on player IDs
 * 
 * GAMEPLAY:
 * - All moves are stored in DHT under unique move keys and in the game state
 * - Game state is continuously updated in DHT under the game ID
 * - Opponent moves are detected by polling DHT game state
 * - Game actions (resign, draw offers, rematch) stored in DHT under specific keys
 * 
 * NO PEER-TO-PEER MESSAGING:
 * - All communication happens through DHT storage and polling
 * - No direct peer connections required for chess functionality
 * - Purely distributed and decentralized approach
 */

import { ChessEngine, PIECES, COLORS, GAME_STATES, PIECE_SYMBOLS } from "./game/chess-engine.js";

// Game configuration
const GAME_CONFIG = {
    MATCHMAKING_KEY: 'chess_matchmaking',
    GAME_TIMEOUT: 30000, // 30 seconds for game responses
    HEARTBEAT_INTERVAL: 5000, // 5 seconds
    TIME_CONTROL: 15 * 60 * 1000, // 15 minutes per player
};

// Message types
const MESSAGE_TYPES = {
    GAME_INVITE: 'game_invite',
    GAME_ACCEPT: 'game_accept',
    GAME_DECLINE: 'game_decline',
    GAME_START: 'game_start',
    MOVE: 'move',
    CHAT: 'chat',
    RESIGN: 'resign',
    DRAW_OFFER: 'draw_offer',
    DRAW_ACCEPT: 'draw_accept',
    DRAW_DECLINE: 'draw_decline',
    HEARTBEAT: 'heartbeat',
    REMATCH: 'rematch'
};

export class ChessModule {
    constructor(dht) {
        // Prevent multiple instances
        if (window.chessModuleInstance) {
            console.warn('Chess: Multiple ChessModule instances detected - this may cause issues');
        }
        window.chessModuleInstance = this;
        
        this.dht = dht;
        this.engine = new ChessEngine();
        this.gameId = null;
        this.opponentId = null;
        this.playerColor = null;
        this.gameState = 'disconnected';
        this.selectedSquare = null;
        this.validMoves = [];
        this.isSearching = false;
        this.gameInvites = new Map();
        this.timeLeft = { white: GAME_CONFIG.TIME_CONTROL, black: GAME_CONFIG.TIME_CONTROL };
        this.gameTimer = null;
        this.lastMoveTime = null;
        this.invitePollingInterval = null;
        this.movePollingInterval = null;
        this.matchmakingInterval = null;
        this.lastProcessedMoveTime = 0;
        this.isChessTabActive = false;
        this.lastKnownOpponent = null;
        this.handshakeTimeout = null;
        
        // Gossip protocol for real-time move synchronization
        this.gossipEnabled = true;
        this.gossipMoveQueue = new Map(); // gameId -> array of pending moves
        this.processedGossipMoves = new Set(); // track processed move IDs to avoid duplicates
        this.uiInitialized = false;
        
        // Game start handshake tracking
        this.gameStartHandshake = {
            sentConfirmation: false,
            receivedConfirmation: false,
            opponentId: null,
            gameId: null
        };

        // Check if chess tab is currently active
        this.checkInitialTabState();
        
        // Only initialize UI if chess tab is active, otherwise defer until activation
        if (this.isChessTabActive) {
            this.initializeUI();
        }
        
        this.bindDHTEvents();
        this.setupGossipListeners();
        // Don't start polling automatically - only when chess tab is active
    }

    checkInitialTabState() {
        // Check if chess tab is currently active during initialization
        const chessTab = document.querySelector('.tab[data-tab="chess"]');
        const chessContent = document.getElementById('chess-content');
        
        this.isChessTabActive = chessTab?.classList.contains('active') && 
                                chessContent?.classList.contains('active');
        
        console.log('Chess: Initial tab state check - chess tab active:', this.isChessTabActive);
    }

    initializeUI() {
        // Prevent multiple initializations
        if (this.uiInitialized) {
            console.log('Chess: UI already initialized, skipping');
            return;
        }

        console.log('Chess: Initializing UI');
        
        // Cache UI elements
        this.ui = {
            findGameBtn: document.getElementById('findGameBtn'),
            cancelSearchBtn: document.getElementById('cancelSearchBtn'),
            searchStatus: document.getElementById('searchStatus'),
            gameInvites: document.getElementById('gameInvites'),
            gamesList: document.getElementById('gamesList'),
            chessGameStatus: document.getElementById('chessGameStatus'),
            whitePlayer: document.getElementById('whitePlayer'),
            blackPlayer: document.getElementById('blackPlayer'),
            whiteTime: document.getElementById('whiteTime'),
            blackTime: document.getElementById('blackTime'),
            chessBoard: document.getElementById('chessBoard'),
            resignBtn: document.getElementById('resignBtn'),
            drawBtn: document.getElementById('drawBtn'),
            rematchBtn: document.getElementById('rematchBtn'),
            moveHistory: document.getElementById('moveHistory')
        };

        // Only create board and update state if UI elements are available
        if (this.ui.chessBoard) {
            this.createBoard();
        }
        
        this.updateGameState();
        this.uiInitialized = true;
        
        // Set up event listeners after UI elements are cached
        this.setupEventListeners();
        
        console.log('Chess: UI initialization complete');
    }

    setupEventListeners() {
        // Only set up event listeners if UI is initialized
        if (!this.ui) {
            console.log('Chess: Skipping setupEventListeners - UI not initialized');
            return;
        }
        
        // Button event listeners
        this.ui.findGameBtn?.addEventListener('click', () => this.findGame());
        this.ui.cancelSearchBtn?.addEventListener('click', () => this.cancelSearch());
        this.ui.resignBtn?.addEventListener('click', () => this.resign());
        this.ui.drawBtn?.addEventListener('click', () => this.offerDraw());
        this.ui.rematchBtn?.addEventListener('click', () => this.requestRematch());
    }

    bindDHTEvents() {
        if (!this.dht) return;

        // Update UI when DHT state changes
        this.dht.on('ready', () => {
            console.log('Chess: DHT ready event received');
            this.updateConnectionState();
        });

        this.dht.on('peer:connected', (peerId) => {
            console.log('Chess: Peer connected:', peerId?.substring(0, 8));
            if (peerId === this.opponentId) {
                console.log('Chess: OPPONENT CONNECTED! Can now use direct gossip messaging');
            }
            this.updateConnectionState();
        });

        this.dht.on('peer:disconnected', (peerId) => {
            console.log('Chess: Peer disconnected:', peerId?.substring(0, 8));
            if (peerId === this.opponentId) {
                console.log('Chess: OPPONENT DISCONNECTED! Will rely on DHT fallback');
            }
            this.updateConnectionState();
        });
        
        // Additional connection monitoring
        this.dht.on('peer:error', (err, peerId) => {
            // Only log peer errors if someone is actually on the chess tab to avoid spam
            if (this.isChessTabActive) {
                console.error('Chess: Peer error for', peerId ? peerId.substring(0, 8) : 'unknown', ':', err);
            }
        });
    }

    setupGossipListeners() {
        if (!this.dht) return;

        // Listen for incoming gossip messages from peers
        this.dht.on('peer:message', ({ message, peerId }) => {
            if (message.type === 'CHESS_GOSSIP') {
                this.handleGossipMessage(message, peerId);
            }
        });
    }

    updateConnectionState() {
        // For DHT-based chess, we just need the DHT instance to exist
        const isReady = !!this.dht;
        
        console.log('Chess Module - Connection State:', {
            dhtExists: !!this.dht,
            isReady: isReady,
            isSearching: this.isSearching,
            gameState: this.gameState,
            hasGameId: !!this.gameId
        });
        
        if (this.ui && this.ui.findGameBtn) {
            // Update button based on current state
            if (this.gameState === 'playing') {
                this.ui.findGameBtn.disabled = true;
                this.ui.findGameBtn.textContent = 'Game Active';
            } else if (!isReady) {
                this.ui.findGameBtn.disabled = true;
                this.ui.findGameBtn.textContent = 'DHT Not Available';
            } else if (this.isSearching) {
                this.ui.findGameBtn.disabled = true;
                this.ui.findGameBtn.textContent = 'Searching...';
            } else {
                this.ui.findGameBtn.disabled = false;
                this.ui.findGameBtn.textContent = 'Find Game';
            }
        }

        if (this.ui && this.ui.cancelSearchBtn) {
            this.ui.cancelSearchBtn.disabled = !this.isSearching;
        }
    }

    createBoard() {
        if (!this.ui.chessBoard) return;

        this.ui.chessBoard.innerHTML = '';
        
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const square = document.createElement('div');
                square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.row = row; // Display coordinates
                square.dataset.col = col;
                
                square.addEventListener('click', (e) => {
                    this.handleSquareClick(row, col); // Pass display coordinates
                });

                this.ui.chessBoard.appendChild(square);
            }
        }

        this.updateBoard();
    }

    updateBoard() {
        console.log('Chess: updateBoard called');
        
        if (!this.ui || !this.ui.chessBoard) {
            console.log('Chess: Cannot update board - no UI or chessBoard element');
            // Try to find the chess board element directly
            const chessBoardElement = document.getElementById('chessBoard');
            if (chessBoardElement) {
                console.log('Chess: Found chess board element, updating UI cache');
                this.ui = this.ui || {};
                this.ui.chessBoard = chessBoardElement;
            } else {
                console.log('Chess: Chess board element not found in DOM');
                return;
            }
        }

        const squares = this.ui.chessBoard.querySelectorAll('.chess-square');
        console.log('Chess: Found', squares.length, 'squares on board');
        
        if (squares.length === 0) {
            console.log('Chess: No squares found, board may not be created yet');
            return;
        }
        
        // Determine if we need to flip the board (black player sees black pieces at bottom)
        const isFlipped = this.playerColor === COLORS.BLACK;
        console.log('Chess: Board flipped:', isFlipped, 'playerColor:', this.playerColor);
        
        squares.forEach((square, index) => {
            const row = Math.floor(index / 8);
            const col = index % 8;
            
            // Get the actual board position (accounting for flip)
            const boardRow = isFlipped ? 7 - row : row;
            const boardCol = isFlipped ? 7 - col : col;
            const piece = this.engine.board[boardRow][boardCol];
            
            // Clear previous states
            square.classList.remove('selected', 'valid-move', 'last-move', 'in-check');
            
            // Add piece or clear
            if (piece) {
                square.textContent = PIECE_SYMBOLS[piece.color][piece.type];
            } else {
                square.textContent = '';
            }
            
            // Highlight selected square
            if (this.selectedSquare && this.selectedSquare.row === boardRow && this.selectedSquare.col === boardCol) {
                square.classList.add('selected');
            }
            
            // Highlight valid moves
            if (this.validMoves.some(move => {
                // Handle both array format [row, col] and object format {toRow, toCol}
                const moveRow = Array.isArray(move) ? move[0] : move.toRow;
                const moveCol = Array.isArray(move) ? move[1] : move.toCol;
                return moveRow === boardRow && moveCol === boardCol;
            })) {
                square.classList.add('valid-move');
            }
            
            // Highlight last move
            if (this.engine.lastMove) {
                const { fromRow, fromCol, toRow, toCol } = this.engine.lastMove;
                if ((boardRow === fromRow && boardCol === fromCol) || (boardRow === toRow && boardCol === fromCol)) {
                    square.classList.add('last-move');
                }
            }
            
            // Highlight king in check
            if (this.engine.gameState === GAME_STATES.CHECK) {
                const kingPos = this.engine.findKing(this.engine.currentPlayer);
                if (kingPos && boardRow === kingPos.row && boardCol === kingPos.col) {
                    square.classList.add('in-check');
                }
            }
        });
        
        console.log('Chess: Board updated successfully');
    }

    handleSquareClick(row, col) {
        if (this.gameState !== 'playing' || this.engine.currentPlayer !== this.playerColor) {
            return;
        }

        // Convert display coordinates to board coordinates if board is flipped
        const isFlipped = this.playerColor === COLORS.BLACK;
        const boardRow = isFlipped ? 7 - row : row;
        const boardCol = isFlipped ? 7 - col : col;

        const piece = this.engine.board[boardRow][boardCol];
        
        // If clicking on a valid move square
        if (this.selectedSquare && this.validMoves.some(move => {
            // Handle both array format [row, col] and object format {toRow, toCol}
            const moveRow = Array.isArray(move) ? move[0] : move.toRow;
            const moveCol = Array.isArray(move) ? move[1] : move.toCol;
            return moveRow === boardRow && moveCol === boardCol;
        })) {
            this.makeMove(this.selectedSquare.row, this.selectedSquare.col, boardRow, boardCol);
            this.selectedSquare = null;
            this.validMoves = [];
        }
        // If clicking on own piece
        else if (piece && piece.color === this.playerColor) {
            this.selectedSquare = { row: boardRow, col: boardCol };
            this.validMoves = this.engine.getValidMoves(boardRow, boardCol);
        }
        // Clear selection
        else {
            this.selectedSquare = null;
            this.validMoves = [];
        }
        
        this.updateBoard();
    }

    makeMove(fromRow, fromCol, toRow, toCol) {
        console.log('Chess: Making move:', { fromRow, fromCol, toRow, toCol });
        
        // Debug connection state before making move
        console.log('Chess: Connection state before move:');
        this.debugConnectionState();
        
        const result = this.engine.makeMove(fromRow, fromCol, toRow, toCol);
        
        if (result && result.success) {
            console.log('Chess: Move successful:', result);
            
            // Switch timer to the next player
            this.switchPlayerTimer();
            
            // Send move via gossip protocol for real-time synchronization
            this.sendMoveViaGossip(result.move).then(success => {
                if (success) {
                    console.log('Chess: Move sent via gossip successfully');
                } else {
                    console.error('Chess: Move failed to send via gossip');
                }
            }).catch(err => {
                console.error('Chess: Error sending move via gossip:', err);
            });
            
            // Also store the move in DHT for persistence
            this.storeMoveInDHT(result.move);
            
            this.updateMoveHistory();
            this.updateGameState();
            this.updateBoard();
            
            // Update game state in DHT
            this.storeGameState();
            
            // Check for game end
            if (this.engine.gameState === GAME_STATES.CHECKMATE) {
                this.endGame(`${this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White'} wins by checkmate!`);
            } else if (this.engine.gameState === GAME_STATES.STALEMATE) {
                this.endGame('Game ends in stalemate!');
            } else if (this.engine.gameState === GAME_STATES.DRAW) {
                this.endGame('Game ends in a draw!');
            }
        } else {
            console.log('Chess: Move failed - invalid move. Result:', result);
        }
    }

    async storeMoveInDHT(move) {
        if (!this.gameId) return;
        
        const moveKey = `${this.gameId}_move_${Date.now()}`;
        const moveData = {
            gameId: this.gameId,
            move: move,
            playerId: this.dht.nodeId,
            timestamp: Date.now()
        };

        try {
            console.log('Chess: Storing move in DHT with key:', moveKey);
            await this.dht.put(moveKey, JSON.stringify(moveData));
            console.log('Chess: Move stored successfully');
        } catch (err) {
            console.error('Chess: Error storing move:', err);
        }
    }

    // Gossip Protocol Methods

    async sendMoveViaGossip(move) {
        if (!this.gossipEnabled || !this.opponentId || !this.gameId) {
            console.log('Chess: Gossip disabled or no opponent for move gossip');
            return;
        }

        const moveId = `${this.gameId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const gossipMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'MOVE',
            gameId: this.gameId,
            moveId: moveId,
            move: move,
            playerId: this.dht.nodeId,
            timestamp: Date.now()
        };

        console.log('Chess: Sending move via gossip to opponent:', this.opponentId.substring(0, 8));
        this.monitorPeerConnectivity();
        
        // Try to send the move with multiple strategies
        const success = await this.sendGossipMessage(gossipMessage, this.opponentId);
        
        if (!success) {
            console.error('Chess: Failed to send move via gossip - move may be lost!');
            return false;
        }
        
        console.log('Chess: Move sent successfully via gossip/DHT');
        return true;
    }

    async sendGossipMessage(message, targetPeerId) {
        if (!this.dht || !targetPeerId) {
            console.error('Chess: Cannot send gossip message - no DHT or target peer');
            return false;
        }

        // Enhanced debugging for peer connectivity
        console.log('Chess: Attempting to send gossip message to:', targetPeerId.substring(0, 8));
        console.log('Chess: DHT peers count:', this.dht.peers ? this.dht.peers.size : 'no peers');
        console.log('Chess: DHT peer IDs:', this.dht.peers ? Array.from(this.dht.peers.keys()).map(id => id.substring(0, 8)) : 'none');

        const peer = this.dht.peers.get(targetPeerId);
        console.log('Chess: Target peer found:', !!peer, 'connected:', peer?.connected);
        
        let directGossipSuccess = false;
        
        // Try direct gossip first
        if (peer && peer.connected) {
            try {
                peer.send(message);
                console.log('Chess: Gossip message sent successfully to peer:', targetPeerId.substring(0, 8));
                directGossipSuccess = true;
            } catch (err) {
                console.error('Chess: Error sending gossip message:', err);
                console.log('Chess: Fallback to DHT due to send error');
                directGossipSuccess = false;
            }
        } else {
            console.log('Chess: Target peer not connected for gossip, using DHT fallback');
        }
        
        // Always use DHT fallback for reliability, especially for important messages
        const dhtFallbackSuccess = await this.storeGossipMessageInDHT(message, targetPeerId);
        
        if (directGossipSuccess) {
            console.log('Chess: Message sent via direct gossip');
            return true;
        } else if (dhtFallbackSuccess) {
            console.log('Chess: Message sent via DHT fallback');
            return true;
        } else {
            console.error('Chess: Failed to send message via both gossip and DHT');
            return false;
        }
    }

    async storeGossipMessageInDHT(message, targetPeerId) {
        // Store gossip message in DHT for peers who aren't directly connected
        const messageKey = `gossip_${targetPeerId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try {
            await this.dht.put(messageKey, JSON.stringify(message));
            console.log('Chess: Stored gossip message in DHT as fallback:', messageKey);
            return true;
        } catch (err) {
            console.error('Chess: Error storing gossip message in DHT:', err);
            return false;
        }
    }

    handleGossipMessage(message, peerId) {
        console.log('Chess: Received gossip message from:', peerId.substring(0, 8), 'type:', message.subType);

        if (message.subType === 'MOVE') {
            this.handleGossipMove(message, peerId);
        } else if (message.subType === 'GAME_ACTION') {
            this.handleGossipGameAction(message, peerId);
        } else if (message.subType === 'GAME_START_CONFIRM') {
            this.handleGameStartConfirmation(message, peerId);
        }
    }

    handleGossipMove(message, peerId) {
        console.log('Chess: Handling gossip move from:', peerId.substring(0, 8), 'moveId:', message.moveId);
        
        // Validate this is for our current game
        if (message.gameId !== this.gameId) {
            console.log('Chess: Ignoring move - wrong game ID. Expected:', this.gameId, 'Got:', message.gameId);
            return;
        }
        
        // Validate this is from our opponent
        if (peerId !== this.opponentId) {
            console.log('Chess: Ignoring move - wrong opponent. Expected:', this.opponentId?.substring(0, 8), 'Got:', peerId.substring(0, 8));
            return;
        }
        
        // Check for duplicate moves
        if (this.processedGossipMoves.has(message.moveId)) {
            console.log('Chess: Ignoring duplicate move:', message.moveId);
            return;
        }
        
        // Mark this move as processed
        this.processedGossipMoves.add(message.moveId);
        
        // Apply the move
        try {
            const move = message.move;
            console.log('Chess: Applying opponent move via gossip:', move);
            
            // Force UI update if not initialized (in case chess tab wasn't active)
            if (!this.uiInitialized) {
                this.initializeUI();
            }
            
            // Extract move coordinates from the move object
            let fromRow, fromCol, toRow, toCol;
            
            if (Array.isArray(move.from) && Array.isArray(move.to)) {
                // Handle array format [row, col]
                [fromRow, fromCol] = move.from;
                [toRow, toCol] = move.to;
            } else if (typeof move.fromRow !== 'undefined') {
                // Handle object format with individual properties
                fromRow = move.fromRow;
                fromCol = move.fromCol;
                toRow = move.toRow;
                toCol = move.toCol;
            } else {
                console.error('Chess: Invalid move format in gossip message:', move);
                return;
            }
            
            // Apply the move to the engine
            const result = this.engine.makeMove(fromRow, fromCol, toRow, toCol);
            
            if (result && result.success) {
                console.log('Chess: Opponent move applied successfully via gossip');
                
                // Switch timer to the current player (us)
                this.switchPlayerTimer();
                
                // Update UI
                this.updateMoveHistory();
                this.updateGameState();
                this.updateBoard();
                
                // Store updated game state
                this.storeGameState();
                
                // Check for game end
                if (this.engine.gameState === GAME_STATES.CHECKMATE) {
                    this.endGame(`${this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White'} wins by checkmate!`);
                } else if (this.engine.gameState === GAME_STATES.STALEMATE) {
                    this.endGame('Game ends in stalemate!');
                } else if (this.engine.gameState === GAME_STATES.DRAW) {
                    this.endGame('Game ends in a draw!');
                }
            } else {
                console.error('Chess: Failed to apply opponent move via gossip:', result);
            }
            
        } catch (err) {
            console.error('Chess: Error processing gossip move:', err);
        }
    }

    handleGossipGameAction(message, peerId) {
        console.log('Chess: Handling gossip game action from:', peerId.substring(0, 8), 'action:', message.action);
        
        // Validate this is for our current game
        if (message.gameId !== this.gameId) {
            console.log('Chess: Ignoring game action - wrong game ID');
            return;
        }
        
        // Validate this is from our opponent
        if (peerId !== this.opponentId) {
            console.log('Chess: Ignoring game action - wrong opponent');
            return;
        }
        
        // Handle different game actions
        switch (message.action) {
            case 'resign':
                console.log('Chess: Opponent resigned');
                this.endGame('Opponent resigned - You win!');
                break;
                
            case 'draw_offer':
                console.log('Chess: Opponent offered a draw');
                const acceptDraw = confirm('Your opponent is offering a draw. Do you accept?');
                if (acceptDraw) {
                    this.endGame('Game ended in a draw by agreement');
                    // Send draw acceptance back
                    this.sendGameAction('draw_accept');
                }
                break;
                
            case 'draw_accept':
                console.log('Chess: Opponent accepted draw offer');
                this.endGame('Game ended in a draw by agreement');
                break;
                
            case 'rematch_request':
                console.log('Chess: Opponent requested a rematch');
                const acceptRematch = confirm('Your opponent wants a rematch. Do you accept?');
                if (acceptRematch) {
                    // Start a new game
                    this.findGame();
                }
                break;
                
            default:
                console.log('Chess: Unknown game action:', message.action);
        }
    }

    async sendGameStartConfirmation(opponentId, gameId) {
        console.log('Chess: Sending game start confirmation to:', opponentId.substring(0, 8), 'for game:', gameId);
        
        const confirmationMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'GAME_START_CONFIRM',
            gameId: gameId,
            senderId: this.dht.nodeId,
            timestamp: Date.now(),
            confirmationId: `confirm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        return await this.sendGossipMessage(confirmationMessage, opponentId);
    }

    async sendGameAction(action) {
        console.log('Chess: Sending game action:', action);
        
        if (!this.opponentId || !this.gameId) {
            console.error('Chess: Cannot send game action - no active game');
            return false;
        }
        
        const actionMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'GAME_ACTION',
            gameId: this.gameId,
            action: action,
            senderId: this.dht.nodeId,
            timestamp: Date.now(),
            actionId: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        return await this.sendGossipMessage(actionMessage, this.opponentId);
    }

    handleGameStartConfirmation(message, peerId) {
        console.log('Chess: Received game start confirmation from:', peerId.substring(0, 8), 'for game:', message.gameId);
        
        // Clear handshake timeout since we received a confirmation
        if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
            console.log('Chess: Cleared handshake timeout - received confirmation');
        }
        
        // If we don't have a game started yet, this confirmation is starting the game
        if (this.gameState !== 'playing') {
            console.log('Chess: Starting game in response to handshake confirmation');
            
            // Determine our game setup from the confirmation
            const opponentId = peerId;
            const gameId = message.gameId;
            
            // Determine colors (must match the initiator's logic)
            const playerIds = [this.dht.nodeId, opponentId].sort();
            const amIWhite = playerIds[0] === this.dht.nodeId;
            const myColor = amIWhite ? COLORS.WHITE : COLORS.BLACK;
            
            // Stop polling and start the game
            this.isSearching = false;
            this.gameState = 'playing';
            if (this.matchmakingInterval) {
                clearInterval(this.matchmakingInterval);
                this.matchmakingInterval = null;
            }
            
            // Set up handshake tracking
            this.gameStartHandshake.opponentId = opponentId;
            this.gameStartHandshake.gameId = gameId;
            this.gameStartHandshake.receivedConfirmation = true;
            
            // Start the game
            this.startGame(gameId, opponentId, myColor);
            
            // Send confirmation back (important for mutual confirmation)
            this.sendGameStartConfirmation(opponentId, gameId);
            
            // Start move polling for fallback
            this.startReducedMovePolling();
            
            return;
        }
        
        // For existing games, validate that this confirmation is for our current game
        if (!this.gameStartHandshake || message.gameId !== this.gameStartHandshake.gameId) {
            console.log('Chess: Ignoring game start confirmation - no active handshake or wrong game ID');
            return;
        }

        // Validate that this confirmation is from our expected opponent
        if (peerId !== this.gameStartHandshake.opponentId) {
            console.log('Chess: Ignoring game start confirmation - wrong sender');
            return;
        }

        // Mark that we received confirmation
        this.gameStartHandshake.receivedConfirmation = true;
        console.log('Chess: Game start confirmation received and processed');

        // Start move polling for fallback if not already started
        if (this.gameState === 'playing' && !this.movePollingInterval) {
            this.startReducedMovePolling();
        }

        // Update connection state
        this.updateConnectionState();
    }

    /**
     * Comprehensive debugging method to show current connection and game state
     */
    debugConnectionState() {
        console.log('=== CHESS MODULE DEBUG STATE ===');
        console.log('Game State:', {
            gameState: this.gameState,
            gameId: this.gameId,
            opponentId: this.opponentId?.substring(0, 8),
            playerColor: this.playerColor,
            isSearching: this.isSearching,
            gossipEnabled: this.gossipEnabled
        });
        
        console.log('DHT State:', {
            dhtExists: !!this.dht,
            nodeId: this.dht?.nodeId?.substring(0, 8),
            totalPeers: this.dht?.peers?.size || 0,
            peers: this.dht?.peers ? Array.from(this.dht.peers.entries()).map(([id, peer]) => ({
                id: id.substring(0, 8),
                connected: peer.connected,
                readyState: peer.readyState
            })) : []
        });
        
        console.log('Handshake State:', this.gameStartHandshake);
        
        console.log('UI State:', {
            uiInitialized: this.uiInitialized,
            isChessTabActive: this.isChessTabActive,
            hasChessBoard: !!this.ui?.chessBoard,
            hasMoveHistory: !!this.ui?.moveHistory
        });
        
        console.log('Engine State:', {
            engineExists: !!this.engine,
            currentPlayer: this.engine?.currentPlayer,
            moveCount: this.engine?.moveHistory?.length || 0,
            gameState: this.engine?.gameState
        });
        
        if (this.opponentId) {
            this.monitorPeerConnectivity();
        }
        
        console.log('=== END DEBUG STATE ===');
    }

    async findGame() {
        if (this.isSearching || this.gameState === 'playing') {
            console.log('Chess: Already searching or playing');
            return;
        }

        console.log('Chess: Starting simple DHT matchmaking');
        this.isSearching = true;
        this.gameState = 'searching';
        
        // Update UI
        this.updateConnectionState();
        if (this.ui && this.ui.searchStatus) {
            this.ui.searchStatus.style.display = 'block';
        }

        try {
            // Step 1: Check the matchmaking key
            console.log('Chess: Checking matchmaking key...');
            let matchmakingData = await this.dht.get(GAME_CONFIG.MATCHMAKING_KEY);
            let matchmakingState = {};
            
            if (matchmakingData) {
                try {
                    let parsedData = JSON.parse(matchmakingData);
                    console.log('Chess: Found matchmaking state:', parsedData);
                    
                    // Handle case where DHT returns an array instead of object
                    if (Array.isArray(parsedData)) {
                        console.log('Chess: Converting array to object format');
                        matchmakingState = {};
                    } else if (typeof parsedData === 'object' && parsedData !== null) {
                        matchmakingState = parsedData;
                    } else {
                        console.warn('Chess: Unexpected matchmaking data type, treating as empty');
                        matchmakingState = {};
                    }
                } catch (err) {
                    console.warn('Chess: Invalid matchmaking data, treating as empty');
                    matchmakingState = {};
                }
            }

            // Check if we can pair with someone searching - NO TIME LIMITS!
            const searchingPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                peerId !== this.dht.nodeId && 
                data && data.state === 'searching'
            );

            console.log('Chess: Found searching peers (no time limits):', searchingPeers.length, searchingPeers.map(([id, data]) => ({
                id: id.substring(0, 8),
                age: data.timestamp ? (Date.now() - data.timestamp) / 1000 : 'no timestamp',
                state: data.state
            })));

            console.log('Chess: Final searching peers for matching:', searchingPeers.length, searchingPeers.map(([id, data]) => ({
                id: id.substring(0, 8),
                age: data.timestamp ? (Date.now() - data.timestamp) / 1000 : 'no timestamp'
            })));

            if (searchingPeers.length === 0) {
                // No one searching - add ourselves with "searching" state (Peer 1 scenario)
                console.log('Chess: No one searching, adding ourselves as Peer 1');
                matchmakingState[this.dht.nodeId] = {
                    state: 'searching',
                    timestamp: Date.now()
                };
                
                await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                
                // Start polling to check for other players
                this.startSimpleMatchmakingPolling();
                
            } else {
                // Someone is searching - add ourselves and let Peer 1 detect us (Peer 2 scenario)
                console.log('Chess: Found searching peer, adding ourselves as Peer 2');
                matchmakingState[this.dht.nodeId] = {
                    state: 'searching',
                    timestamp: Date.now()
                };
                
                await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                
                // Start polling to see if Peer 1 matches us
                this.startSimpleMatchmakingPolling();
            }

        } catch (err) {
            console.error('Chess: Error during matchmaking:', err);
            this.isSearching = false;
            this.gameState = 'disconnected';
            this.updateConnectionState();
            
            if (this.ui && this.ui.searchStatus) {
                this.ui.searchStatus.style.display = 'none';
            }
        }
    }

    async storeGameState() {
        if (!this.gameId) return;
        
        const gameState = {
            gameId: this.gameId,
            players: {
                white: this.playerColor === COLORS.WHITE ? this.dht.nodeId : this.opponentId,
                black: this.playerColor === COLORS.BLACK ? this.dht.nodeId : this.opponentId
            },
            currentPlayer: this.engine.currentPlayer,
            board: this.engine.board,
            moveHistory: this.engine.moveHistory,
            gameState: this.engine.gameState,
            timestamp: Date.now()
        };

        try {
            console.log('Chess: Storing game state in DHT');
            await this.dht.put(this.gameId, JSON.stringify(gameState));
            console.log('Chess: Game state stored successfully');
        } catch (err) {
            console.error('Chess: Error storing game state:', err);
        }
    }

    async checkForNewMoves() {
        // Fallback method to check DHT for moves when gossip is unavailable
        console.log('Chess: Checking DHT for new moves (fallback)');
        
        // Also check for stored gossip messages
        await this.checkForStoredGossipMessages();
    }

    async checkForGameActions() {
        // Fallback method to check DHT for game actions when gossip is unavailable
        console.log('Chess: Checking DHT for game actions (fallback)');
    }
    
    async checkForStoredGossipMessages() {
        if (!this.dht || !this.dht.nodeId) {
            return;
        }

        try {
            // Look for messages stored for us in DHT
            console.log('Chess: Checking DHT for stored gossip messages...');
            
            // Get all keys that might contain messages for us
            const messagePrefix = `gossip_${this.dht.nodeId}`;
            
            let keys = [];
            
            // Check if DHT has a getKeys method, otherwise we'll need to track keys differently
            if (typeof this.dht.getKeys === 'function') {
                try {
                    keys = await this.dht.getKeys();
                } catch (err) {
                    console.log('Chess: getKeys method failed, will skip stored message check:', err);
                    return;
                }
            } else {
                // If no getKeys method, we can't efficiently check for stored messages
                // This is a limitation of the current DHT implementation
                console.log('Chess: DHT does not support getKeys, skipping stored message check');
                return;
            }
            
            if (!keys || !Array.isArray(keys)) {
                console.log('Chess: No keys found in DHT for gossip message check');
                return;
            }
            
            const ourMessageKeys = keys.filter(key => key.startsWith(messagePrefix));
            console.log('Chess: Found', ourMessageKeys.length, 'potential gossip messages in DHT');
            
            for (const messageKey of ourMessageKeys) {
                try {
                    const messageData = await this.dht.get(messageKey);
                    if (messageData) {
                        const message = JSON.parse(messageData);
                        console.log('Chess: Processing stored gossip message:', message.subType);
                        
                        // Process the message as if it came via direct gossip
                        this.handleGossipMessage(message, message.playerId);
                        
                        // Remove the processed message from DHT
                        await this.dht.delete(messageKey);
                        console.log('Chess: Removed processed gossip message from DHT:', messageKey);
                    }
                } catch (err) {
                    console.error('Chess: Error processing stored gossip message:', err);
                    // Try to remove malformed message
                    try {
                        await this.dht.delete(messageKey);
                    } catch (deleteErr) {
                        console.error('Chess: Error removing malformed message:', deleteErr);
                    }
                }
            }
            
        } catch (err) {
            console.error('Chess: Error checking for stored gossip messages:', err);
        }
        
        // Also handle handshake retry logic
        if (this.gameState === 'playing' && this.gameStartHandshake.sentConfirmation && !this.gameStartHandshake.receivedConfirmation) {
            console.log('Chess: Waiting for game start handshake confirmation...');
            
            // Try to resend the confirmation if too much time has passed
            const now = Date.now();
            if (!this.gameStartHandshake.lastSentTime || (now - this.gameStartHandshake.lastSentTime) > 5000) {
                console.log('Chess: Retrying game start confirmation send');
                const success = await this.sendGameStartConfirmation(this.gameStartHandshake.opponentId, this.gameStartHandshake.gameId);
                if (success) {
                    this.gameStartHandshake.lastSentTime = now;
                }
            }
        }
    }

    /**
     * Check if a peer exists in our DHT's peer list.
     * This is a simple way to validate that a peer is at least known to the network.
     * @param {string} peerId - The peer ID to check
     * @returns {boolean} - True if peer exists in DHT peer list, false otherwise
     */
    isPeerInDHT(peerId) {
        if (!this.dht || !this.dht.peers) {
            console.log('Chess: No DHT or peers available for peer check');
            return false;
        }
        
        const peerExists = this.dht.peers.has(peerId);
        console.log('Chess: Peer DHT check for:', peerId.substring(0, 8), 'exists:', peerExists);
        return peerExists;
    }

    // Tab activation/deactivation methods

    activate() {
        console.log('Chess: Chess module activated');
        this.isChessTabActive = true;
        
        // Initialize UI if not already done
        if (!this.uiInitialized) {
            this.initializeUI();
        }
        
        // Start polling when chess tab becomes active
        if (this.gameState === 'playing') {
            this.startReducedMovePolling();
        }
        
        // Update connection state
        this.updateConnectionState();
    }

    deactivate() {
        console.log('Chess: Chess module deactivated');
        this.isChessTabActive = false;
        
        // Keep gossip running but can stop some polling when tab is inactive
        // Still maintain reduced polling for fallback even when inactive
    }

    startReducedMovePolling() {
        // Always start polling for games - don't restrict to just when tab is active for better reliability
        console.log('Chess: Starting reduced move polling for DHT fallback');
        
        // Clear any existing polling
        if (this.movePollingInterval) {
            clearInterval(this.movePollingInterval);
        }

        // Start polling for opponent moves as fallback to gossip
        this.movePollingInterval = setInterval(async () => {
            if (this.gameState === 'playing') {
                // Monitor peer connectivity
                this.monitorPeerConnectivity();
                
                await this.checkForNewMoves();
                await this.checkForGameActions();
            }
        }, 2000); // Poll every 2 seconds for better responsiveness
        
        console.log('Chess: Move polling started with 2-second interval');
    }

    startSimpleMatchmakingPolling() {
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
        }

        console.log('Chess: Starting simple matchmaking polling');
        
        this.matchmakingInterval = setInterval(async () => {
            // CRITICAL: Check if we should stop polling
            if (!this.isSearching || this.gameState !== 'searching') {
                console.log('Chess: Stopping simple matchmaking polling - no longer searching. State:', this.gameState, 'Searching:', this.isSearching);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }
            
            // Additional safety check - if we somehow have a game ID already, stop
            if (this.gameId) {
                console.log('Chess: Stopping matchmaking polling - game ID already exists:', this.gameId);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            // Extra safety check - if we're already in playing state, stop
            if (this.gameState === 'playing') {
                console.log('Chess: Stopping matchmaking polling - already in playing state');
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            try {
                console.log('Chess: Polling matchmaking state...');
                let matchmakingData = await this.dht.get(GAME_CONFIG.MATCHMAKING_KEY);
                let matchmakingState = {};
                
                if (matchmakingData) {
                    try {
                        let parsedData = JSON.parse(matchmakingData);
                        console.log('Chess: Current DHT state:', parsedData);
                        
                        // Handle case where DHT returns an array instead of object
                        if (Array.isArray(parsedData)) {
                            console.log('Chess: Converting array to object format in polling');
                            matchmakingState = {};
                        } else if (typeof parsedData === 'object' && parsedData !== null) {
                            matchmakingState = parsedData;
                        } else {
                            console.warn('Chess: Unexpected matchmaking data type during polling, treating as empty');
                            matchmakingState = {};
                        }
                    } catch (err) {
                        console.warn('Chess: Invalid matchmaking data during polling');
                        return;
                    }
                }

                // Check our own state in the matchmaking data
                const ourData = matchmakingState[this.dht.nodeId];
                console.log('Chess: Our data in matchmaking state:', ourData, 'nodeId:', this.dht.nodeId.substring(0, 8));
                
                // FIRST: Check if both players are ready to start the game (highest priority check)
                const readyPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                    peerId !== this.dht.nodeId && data.state === 'ready'
                );
                
                if (ourData && ourData.state === 'ready' && readyPeers.length > 0) {
                    // Both players are ready! But only ONE should initiate the handshake to avoid race conditions
                    const opponentId = readyPeers[0][0];
                    
                    // Determine colors and game ID (must be identical for both players)
                    const playerIds = [this.dht.nodeId, opponentId].sort();
                    const amIWhite = playerIds[0] === this.dht.nodeId;
                    const myColor = amIWhite ? COLORS.WHITE : COLORS.BLACK;
                    const gameId = `game_${Date.now()}_${playerIds[0].substring(0, 8)}_${playerIds[1].substring(0, 8)}`;
                    
                    // Only the player with the lexicographically smaller ID should initiate the handshake
                    // This prevents both players from initiating simultaneously
                    const shouldInitiate = this.dht.nodeId < opponentId;
                    
                    if (shouldInitiate) {
                        // Check if we're already in a game to prevent duplicate starts
                        if (this.gameState === 'playing' || this.gameId) {
                            console.log('Chess: Ignoring game initiation - already in game. State:', this.gameState, 'GameId:', this.gameId);
                            return;
                        }
                        
                        console.log('Chess: Both players ready, I am initiating gossip handshake with opponent:', opponentId.substring(0, 8));
                        console.log('Chess: Color assignment - Me:', myColor, 'Opponent:', myColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE);
                        
                        // Stop polling immediately and set state to prevent further polling
                        this.isSearching = false;
                        this.gameState = 'playing';  // Set this immediately to prevent race conditions
                        if (this.matchmakingInterval) {
                            clearInterval(this.matchmakingInterval);
                            this.matchmakingInterval = null;
                        }
                        
                        // Set up handshake tracking
                        this.gameStartHandshake.opponentId = opponentId;
                        this.gameStartHandshake.gameId = gameId;
                        
                        // Start the game locally first (so it's ready when handshake completes)
                        this.startGame(gameId, opponentId, myColor);
                        
                        // Check peer connectivity
                        console.log('Chess: Pre-handshake peer check for opponent:', opponentId.substring(0, 8));
                        console.log('Chess: DHT has peers:', this.dht.peers ? this.dht.peers.size : 0);
                        if (this.dht.peers) {
                            console.log('Chess: Available peers:', Array.from(this.dht.peers.keys()).map(id => ({
                                id: id.substring(0, 8),
                                connected: this.dht.peers.get(id)?.connected
                            })));
                        }
                        
                        // Send gossip confirmation to opponent (will use DHT fallback if needed)
                        const handshakeSuccess = await this.sendGameStartConfirmation(opponentId, gameId);
                        if (!handshakeSuccess) {
                            console.error('Chess: Failed to send initial game start confirmation');
                        }
                        
                        // Start move polling for fallback
                        this.startReducedMovePolling();
                    } else {
                        console.log('Chess: Both players ready, waiting for opponent to initiate handshake. Opponent:', opponentId.substring(0, 8));
                        console.log('Chess: Color assignment - Me:', myColor, 'Opponent:', myColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE);
                        
                        // Set up a timeout fallback in case the initiator doesn't start the game
                        if (!this.handshakeTimeout) {
                            console.log('Chess: Setting up handshake timeout fallback (10 seconds)');
                            this.handshakeTimeout = setTimeout(async () => {
                                console.warn('Chess: Handshake timeout! Opponent did not initiate game. Starting game ourselves as fallback.');
                                
                                // Stop polling and start the game ourselves
                                this.isSearching = false;
                                this.gameState = 'playing';
                                if (this.matchmakingInterval) {
                                    clearInterval(this.matchmakingInterval);
                                    this.matchmakingInterval = null;
                                }
                                
                                // Set up handshake tracking
                                this.gameStartHandshake.opponentId = opponentId;
                                this.gameStartHandshake.gameId = gameId;
                                
                                // Start the game
                                this.startGame(gameId, opponentId, myColor);
                                
                                // Send handshake confirmation
                                await this.sendGameStartConfirmation(opponentId, gameId);
                                
                                this.handshakeTimeout = null;
                            }, 10000); // 10 second timeout
                        }
                    }
                    
                    return;
                }
                
                // Handle our own state based on what's actually in the DHT
                let needsUpdate = false;
                const now = Date.now();
                
                if (!ourData) {
                    // We're not in the state - re-add ourselves
                    console.log('Chess: Re-adding ourselves to matchmaking state');
                    matchmakingState[this.dht.nodeId] = {
                        state: 'searching',
                        timestamp: now
                    };
                    needsUpdate = true;
                } else if (ourData.state === 'ready') {
                    // We're ready but opponent isn't ready yet - just wait and refresh timestamp
                    console.log('Chess: We are ready, waiting for opponent to also be ready...');
                    matchmakingState[this.dht.nodeId].timestamp = now;
                    needsUpdate = true;
                } else if (ourData.state === 'matched') {
                    // We've been matched! Check if opponent is also matched, then set both to ready
                    console.log('Chess: Found that we have been matched!');
                    
                    const matchedPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                        peerId !== this.dht.nodeId && data.state === 'matched'
                    );
                    
                    if (matchedPeers.length > 0) {
                        const opponentId = matchedPeers[0][0];
                        console.log('Chess: Opponent also matched, setting both to ready. Opponent:', opponentId.substring(0, 8));
                        
                        // Set both players to "ready" state
                        matchmakingState[this.dht.nodeId].state = 'ready';
                        matchmakingState[opponentId].state = 'ready';
                        await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                        
                        console.log('Chess: Both players set to ready, will check on next poll cycle for game start');
                        needsUpdate = false; // Don't update again since we just updated
                        return;
                    } else {
                        // We're matched but no opponent found - this shouldn't happen, but handle it
                        console.log('Chess: We are matched but no opponent found, resetting to searching');
                    }
                } else if (ourData.state === 'searching') {
                    // We're searching - check if we can match with someone
                    const searchingPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                        peerId !== this.dht.nodeId && data.state === 'searching'
                    );
                    
                    if (searchingPeers.length > 0) {
                        // Found a potential opponent! 
                        const potentialOpponentId = searchingPeers[0][0];
                        console.log('Chess: Found potential opponent:', potentialOpponentId.substring(0, 8));
                        
                        // First, check if this peer actually exists in our DHT
                        const peerExists = this.isPeerInDHT(potentialOpponentId);
                        
                        if (peerExists) {
                            // Peer exists in our DHT! Proceed with matching.
                            console.log('Chess: Peer exists in DHT! Setting both players to matched. Opponent:', potentialOpponentId.substring(0, 8));
                            
                            matchmakingState[this.dht.nodeId].state = 'matched';
                            matchmakingState[potentialOpponentId].state = 'matched';
                            
                            await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                            
                            // Wait for next poll cycle to let both players see matched state
                            console.log('Chess: Both players set to matched, waiting for next poll cycle');
                            needsUpdate = false; // Don't update again since we just updated
                            return;
                        } else {
                            // Peer doesn't exist in our DHT - they're a stale entry! Clean it up.
                            console.log('Chess: Peer not found in DHT peer list - removing stale entry:', potentialOpponentId.substring(0, 8));
                            delete matchmakingState[potentialOpponentId];
                            needsUpdate = true;
                        }
                    } else {
                        // Just refresh our timestamp
                        matchmakingState[this.dht.nodeId].timestamp = now;
                        needsUpdate = true;
                    }
                } else {
                    // Unknown state - reset to searching
                    console.log('Chess: Unknown state detected, resetting to searching');
                    matchmakingState[this.dht.nodeId].state = 'searching';
                    matchmakingState[this.dht.nodeId].timestamp = now;
                    needsUpdate = true;
                }

                // Update the state if needed
                if (needsUpdate) {
                    await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                }

            } catch (err) {
                console.error('Chess: Error during simple matchmaking polling:', err);
            }
        }, 2000); // Poll every 2 seconds
    }

    startGame(gameId, opponentId, playerColor) {
        console.log('Chess: Starting game with ID:', gameId, 'Opponent:', opponentId?.substring(0, 8), 'My color:', playerColor);
        
        // Set game state
        this.gameId = gameId;
        this.opponentId = opponentId;
        this.playerColor = playerColor;
        this.gameState = 'playing';
        
        // Initialize/force UI if needed (handles cases where chess tab wasn't active at game start)
        this.initializeUI();
        
        // Start the chess engine
        this.engine.startGame();
        
        // Update the board display
        this.updateBoard();
        
        // Update game state display
        this.updateGameState();
        
        // Start game timer
        this.startGameTimer();
        
        // Update connection state
        this.updateConnectionState();
        
        console.log('Chess: Game setup complete. Game state:', this.gameState, 'Player color:', this.playerColor);
    }

    endGame(message) {
        console.log('Chess: Game ended:', message);
        
        // Stop the game timer
        this.stopGameTimer();
        
        // Immediately set state to prevent any ongoing operations
        this.gameState = 'ended';
        this.isSearching = false;
        
        // Clear game data
        const oldGameId = this.gameId;
        const oldOpponentId = this.opponentId;
        this.gameId = null;
        this.opponentId = null;
        this.playerColor = null;
        
        // Clear any polling intervals
        if (this.movePollingInterval) {
            clearInterval(this.movePollingInterval);
            this.movePollingInterval = null;
        }
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
        }
        
        // Reset handshake state
        this.gameStartHandshake = {
            sentConfirmation: false,
            receivedConfirmation: false,
            opponentId: null,
            gameId: null
        };
        
        // Clear processed gossip moves
        this.processedGossipMoves.clear();
        
        console.log('Chess: Cleaned up game state. Previous game:', oldGameId, 'Previous opponent:', oldOpponentId?.substring(0, 8));
        
        // Update UI if available
        if (this.uiInitialized && this.ui) {
            // Show game end message
            if (this.ui.chessGameStatus) {
                this.ui.chessGameStatus.textContent = message;
            }
            
            // Show rematch button
            if (this.ui.rematchBtn) {
                this.ui.rematchBtn.style.display = 'inline-block';
            }
            
            // Disable game action buttons
            if (this.ui.resignBtn) {
                this.ui.resignBtn.disabled = true;
            }
            if (this.ui.drawBtn) {
                this.ui.drawBtn.disabled = true;
            }
        }
        
        // Could also show a modal or notification here
        alert(message);
    }

    // UI Action Methods

    cancelSearch() {
        console.log('Chess: Canceling search');
        
        if (!this.isSearching) {
            console.log('Chess: Not currently searching');
            return;
        }
        
        // Stop matchmaking polling
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        
        // Reset state
        this.isSearching = false;
        this.gameState = 'disconnected';
        
        // Update UI
        this.updateConnectionState();
        if (this.ui && this.ui.searchStatus) {
            this.ui.searchStatus.style.display = 'none';
        }
        
        console.log('Chess: Search canceled');
    }

    resign() {
        console.log('Chess: Player resigned');
        
        if (this.gameState !== 'playing') {
            console.log('Chess: Cannot resign - not in active game');
            return;
        }
        
        // Send resignation to opponent
        this.sendGameAction('resign');
        
        // End the game locally
        this.endGame('You resigned. Opponent wins!');
    }

    offerDraw() {
        console.log('Chess: Player offered draw');
        
        if (this.gameState !== 'playing') {
            console.log('Chess: Cannot offer draw - not in active game');
            return;
        }
        
        // Send draw offer to opponent
        this.sendGameAction('draw_offer');
        
        // Show confirmation to player
        if (this.ui && this.ui.chessGameStatus) {
            this.ui.chessGameStatus.textContent = 'Draw offer sent to opponent...';
        }
        
        console.log('Chess: Draw offer sent');
    }

    requestRematch() {
        console.log('Chess: Player requested rematch');
        
        if (this.gameState !== 'ended') {
            console.log('Chess: Cannot request rematch - game not ended');
            return;
        }
        
        // Send rematch request to opponent if we have their ID
        if (this.opponentId) {
            this.sendGameAction('rematch_request');
        }
        
        // Start searching for a new game
        this.findGame();
        
        console.log('Chess: Rematch requested and new game search started');
    }

    updateGameState() {
        // Only update UI if elements are available (chess tab is active and UI is initialized)
        if (!this.uiInitialized || !this.ui) {
            console.log('Chess: Skipping updateGameState - UI not initialized');
            // Still try to update some critical elements directly if they exist
            const gameStatusElement = document.getElementById('chessGameStatus');
            if (gameStatusElement && this.gameState) {
                let statusText = 'No game active';
                if (this.gameState === 'searching') {
                    statusText = 'Searching for opponent...';
                } else if (this.gameState === 'playing') {
                    const currentTurn = this.engine?.currentPlayer === COLORS.WHITE ? 'White' : 'Black';
                    const isMyTurn = this.engine?.currentPlayer === this.playerColor;
                    statusText = `Game active - ${currentTurn}'s turn${isMyTurn ? ' (You)' : ''}`;
                } else if (this.gameState === 'ended') {
                    statusText = 'Game ended';
                }
                gameStatusElement.textContent = statusText;
            }
            return;
        }

        // Update game status display
        if (this.ui.chessGameStatus) {
            let statusText = 'No game active';
            
            if (this.gameState === 'searching') {
                statusText = 'Searching for opponent...';
            } else if (this.gameState === 'playing') {
                const currentTurn = this.engine?.currentPlayer === COLORS.WHITE ? 'White' : 'Black';
                const isMyTurn = this.engine?.currentPlayer === this.playerColor;
                statusText = `Game active - ${currentTurn}'s turn${isMyTurn ? ' (You)' : ''}`;
            } else if (this.gameState === 'ended') {
                statusText = 'Game ended';
            }
            
            this.ui.chessGameStatus.textContent = statusText;
        }
        
        // Update player names
        if (this.ui.whitePlayer && this.ui.blackPlayer) {
            const myId = this.dht?.nodeId?.substring(0, 8) || 'You';
            const opponentId = this.opponentId?.substring(0, 8) || 'Opponent';
            
            if (this.playerColor === COLORS.WHITE) {
                this.ui.whitePlayer.textContent = myId;
                this.ui.blackPlayer.textContent = this.opponentId ? opponentId : '-';
            } else if (this.playerColor === COLORS.BLACK) {
                this.ui.whitePlayer.textContent = this.opponentId ? opponentId : '-';
                this.ui.blackPlayer.textContent = myId;
            } else {
                this.ui.whitePlayer.textContent = '-';
                this.ui.blackPlayer.textContent = '-';
            }
        }
        
        // Update button states
        if (this.ui.resignBtn) {
            this.ui.resignBtn.disabled = this.gameState !== 'playing';
        }
        if (this.ui.drawBtn) {
            this.ui.drawBtn.disabled = this.gameState !== 'playing';
        }
        if (this.ui.rematchBtn) {
            this.ui.rematchBtn.style.display = this.gameState === 'ended' ? 'inline-block' : 'none';
        }
        
        // Update timer display
        this.updateTimerDisplay();
        
        console.log('Chess: Game state updated');
    }

    updateMoveHistory() {
        console.log('Chess: updateMoveHistory called');
        
        // Only update UI if elements are available
        if (!this.uiInitialized || !this.ui || !this.ui.moveHistory) {
            console.log('Chess: Skipping updateMoveHistory - UI not available:', {
                uiInitialized: this.uiInitialized,
                hasUI: !!this.ui,
                hasMoveHistory: !!this.ui?.moveHistory
            });
            
            // Try to find the move history element directly
            const moveHistoryElement = document.getElementById('moveHistory');
            if (moveHistoryElement) {
                console.log('Chess: Found move history element, updating UI cache');
                this.ui = this.ui || {};
                this.ui.moveHistory = moveHistoryElement;
            } else {
                console.log('Chess: Move history element not found in DOM');
                return;
            }
        }

        console.log('Chess: Updating move history, current moves:', this.engine?.moveHistory?.length || 0);

        // Clear previous history
        this.ui.moveHistory.innerHTML = '';

        if (!this.engine || !this.engine.moveHistory || this.engine.moveHistory.length === 0) {
            this.ui.moveHistory.innerHTML = '<p>No moves yet</p>';
            console.log('Chess: No moves to display');
            return;
        }

        // Build move history with proper formatting
        const movePairs = [];
        
        for (let i = 0; i < this.engine.moveHistory.length; i += 2) {
            const moveNumber = Math.floor(i / 2) + 1;
            const whiteMove = this.engine.moveHistory[i];
            const blackMove = this.engine.moveHistory[i + 1];
            
            // Generate proper algebraic notation
            const whiteNotation = whiteMove ? this.generateMoveNotation(whiteMove) : '';
            const blackNotation = blackMove ? this.generateMoveNotation(blackMove) : '';
            
            // Create the move pair element
            const movePairDiv = document.createElement('div');
            movePairDiv.className = 'chess-move-pair';
            
            let moveText = `<span class="chess-move-number">${moveNumber}.</span> `;
            moveText += `<span class="chess-white-move">${whiteNotation}</span>`;
            
            if (blackNotation) {
                moveText += ` <span class="chess-black-move">${blackNotation}</span>`;
            }
            
            movePairDiv.innerHTML = moveText;
            this.ui.moveHistory.appendChild(movePairDiv);
        }
        
        // Scroll to bottom to show latest moves
        this.ui.moveHistory.scrollTop = this.ui.moveHistory.scrollHeight;
        
        console.log('Chess: Move history updated with', this.engine.moveHistory.length, 'moves');
    }

    /**
     * Generate algebraic notation for a chess move
     * @param {Object} move - The move object from the chess engine
     * @returns {string} - The move in algebraic notation (e.g., "e4", "Nf3", "O-O")
     */
    generateMoveNotation(move) {
        if (!move) return '';
        
        try {
            // Handle castling moves
            if (move.castling) {
                return move.castling === 'kingside' ? 'O-O' : 'O-O-O';
            }
            
            // Get piece type (empty for pawns)
            const pieceType = move.piece?.type;
            let notation = '';
            
            // Add piece symbol (except for pawns)
            if (pieceType && pieceType !== 'pawn') {
                const pieceSymbols = {
                    'king': 'K',
                    'queen': 'Q', 
                    'rook': 'R',
                    'bishop': 'B',
                    'knight': 'N'
                };
                notation += pieceSymbols[pieceType] || '';
            }
            
            // Handle pawn captures
            if (pieceType === 'pawn' && move.captured) {
                // Add file of departure for pawn captures
                notation += String.fromCharCode(97 + move.fromCol); // 'a' + column
            }
            
            // Add capture symbol
            if (move.captured) {
                notation += 'x';
            }
            
            // Add destination square
            const fileChar = String.fromCharCode(97 + move.toCol); // 'a' + column
            const rankChar = String(8 - move.toRow); // Convert row to rank
            notation += fileChar + rankChar;
            
            // Handle pawn promotion
            if (move.promotion) {
                const promotionSymbols = {
                    'queen': 'Q',
                    'rook': 'R', 
                    'bishop': 'B',
                    'knight': 'N'
                };
                notation += '=' + (promotionSymbols[move.promotion] || 'Q');
            }
            
            // Add check/checkmate indicators (if available from engine)
            if (move.check) {
                notation += '+';
            } else if (move.checkmate) {
                notation += '#';
            }
            
            return notation;
            
        } catch (err) {
            console.error('Chess: Error generating move notation:', err, move);
            // Fallback to simple coordinate notation
            const fromFile = String.fromCharCode(97 + move.fromCol);
            const fromRank = String(8 - move.fromRow);
            const toFile = String.fromCharCode(97 + move.toCol);
            const toRank = String(8 - move.toRow);
            return `${fromFile}${fromRank}-${toFile}${toRank}`;
        }
    }

    // Timer management methods

    startGameTimer() {
        if (this.gameTimer) {
            clearInterval(this.gameTimer);
        }

        console.log('Chess: Starting game timer');
        this.lastMoveTime = Date.now();
        
        this.gameTimer = setInterval(() => {
            this.updateGameTimer();
        }, 1000); // Update every second
    }

    stopGameTimer() {
        if (this.gameTimer) {
            clearInterval(this.gameTimer);
            this.gameTimer = null;
            console.log('Chess: Game timer stopped');
        }
    }

    updateGameTimer() {
        if (!this.engine || this.gameState !== 'playing') {
            return;
        }

        const now = Date.now();
        const elapsed = now - this.lastMoveTime;
        const currentPlayer = this.engine.currentPlayer;
        
        // Deduct time from current player
        if (currentPlayer === COLORS.WHITE) {
            this.timeLeft.white = Math.max(0, this.timeLeft.white - elapsed);
        } else {
            this.timeLeft.black = Math.max(0, this.timeLeft.black - elapsed);
        }
        
        this.lastMoveTime = now;
        
        // Update UI
        this.updateTimerDisplay();
        
        // Check for time out
        if (this.timeLeft.white <= 0) {
            this.endGame('White ran out of time. Black wins!');
        } else if (this.timeLeft.black <= 0) {
            this.endGame('Black ran out of time. White wins!');
        }
    }

    updateTimerDisplay() {
        if (!this.ui || !this.ui.whiteTime || !this.ui.blackTime) {
            return;
        }

        this.ui.whiteTime.textContent = this.formatTime(this.timeLeft.white);
        this.ui.blackTime.textContent = this.formatTime(this.timeLeft.black);
        
        // Add visual indicators for whose turn it is
        const isWhiteTurn = this.engine?.currentPlayer === COLORS.WHITE;
        
        if (this.ui.whiteTime.parentElement) {
            this.ui.whiteTime.parentElement.classList.toggle('active-turn', isWhiteTurn);
        }
        if (this.ui.blackTime.parentElement) {
            this.ui.blackTime.parentElement.classList.toggle('active-turn', !isWhiteTurn);
        }
    }

    formatTime(milliseconds) {
        const totalSeconds = Math.ceil(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    switchPlayerTimer() {
        // Reset the timer for the new current player
        this.lastMoveTime = Date.now();
        this.updateTimerDisplay();
        console.log('Chess: Timer switched to', this.engine?.currentPlayer);
    }

    /**
     * Monitor and log peer connectivity for debugging purposes
     */
    monitorPeerConnectivity() {
        if (!this.opponentId || !this.dht || !this.dht.peers) {
            console.log('Chess: Peer connectivity check - no opponent or DHT peers available');
            return;
        }
        
        const opponent = this.dht.peers.get(this.opponentId);
        const opponentShortId = this.opponentId.substring(0, 8);
        
        if (opponent) {
            console.log(`Chess: Opponent ${opponentShortId} peer status:`, {
                connected: opponent.connected,
                readyState: opponent.readyState,
                lastSeen: opponent.lastSeen || 'unknown'
            });
        } else {
            console.log(`Chess: Opponent ${opponentShortId} not found in peer list`);
            console.log('Chess: Available peers:', this.dht.peers.size, 
                Array.from(this.dht.peers.keys()).map(id => id.substring(0, 8)));
        }
    }
}
