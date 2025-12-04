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
    console.error("FATAL ERROR: Secrets not loaded properly. Check CHAT_SECRET_KEY (must be 32 characters).");
    process.exit(1); 
}

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; 
const CHAT_HISTORY_FILE = 'chat_history.json';
const FIXED_ROOM_KEY = 'fixed_chat_room'; 

const app = express();
const server = http.createServer(app);

// Socket.IO Setup with Render stability fix
const io = new Server(server, { 
    cors: { origin: "*" },
    transports: ['websocket', 'polling'], 
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
    } catch (e) { return "Decryption Error"; }
}

// --- PERSISTENCE UTILITIES ---
function loadHistory() {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    try {
        const encryptedHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
        chatHistory = encryptedHistory.map(msg => ({ ...msg, text: decrypt(msg.text) }));
    } catch (e) { chatHistory = []; }
}

function saveHistory(message) {
    chatHistory.push(message); 
    const encryptedHistory = chatHistory.map(msg => ({ ...msg, text: encrypt(msg.text) }));
    try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(encryptedHistory, null, 2)); } catch (e) {}
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); 

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    
    socket.on('authenticate-user', ({ password }) => {
        if (password === FIXED_LOGIN_PASSWORD) {
            
            const currentRoomMembers = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || []);
            
            // Limit to 2 users
            if (currentRoomMembers.length >= 2 && !currentRoomMembers.includes(socket.id)) {
                socket.emit('auth-failure', 'Room Full (2 Users Max).');
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

    // MESSAGE SENDING (FINAL FIX: Handles Session Loss)
    socket.on('send-message', (data) => {
        // CRITICAL FIX: If server restarted, session is lost. Send alert to client.
        if (!socket.data.username || socket.data.room !== FIXED_ROOM_KEY) {
            console.log("Session lost for user, asking to refresh.");
            socket.emit('auth-failure', 'Server Restarted. Please Refresh Page to Re-login.');
            return; 
        }
        
        const message = {
            id: data.messageId,
            user: socket.data.username,
            text: data.text,
            timestamp: Date.now()
        };
        
        saveHistory(message); 
        
        // Broadcast to partner (excluding sender)
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    // Auto-Delete
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
