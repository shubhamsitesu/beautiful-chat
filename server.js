const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config();

// --- CONFIGURATION ---
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY; 

if (!FIXED_LOGIN_PASSWORD || !FIXED_SECRET_KEY || FIXED_SECRET_KEY.length !== 32) {
    console.error("FATAL ERROR: Secrets not loaded properly.");
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

// --- SERVER-SIDE ENCRYPTION (For History/Offline Fallback) ---
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
        // NOTE: E2EE messages stored in history cannot be decrypted by server.
        // They will be sent as-is to client, but client might not be able to read old E2EE messages
        // after refresh (Perfect Forward Secrecy).
        chatHistory = encryptedHistory.map(msg => {
            if (msg.isE2EE) {
                return msg; // Return encrypted blob for E2EE
            }
            return { ...msg, text: decryptServerSide(msg.text) }; // Decrypt normal messages
        });
    } catch (e) { chatHistory = []; }
}

function saveHistory(message) {
    chatHistory.push(message); 
    
    // Encrypt for disk storage
    const storageFormat = chatHistory.map(msg => {
        if (msg.isE2EE) {
            return msg; // Already encrypted by client
        }
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
    
    socket.on('authenticate-user', ({ password }) => {
        if (password === FIXED_LOGIN_PASSWORD) {
            const currentRoomMembers = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || []);
            
            if (currentRoomMembers.length >= 2 && !currentRoomMembers.includes(socket.id)) {
                socket.emit('auth-failure', 'Room Full.');
                return; 
            }
            
            const partnerSocketId = currentRoomMembers.find(id => id !== socket.id);
            const userType = partnerSocketId ? 'UserB' : 'UserA'; 

            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            socket.emit('auth-success', { username: userType, history: chatHistory });

            if (partnerSocketId) {
                const partnerUserType = userType === 'UserA' ? 'UserB' : 'UserA';
                socket.emit('partner-online', partnerUserType); 
            }
            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType); 

        } else {
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // 🔥 NEW: E2EE KEY EXCHANGE RELAY
    socket.on('exchange-key', (data) => {
        // Relay the public key to the partner in the room
        socket.to(FIXED_ROOM_KEY).emit('exchange-key', {
            key: data.key,
            from: socket.data.username
        });
    });

    // MESSAGE SENDING
    socket.on('send-message', (data) => {
        if (!socket.data.username || socket.data.room !== FIXED_ROOM_KEY) {
            socket.emit('auth-failure', 'Server Restarted. Please Refresh.');
            return; 
        }
        
        // Data contains: { messageId, text, isE2EE, iv (if E2EE) }
        const message = {
            id: data.messageId,
            user: socket.data.username,
            text: data.text, // This is CIPHERTEXT if isE2EE is true
            isE2EE: data.isE2EE || false,
            iv: data.iv || null, // Needed for E2EE decryption
            timestamp: Date.now()
        };
        
        saveHistory(message); 
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    socket.on('message-viewed-and-delete', (messageId) => {
        deleteMessageFromHistory(messageId);
        socket.to(FIXED_ROOM_KEY).emit('message-autodeleted-clean', messageId);
    });
    
    socket.on('disconnect', () => {
        if (socket.data.room === FIXED_ROOM_KEY) {
            socket.to(FIXED_ROOM_KEY).emit('partner-offline', socket.data.username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
