// public/script.js

// UPDATE YOUR SERVER URL HERE
const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; 
const socket = io(RENDER_APP_URL, { transports: ['websocket', 'polling'] }); 

// References to HTML elements
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');
const messageInput = document.getElementById('message-input');
const deleteTimerSelect = document.getElementById('delete-timer'); // New: Timer control
const typingIndicatorEl = document.getElementById('typing-indicator'); // New: Typing indicator

// Main encryption and user states
let myUsername = null; 
let myKeyPair = null;     
let sharedSecret = null;  
let isE2EEReady = false;  

// Typing state management
let isTyping = false;
let timeout = undefined;

// --- E2EE CRYPTO FUNCTIONS (Web Crypto API) ---

async function generateKeyPair() {
    return window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
    );
}

async function deriveSharedSecret(partnerPublicKeyJwk) {
    try {
        const partnerPublicKey = await window.crypto.subtle.importKey(
            "jwk",
            partnerPublicKeyJwk,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
        );
        return await window.crypto.subtle.deriveKey(
            { name: "ECDH", public: partnerPublicKey },
            myKeyPair.privateKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    } catch(e) { return null; }
}

// Helper function to safely convert binary ArrayBuffer to Base64 string (Fixes btoa() error)
const bufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

// Fixed and secure encryption function
async function encryptE2EE(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); 
    
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        sharedSecret,
        enc.encode(text)
    );

    return { 
        // Use the safe helper function for Base64 encoding
        text: bufferToBase64(ciphertext), 
        iv: bufferToBase64(iv.buffer) 
    };
}

async function decryptE2EE(b64Cipher, b64Iv) {
    try {
        const iv = Uint8Array.from(atob(b64Iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(b64Cipher), c => c.charCodeAt(0));
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            sharedSecret,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return "🔒 Encrypted (Key Lost)";
    }
}

// --- UI HELPER FUNCTIONS ---

async function addMessage(text, type, user, timestamp, messageId, isE2EE = false, iv = null) {
    let displayText = text;

    if (isE2EE && type === 'received') {
        if (sharedSecret && iv) {
            displayText = await decryptE2EE(text, iv);
        } else {
            displayText = "🔒 Encrypted (Cannot Read)";
        }
    }

    // Determine message type (sent or received)
    const messageType = (user === myUsername) ? 'sent' : 'received';

    const div = document.createElement('div');
    div.classList.add('message', messageType);
    div.setAttribute('data-id', messageId); 

    const date = new Date(timestamp);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
    const headerText = user === myUsername ? 'You' : partnerName; 
    
    const lockIcon = isE2EE ? '🔒 ' : '';

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text" style="${isE2EE ? 'color:#2e7d32; font-weight:500;' : ''}">${lockIcon}${displayText}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // 🔥 NEW: Use selected delete time
    const deleteTime = parseInt(deleteTimerSelect.value);

    // Auto-delete logic only for received messages
    if (messageType === 'received') { 
        socket.emit('message-viewed-and-delete', messageId);
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, deleteTime); // Use selected time
    }
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        const type = msg.user === myUsername ? 'sent' : 'received';
        addMessage(msg.text, type, msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv); 
    });
}

// --- TYPING INDICATOR LOGIC ---

function typingTimeout() {
    isTyping = false;
    socket.emit('stop-typing'); // Notify server that typing has stopped
}

messageInput.addEventListener('input', () => {
    if (!isTyping) {
        isTyping = true;
        socket.emit('typing'); // Notify server that typing has started
    }
    clearTimeout(timeout);
    // Send stop-typing event after 1 second of inactivity
    timeout = setTimeout(typingTimeout, 1000); 
});

// --- EVENT LISTENERS ---

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    myKeyPair = await generateKeyPair(); 
    socket.emit('authenticate-user', { password: pass });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawText = messageInput.value;
    if (!rawText) return;

    // Send stop typing event immediately after sending message
    clearTimeout(timeout);
    typingTimeout(); 

    const id = crypto.randomUUID();
    let payload = { messageId: id, text: rawText, isE2EE: false };

    if (isE2EEReady && sharedSecret) {
        // E2EE Encryption
        const encryptedData = await encryptE2EE(rawText);
        payload.text = encryptedData.text;
        payload.iv = encryptedData.iv;
        payload.isE2EE = true;
        addMessage(rawText, 'sent', myUsername, Date.now(), id, true);
    } else {
        // Server-side Encryption (Fallback)
        addMessage(rawText, 'sent', myUsername, Date.now(), id, false);
    }
    
    socket.emit('send-message', payload);
    messageInput.value = '';
});

// --- SOCKET EVENTS ---

socket.on('auth-success', async ({ username, history }) => {
    myUsername = username;
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    const partner = username === 'UserA' ? 'UserB' : 'UserA';
    document.getElementById('chat-header').textContent = `Chat: ${partner} (${username})`;
    
    loadHistory(history);
    partnerStatusEl.textContent = 'Connecting...';
    
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

socket.on('exchange-key', async (data) => {
    sharedSecret = await deriveSharedSecret(data.key);
    if (sharedSecret) {
        isE2EEReady = true;
        partnerStatusEl.textContent = "🔒 Secure E2EE Connected";
        partnerStatusEl.style.color = "#2e7d32"; 
        
        // If partner sent key first and we weren't ready, send our key back
        if (data.from !== myUsername && !isE2EEReady) {
             const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
             socket.emit('exchange-key', { key: publicKeyJwk });
        }
    }
});

socket.on('partner-online', async (user) => {
    // Re-trigger handshake
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

socket.on('partner-offline', (user) => {
    const partnerName = user === myUsername ? 'You' : (myUsername === 'UserA' ? 'UserB' : 'UserA');

    partnerStatusEl.textContent = `⚫ ${partnerName} Offline`;
    partnerStatusEl.style.color = '#aaa';
    
    // Reset E2EE state
    isE2EEReady = false;
    sharedSecret = null; 
    
    // Clear typing indicator if partner goes offline
    typingIndicatorEl.textContent = '';
});

socket.on('receive-message', (msg) => {
    // Hide typing indicator when message received
    typingIndicatorEl.textContent = '';
    
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv);
});

// NEW: Handle Typing Events
socket.on('partner-typing', (user) => {
    if (user !== myUsername) {
        const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
        typingIndicatorEl.textContent = `${partnerName} is typing...`;
    }
});

socket.on('partner-stop-typing', (user) => {
    if (user !== myUsername) {
        typingIndicatorEl.textContent = '';
    }
});

socket.on('auth-failure', (msg) => {
    if (msg.includes('Refresh')) location.reload();
    else document.getElementById('error-msg').textContent = msg;
});

// Server confirmation for auto-delete
socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});
