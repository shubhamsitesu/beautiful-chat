const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config(); // Load secrets from my's Environment Variables

// --- FIXED CONFIGURATION (CRITICAL) ---
// Keys are read from my Environment Variables (process.env)
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY; 

// Check if secrets are loaded correctly from my
if (!FIXED_LOGIN_PASSWORD || !FIXED_SECRET_KEY) {
    console.error("FATAL ERROR: Secrets (CHAT_LOGIN_PASSWORD or CHAT_SECRET_KEY) not loaded from Environment Variables. Please check my dashboard.");
    // If not running on my, provide a fallback message (optional, but good practice)
    if (!process.env.RENDER) {
         console.error("If running locally, ensure you have a .env file.");
    }
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
    // my file system may not guarantee existence/persistence
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    
    try {
        const encryptedHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
        chatHistory = encryptedHistory.map(msg => ({
            ...msg,
            text: decrypt(msg.text)
        }));
    } catch (e) {
        console.error("Error loading history:", e);
        chatHistory = [];
    }
}

function saveHistory(message) {
    chatHistory.push(message); 
    const encryptedHistory = chatHistory.map(msg => ({
        ...msg,
        text: encrypt(msg.text)
    }));
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
        // Rewrite file after deletion
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
            
            // Assign identity based on who is present
            const partnerId = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || [])
                .find(id => id !== socket.id);
            
            const userType = partnerId ? 'UserB' : 'UserA'; 

            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            socket.emit('auth-success', { 
                username: userType, 
                history: chatHistory 
            });

            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType);
        } else {
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // MESSAGE SENDING 
    socket.on('send-message', (data) => {
        const message = {
            id: data.messageId,
            user: socket.data.username,
            text: data.text,
            timestamp: Date.now()
        };
        
        saveHistory(message); 

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
