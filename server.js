// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const CHAT_HISTORY_FILE = 'chat-history.json';
const AUTH_PASSWORD = 'supersecretpassword'; // Shared Password
const MAX_USERS = 2;

// In-memory state
let connectedUsers = {}; // { username: socket.id }
let userKeys = {}; // { username: partnerPublicKeyJwk }
let userSockets = {}; // { socket.id: username }

// Load chat history
let chatHistory = [];
try {
    const data = fs.readFileSync(CHAT_HISTORY_FILE);
    chatHistory = JSON.parse(data);
} catch (e) {
    console.log("No chat history file found. Starting fresh.");
}

function saveHistory() {
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
}

// Assigns user based on availability
function assignUser() {
    const users = Object.keys(connectedUsers);
    if (!users.includes('UserA')) return 'UserA';
    if (!users.includes('UserB')) return 'UserB';
    return null; 
}

// Middleware to prevent excess connections
io.use((socket, next) => {
    if (Object.keys(connectedUsers).length >= MAX_USERS && !userSockets[socket.id]) {
        return next(new Error(`Max users reached. Try again later. Refresh if needed.`));
    }
    next();
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- NEW: Handle Reconnect from LocalStorage ---
    socket.on('reconnect-user', (data) => {
        const { username, key } = data;

        if (connectedUsers[username] && connectedUsers[username] !== socket.id) {
            console.log(`Reconnect failed: ${username} already connected on another socket.`);
            return socket.emit('auth-failure', 'User already connected. Refresh to try again.');
        }

        const partner = username === 'UserA' ? 'UserB' : 'UserA';
        
        // Authentication success flow for reconnect
        connectedUsers[username] = socket.id;
        userSockets[socket.id] = username;
        userKeys[username] = key;

        console.log(`User ${username} reconnected. Total users: ${Object.keys(connectedUsers).length}`);

        // 1. Send success and history
        socket.emit('reconnect-success', { username: username, history: chatHistory });

        // 2. Notify partner
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('partner-online', username);
        }
        
        // 3. Try to establish E2EE with partner immediately
        if (userKeys[partner]) {
             socket.emit('exchange-key', { key: userKeys[partner], from: partner });
        }
    });
    
    // --- Existing Authenticate User ---
    socket.on('authenticate-user', (data) => {
        if (data.password !== AUTH_PASSWORD) {
            return socket.emit('auth-failure', 'Incorrect password.');
        }

        const username = assignUser();
        if (!username) {
            return socket.emit('auth-failure', 'Chat room is full. Refresh to try again.');
        }

        if (connectedUsers[username]) {
             const oldSocketId = connectedUsers[username];
             if(userSockets[oldSocketId]) delete userSockets[oldSocketId];
        }

        const partner = username === 'UserA' ? 'UserB' : 'UserA';
        
        connectedUsers[username] = socket.id;
        userSockets[socket.id] = username;

        console.log(`User ${username} authenticated. Total users: ${Object.keys(connectedUsers).length}`);

        // 1. Send success and history
        socket.emit('auth-success', { username: username, history: chatHistory });

        // 2. Notify partner
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('partner-online', username);
        }
    });

    // --- E2EE Key Exchange ---
    socket.on('exchange-key', (data) => {
        const sender = userSockets[socket.id];
        const partner = sender === 'UserA' ? 'UserB' : 'UserA';
        
        userKeys[sender] = data.key;
        
        // Send key to partner if they are connected
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('exchange-key', { key: data.key, from: sender });
        }
    });

    // --- Message Handling ---
    socket.on('typing', () => {
        const sender = userSockets[socket.id];
        const partner = sender === 'UserA' ? 'UserB' : 'UserA';
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('partner-typing', sender);
        }
    });

    socket.on('stop-typing', () => {
        const sender = userSockets[socket.id];
        const partner = sender === 'UserA' ? 'UserB' : 'UserA';
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('partner-stop-typing', sender);
        }
    });

    socket.on('send-message', (payload) => {
        const sender = userSockets[socket.id];
        const partner = sender === 'UserA' ? 'UserB' : 'UserA';

        // Message object to save to history and send
        const msg = {
            id: payload.messageId,
            user: sender,
            text: payload.text,
            timestamp: Date.now(),
            isE2EE: payload.isE2EE || false,
            iv: payload.iv || null
        };
        
        // Save to history (encrypted, so storage is safe)
        chatHistory.push(msg);
        saveHistory();

        // Send to partner
        if (connectedUsers[partner]) {
            io.to(connectedUsers[partner]).emit('receive-message', msg);
        } else {
            console.log(`Message from ${sender} saved, but ${partner} is offline.`);
        }
    });

    // --- Auto-Delete Clean-up ---
    socket.on('message-viewed-and-delete', (messageId) => {
        const partner = userSockets[socket.id] === 'UserA' ? 'UserB' : 'UserA';
        
        // Notify the partner (sender) that the message can be safely removed from their UI
        if (connectedUsers[partner]) {
             io.to(connectedUsers[partner]).emit('message-autodeleted-clean', messageId);
        }
        
        // Remove the message from server history
        const initialLength = chatHistory.length;
        chatHistory = chatHistory.filter(msg => msg.id !== messageId);
        if (chatHistory.length < initialLength) {
             saveHistory();
        }
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        const disconnectedUser = userSockets[socket.id];
        if (disconnectedUser) {
            const partner = disconnectedUser === 'UserA' ? 'UserB' : 'UserA';
            
            // Cleanup in-memory state
            delete connectedUsers[disconnectedUser];
            delete userSockets[socket.id];

            // Notify partner
            if (connectedUsers[partner]) {
                io.to(connectedUsers[partner]).emit('partner-offline', disconnectedUser);
            }
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

app.use(express.static('public'));

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
