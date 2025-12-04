const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config();

// --- FIXED CONFIGURATION ---
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY; 

if (!FIXED_LOGIN_PASSWORD || !FIXED_SECRET_KEY || FIXED_SECRET_KEY.length !== 32) {
    console.error("FATAL ERROR: Secrets not loaded properly. Check .env file.");
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
// 🔥 NEW: Tracks which User (A or B) is currently connected
let activeUsers = {}; // { 'socketId': 'UserA' or 'UserB', ... }

// --- SERVER ENCRYPTION (Fallback) ---
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
    } catch (e) { chatHistory = []; }
}

function saveHistory(message) {
    chatHistory.push(message); 
    const storageFormat = chatHistory.map(msg => {
        if (msg.isE2EE) return msg; 
        return { ...msg, text: encryptServerSide(msg.text) };
    });
    try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(storageFormat, null, 2)); } catch (e) {}
}

function deleteMessageFromHistory(messageId) {
    const initialLength = chatHistory.length;
    chatHistory = chatHistory.filter(msg => msg.id !== messageId);
    if (chatHistory.length < initialLength) {
        const storageFormat = chatHistory.map(msg => {
            if (msg.isE2EE) return msg;
            return { ...msg, text: encryptServerSide(msg.text) };
        });
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(storageFormat, null, 2));
    }
}

loadHistory(); 

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); 

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    
    // 🔥 FIXED AUTHENTICATION AND USER ASSIGNMENT
    socket.on('authenticate-user', ({ password }) => {
        if (password === FIXED_LOGIN_PASSWORD) {
            
            const currentRoomMembers = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || []);
            
            if (currentRoomMembers.length >= 2 && !currentRoomMembers.includes(socket.id)) {
                socket.emit('auth-failure', 'Room Full.');
                return; 
            }
            
            // 1. Determine User Type (A or B) based on who is missing
            const userA_active = Object.values(activeUsers).includes('UserA');
            const userB_active = Object.values(activeUsers).includes('UserB');
            
            let userType;

            if (!userA_active) {
                userType = 'UserA';
            } else if (!userB_active) {
                userType = 'UserB';
            } else {
                // If both are active, this should only happen if the room size check failed.
                socket.emit('auth-failure', 'System Error: Both Users Active.');
                return;
            }

            // 2. Assign and Track
            activeUsers[socket.id] = userType; 
            
            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            socket.emit('auth-success', { username: userType, history: chatHistory });

            // Notify partner
            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType); 

        } else {
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // E2EE Key Relay
    socket.on('exchange-key', (data) => {
        socket.to(FIXED_ROOM_KEY).emit('exchange-key', {
            key: data.key,
            from: socket.data.username
        });
    });

    // Message Sending
    socket.on('send-message', (data) => {
        if (!socket.data.username || socket.data.room !== FIXED_ROOM_KEY) {
            socket.emit('auth-failure', 'Server Restarted. Please Refresh.');
            return; 
        }
        
        const message = {
            id: data.messageId,
            user: socket.data.username, // Use the permanently assigned name
            text: data.text,
            isE2EE: data.isE2EE || false,
            iv: data.iv || null,
            timestamp: Date.now()
        };
        
        saveHistory(message); 
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    socket.on('message-viewed-and-delete', (messageId) => {
        deleteMessageFromHistory(messageId);
        socket.to(FIXED_ROOM_KEY).emit('message-autodeleted-clean', messageId);
    });
    
    // FIXED DISCONNECT: Remove from activeUsers and notify
    socket.on('disconnect', () => {
        const disconnectedUser = socket.data.username;
        if (disconnectedUser && socket.data.room === FIXED_ROOM_KEY) {
            
            // 3. Remove user from tracking map
            delete activeUsers[socket.id];
            
            // Notify partner
            socket.to(FIXED_ROOM_KEY).emit('partner-offline', disconnectedUser);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
