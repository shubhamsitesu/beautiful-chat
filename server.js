// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config();

// --- FIXED CONFIGURATION ---
// Ensure CHAT_LOGIN_PASSWORD and CHAT_SECRET_KEY are set in your .env file
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD || 'supersecretpassword'; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // Must be 32 characters
const MAX_USERS = 2; 

if (FIXED_SECRET_KEY.length !== 32) {
    console.error("FATAL ERROR: FIXED_SECRET_KEY must be 32 characters long. Check .env file.");
    process.exit(1); 
}

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; 
const CHAT_HISTORY_FILE = 'chat_history.json';
const FIXED_ROOM_KEY = 'fixed_chat_room'; 

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*" },
    transports: ['websocket', 'polling'], 
    pingTimeout: 60000 
});

let chatHistory = [];
let activeUsers = {}; 
let userKeys = {}; 
let selfDestructTime = 10000; // Set default to 10 seconds (10000ms)

// --- SERVER ENCRYPTION (Fallback & History Storage) ---

function encryptServerSide(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptServerSide(text) {
    if (!text) return '';
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return "Decryption Error"; }
}

// --- PERSISTENCE ---

function loadHistory() {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    try {
        const encryptedHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
        chatHistory = encryptedHistory.map(msg => {
            if (msg.isE2EE) return msg; 
            return { ...msg, text: decryptServerSide(msg.text) };
        });
        console.log("Chat history loaded.");
    } catch (e) { chatHistory = []; console.log("No chat history file found or error loading.");}
}

function saveHistory(message) {
    chatHistory.push(message); 
    const storageFormat = chatHistory.map(msg => {
        if (msg.isE2EE) return msg; 
        return { ...msg, text: encryptServerSide(msg.text) };
    });
    try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(storageFormat, null, 2)); } catch (e) { console.error("Error saving history:", e); }
}

function deleteMessageFromHistory(messageId) {
    const initialLength = chatHistory.length;
    chatHistory = chatHistory.filter(msg => msg.id !== messageId);
    if (chatHistory.length < initialLength) {
        const storageFormat = chatHistory.map(msg => {
            if (msg.isE2EE) return msg;
            return { ...msg, text: encryptServerSide(msg.text) };
        });
        try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(storageFormat, null, 2)); } catch (e) { console.error("Error saving history after delete:", e); }
    }
}

loadHistory(); 

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); 

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    
    // 1. New Login
    socket.on('authenticate-user', ({ password }) => {
        if (password === FIXED_LOGIN_PASSWORD) {
            
            const currentRoomMembers = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || []);
            
            if (currentRoomMembers.length >= MAX_USERS) {
                socket.emit('auth-failure', 'Room Full. Max 2 users allowed.');
                return; 
            }
            
            const userA_active = Object.values(activeUsers).includes('UserA');
            const userB_active = Object.values(activeUsers).includes('UserB');
            
            let userType;

            if (!userA_active) {
                userType = 'UserA';
            } else if (!userB_active) {
                userType = 'UserB';
            } else {
                socket.emit('auth-failure', 'System Error: Both Users Active.');
                return;
            }

            activeUsers[socket.id] = userType; 
            
            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            // Send current selfDestructTime on auth success
            socket.emit('auth-success', { 
                username: userType, 
                history: chatHistory,
                selfDestructTime: selfDestructTime
            });

            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType); 

        } else {
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // 2. Reconnect (REMOVED LOGIC - All logins go through 'authenticate-user' now)
    // We are removing the 'reconnect-user' handler entirely as all successful logins now use 'auth-success'.
    
    // 3. Handle self-destruct time change and broadcast
    socket.on('set-self-destruct-time', (newTime) => {
        const newTimeInt = parseInt(newTime);
        if (isNaN(newTimeInt)) return;

        selfDestructTime = newTimeInt;
        
        // Broadcast the new time to all clients in the room
        io.to(FIXED_ROOM_KEY).emit('sync-self-destruct-time', selfDestructTime);
    });

    // 4. Key Exchange
    socket.on('exchange-key', (data) => {
        const sender = socket.data.username;
        if (!sender) return;

        userKeys[sender] = data.key; 
        
        // Send key to partner
        socket.to(FIXED_ROOM_KEY).emit('exchange-key', {
            key: data.key,
            from: sender
        });
        
        // FIX for Key Lost: Immediately check for partner's key and send it back
        const partner = sender === 'UserA' ? 'UserB' : 'UserA';
        if (userKeys[partner]) {
             socket.emit('exchange-key', { 
                 key: userKeys[partner], 
                 from: partner
             });
        }
    });

    // 5. Send Message
    socket.on('send-message', (data) => {
        if (!socket.data.username || socket.data.room !== FIXED_ROOM_KEY) {
            socket.emit('auth-failure', 'Server Restarted. Please Refresh.');
            return; 
        }
        
        const message = {
            id: data.messageId,
            user: socket.data.username, 
            text: data.text,
            isE2EE: data.isE2EE || false,
            iv: data.iv || null,
            timestamp: Date.now(),
            // Attach the current synchronized timer duration
            timerDuration: selfDestructTime 
        };
        
        saveHistory(message); 
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    // 6. Typing
    socket.on('typing', () => {
        if (socket.data.room === FIXED_ROOM_KEY) {
            socket.to(FIXED_ROOM_KEY).emit('partner-typing', socket.data.username);
        }
    });

    socket.on('stop-typing', () => {
        if (socket.data.room === FIXED_ROOM_KEY) {
            socket.to(FIXED_ROOM_KEY).emit('partner-stop-typing', socket.data.username);
        }
    });

    // 7. Auto-Delete (History Cleanup)
    socket.on('message-viewed-and-delete', (messageId) => {
        deleteMessageFromHistory(messageId);
        socket.to(FIXED_ROOM_KEY).emit('message-autodeleted-clean', messageId);
    });
    
    // 8. Disconnect
    socket.on('disconnect', () => {
        const disconnectedUser = socket.data.username;
        if (disconnectedUser && socket.data.room === FIXED_ROOM_KEY) {
            
            delete activeUsers[socket.id];
            
            socket.to(FIXED_ROOM_KEY).emit('partner-stop-typing', disconnectedUser); 
            socket.to(FIXED_ROOM_KEY).emit('partner-offline', disconnectedUser);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
