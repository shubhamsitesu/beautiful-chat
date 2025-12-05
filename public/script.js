// public/script.js

// UPDATE YOUR SERVER URL HERE
const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; 
const socket = io(RENDER_APP_URL, { transports: ['websocket', 'polling'] }); 

// HTML 
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');
const messageInput = document.getElementById('message-input');
const deleteTimerSelect = document.getElementById('delete-timer'); 
const typingIndicatorEl = document.getElementById('typing-indicator'); 

let myUsername = null; 
let myKeyPair = null;     
let sharedSecret = null;  
let isE2EEReady = false;  


let isTyping = false;
let timeout = undefined;
const KEY_STORE_NAME = 'chat_e2ee_key'; // Local Storage Key

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

// (Fixes btoa() Invalid Character Error)
const bufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};


async function encryptE2EE(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); 
    
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        sharedSecret,
        enc.encode(text)
    );

    return { 
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
        return "🔒 Encrypted (Cannot Read)";
    }
}

// --- PERSISTENCE (localStorage) FUNCTIONS ---

async function saveState() {
    if (myUsername && myKeyPair && myKeyPair.privateKey) {
        const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.privateKey);
        
        const state = {
            username: myUsername,
            privateKey: privateKeyJwk
        };
        localStorage.setItem(KEY_STORE_NAME, JSON.stringify(state));
    }
}

async function loadState() {
    const storedState = localStorage.getItem(KEY_STORE_NAME);
    if (!storedState) return false;

    try {
        const state = JSON.parse(storedState);
        
        const privateKey = await window.crypto.subtle.importKey(
            "jwk",
            state.privateKey,
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveKey", "deriveBits"]
        );
        
        myUsername = state.username;
        myKeyPair = { privateKey: privateKey }; 
        
        return true;
    } catch (e) {
        console.error("Error loading state:", e);
        localStorage.removeItem(KEY_STORE_NAME);
        return false;
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
    
    // Use selected delete time
    const deleteTime = parseInt(deleteTimerSelect.value);

    // Auto-delete logic only for received messages AND if timer is set
    if (messageType === 'received' && deleteTime > 0) { 
        socket.emit('message-viewed-and-delete', messageId);
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, deleteTime); 
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
    socket.emit('stop-typing'); 
}

messageInput.addEventListener('input', () => {
    if (!isTyping) {
        isTyping = true;
        socket.emit('typing'); 
    }
    clearTimeout(timeout);
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
        // Fallback
        addMessage(rawText, 'sent', myUsername, Date.now(), id, false);
    }
    
    socket.emit('send-message', payload);
    messageInput.value = '';
});

// --- SOCKET EVENTS ---

socket.on('auth-success', async ({ username, history }) => {
    myUsername = username;
    
    // Save state on successful login
    await saveState(); 

    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    const partner = username === 'UserA' ? 'UserB' : 'UserA';
    document.getElementById('chat-header').textContent = `Chat: ${partner} (${username})`;
    
    loadHistory(history);
    partnerStatusEl.textContent = 'Connecting...';
    
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

// Handle Auto-Reconnect Success
socket.on('reconnect-success', async ({ username, history }) => {
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
    // P2P Icon Logic Removed
});

socket.on('partner-offline', (user) => {
    const partnerName = user === 'UserA' ? 'UserB' : 'UserA';
    
    partnerStatusEl.textContent = `⚫ ${partnerName} Offline`;
    partnerStatusEl.style.color = '#aaa';
    
    isE2EEReady = false;
    sharedSecret = null; 
    typingIndicatorEl.textContent = '';
    // P2P Icon Logic Removed
});

socket.on('receive-message', (msg) => {
    typingIndicatorEl.textContent = '';
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv);
});

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
    localStorage.removeItem(KEY_STORE_NAME); 
});

socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});

// --- INITIALIZATION ---

async function attemptAutoLogin() {
    const stateLoaded = await loadState();
    
    if (stateLoaded) {
        // Use the stored private key for decryption
        
        // Generate a new keypair (to get a fresh public key for exchange)
        const newKeyPair = await generateKeyPair();
        // Overwrite the new private key with the stored private key
        myKeyPair = { ...newKeyPair, privateKey: myKeyPair.privateKey };

        const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        
        // Send auto-reconnect request to the server
        socket.emit('reconnect-user', { 
            username: myUsername,
            key: publicKeyJwk
        });
        
        // Display chat container while waiting for server response
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('chat-container').classList.remove('hidden');
        
    } else {
        // If no state, show login screen
        document.getElementById('login-container').classList.remove('hidden');
    }
}

// Run auto-login attempt on script load
attemptAutoLogin();
