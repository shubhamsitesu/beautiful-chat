const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config();

// --- FIXED CONFIGURATION ---
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY; // Must be 32 characters for aes-256-cbc

if (!FIXED_LOGIN_PASSWORD || !FIXED_SECRET_KEY || FIXED_SECRET_KEY.length !== 32) {
    console.error("FATAL ERROR: Secrets not loaded, or CHAT_SECRET_KEY is not exactly 32 characters.");
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
    transports: ['websocket', 'polling'], // Critical Fix for Render stability
    pingTimeout: 60000 
});

let chatHistory = [];

// --- ENCRYPTION/DECRYPTION FUNCTIONS ---
function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text) return '';
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return "Decryption Error";
    }
}

// --- PERSISTENCE UTILITIES ---
function loadHistory() {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    try {
        const encryptedHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
        chatHistory = encryptedHistory.map(msg => ({
            ...msg,
            text: decrypt(msg.text)
        }));
    } catch (e) {
        console.error("Error loading history:", e.message);
        chatHistory = [];
    }
}

function saveHistory(message) {
    chatHistory.push(message); 
    const encryptedHistory = chatHistory.map(msg => ({ ...msg, text: encrypt(msg.text) }));
    try {
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(encryptedHistory, null, 2));
    } catch (e) {
        console.error("Error saving chat history:", e);
    }
}

function deleteMessageFromHistory(messageId) {
    const initialLength = chatHistory.length;
    chatHistory = chatHistory.filter(msg => msg.id !== messageId);
    
    if (chatHistory.length < initialLength) {
        const encryptedHistory = chatHistory.map(msg => ({ ...msg, text: encrypt(msg.text) }));
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(encryptedHistory, null, 2));
    }
}

loadHistory(); 

// --- EXPRESS SETUP ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); 

// --- SOCKET.IO LOGIC ---

io.on('connection', (socket) => {
    
    // AUTHENTICATION (Password Only)
    socket.on('authenticate-user', ({ password }) => {
        
        if (password === FIXED_LOGIN_PASSWORD) {
            
            // 1. Get current members 
            const currentRoomMembers = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || []);
            
            // 🔥 FIX 1: Two-User Limit Check
            if (currentRoomMembers.length >= 2 && !currentRoomMembers.includes(socket.id)) {
                socket.emit('auth-failure', 'Chat room is currently full. Only two users allowed with this password.');
                return; 
            }
            
            // 2. Identify user type
            const partnerSocketId = currentRoomMembers.find(id => id !== socket.id);
            const userType = partnerSocketId ? 'UserB' : 'UserA'; 

            // 3. Join room and assign data
            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            socket.emit('auth-success', { 
                username: userType, 
                history: chatHistory 
            });

            // 4. Status updates
            if (partnerSocketId) {
                const partnerUserType = userType === 'UserA' ? 'UserB' : 'UserA';
                socket.emit('partner-online', partnerUserType); 
            }
            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType); 

        } else {
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // MESSAGE SENDING 
    socket.on('send-message', (data) => {
        // Check if authenticated
        if (!socket.data.username || socket.data.room !== FIXED_ROOM_KEY) return; 
        
        const message = {
            id: data.messageId,
            user: socket.data.username,
            text: data.text,
            timestamp: Date.now()
        };
        
        saveHistory(message); 

        // 🔥 FIX 2: Send message to the partner (excluding the sender)
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    // Auto-Delete after view
    socket.on('message-viewed-and-delete', (messageId) => {
        deleteMessageFromHistory(messageId);
        socket.to(FIXED_ROOM_KEY).emit('message-autodeleted-clean', messageId);
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        if (socket.data.room === FIXED_ROOM_KEY) {
            socket.to(FIXED_ROOM_KEY).emit('partner-offline', socket.data.username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
