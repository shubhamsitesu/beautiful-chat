// public/script.js

// UPDATE YOUR SERVER URL HERE
const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; // Change this to your Render URL
const socket = io(RENDER_APP_URL, { transports: ['websocket', 'polling'] }); 

// References to HTML elements
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');
const messageInput = document.getElementById('message-input');
const typingIndicatorEl = document.getElementById('typing-indicator');
const selfDestructTimerSelect = document.getElementById('self-destruct-timer'); 

let currentSelfDestructTime = 0; 
let myUsername = null; 
let myKeyPair = null;     
let sharedSecret = null;  
let isE2EEReady = false;  

let isTyping = false;
let timeout = undefined;

// SESSION STORAGE KEY (Data deleted when tab/browser closes)
const KEY_STORE_NAME = 'chat_e2ee_key_session'; 

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
        return "🔒 Encrypted (Key Lost)";
    }
}

// --- PERSISTENCE (sessionStorage) FUNCTIONS ---

async function saveState() {
    if (myUsername && myKeyPair && myKeyPair.privateKey) {
        const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.privateKey);
        
        const state = {
            username: myUsername,
            privateKey: privateKeyJwk
        };
        sessionStorage.setItem(KEY_STORE_NAME, JSON.stringify(state));
    }
}

async function loadState() {
    const storedState = sessionStorage.getItem(KEY_STORE_NAME);
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
        myKeyPair = { privateKey: privateKey }; // Temporarily store the private key
        
        return true;
    } catch (e) {
        console.error("Error loading state:", e);
        sessionStorage.removeItem(KEY_STORE_NAME);
        return false;
    }
}

// --- UI HELPER FUNCTIONS ---

async function addMessage(text, type, user, timestamp, messageId, isE2EE = false, iv = null, timerDuration = 0) {
    let displayText = text;

    if (isE2EE && type === 'received') {
        if (sharedSecret && iv) {
            displayText = await decryptE2EE(text, iv);
        } else {
            displayText = "🔒 Encrypted (Key Lost)";
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
    const timerIcon = timerDuration > 0 ? ` ⏱️ ${timerDuration / 1000}s` : '';

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text" style="${isE2EE ? 'color:#2e7d32; font-weight:500;' : ''}">${lockIcon}${displayText}${timerIcon}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Apply deletion logic if timer is active
    if (timerDuration > 0) { 
        
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, timerDuration); 

        socket.emit('message-viewed-and-delete', messageId);
    }
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        const type = msg.user === myUsername ? 'sent' : 'received';
        addMessage(msg.text, type, msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration || 0); 
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

// Timer Select Change Listener
if (selfDestructTimerSelect) {
    selfDestructTimerSelect.addEventListener('change', (e) => {
        const newTime = parseInt(e.target.value);
        socket.emit('set-self-destruct-time', newTime);
        currentSelfDestructTime = newTime; 
    });
}


loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    
    // 1. Attempt to load existing key state
    const stateLoaded = await loadState(); // Loads myKeyPair.privateKey

    if (stateLoaded) {
        // Key found: Create a new key pair combining new Public Key with stored Private Key
        const freshKeyPair = await generateKeyPair();
        myKeyPair = { 
            publicKey: freshKeyPair.publicKey, 
            privateKey: myKeyPair.privateKey 
        };
    } else {
        // Key not found: Generate a brand new key pair.
        myKeyPair = await generateKeyPair(); 
    }

    // 2. Proceed with authentication
    socket.emit('authenticate-user', { password: pass });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawText = messageInput.value;
    if (!rawText) return;

    clearTimeout(timeout);
    typingTimeout(); 

    const id = crypto.randomUUID();
    let payload = { 
        messageId: id, 
        text: rawText, 
        isE2EE: false,
        timerDuration: currentSelfDestructTime 
    };

    if (isE2EEReady && sharedSecret) {
        const encryptedData = await encryptE2EE(rawText);
        payload.text = encryptedData.text;
        payload.iv = encryptedData.iv;
        payload.isE2EE = true;
        addMessage(rawText, 'sent', myUsername, Date.now(), id, true, null, currentSelfDestructTime);
    } else {
        addMessage(rawText, 'sent', myUsername, Date.now(), id, false, null, currentSelfDestructTime);
    }
    
    socket.emit('send-message', payload);
    messageInput.value = '';
});

// --- SOCKET EVENTS ---

socket.on('auth-success', async ({ username, history, selfDestructTime }) => {
    myUsername = username;
    await saveState(); 

    currentSelfDestructTime = selfDestructTime;
    if (selfDestructTimerSelect) selfDestructTimerSelect.value = selfDestructTime.toString();
    
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    const partner = username === 'UserA' ? 'UserB' : 'UserA';
    document.getElementById('chat-header').textContent = `Chat: ${partner} (${username})`;
    
    loadHistory(history);
    partnerStatusEl.textContent = 'Connecting...';
    
    // Send public key for handshake using the key prepared in the login handler
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

// REMOVED 'reconnect-success' logic: All successful logins now go through 'auth-success'

socket.on('exchange-key', async (data) => {
    sharedSecret = await deriveSharedSecret(data.key);
    if (sharedSecret) {
        isE2EEReady = true;
        partnerStatusEl.textContent = "🔒 Secure E2EE Connected";
        partnerStatusEl.style.color = "#2e7d32"; 
    }
});

socket.on('sync-self-destruct-time', (newTime) => {
    currentSelfDestructTime = newTime;
    if (selfDestructTimerSelect) {
        selfDestructTimerSelect.value = newTime.toString();
    }
    partnerStatusEl.textContent = `⏱️ Delete Timer Set to ${newTime / 1000}s`;
    setTimeout(() => {
        if (isE2EEReady) partnerStatusEl.textContent = "🔒 Secure E2EE Connected";
    }, 3000);
});


socket.on('partner-online', async (user) => {
    // Re-trigger handshake
    if (myKeyPair && myKeyPair.publicKey) {
        const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        socket.emit('exchange-key', { key: publicKeyJwk });
    }
});

socket.on('partner-offline', (user) => {
    const partnerName = user === 'UserA' ? 'UserB' : 'UserA';
    
    partnerStatusEl.textContent = `⚫ ${partnerName} Offline`;
    partnerStatusEl.style.color = '#aaa';
    
    isE2EEReady = false;
    sharedSecret = null; 
    typingIndicatorEl.textContent = '';
});

socket.on('receive-message', (msg) => {
    typingIndicatorEl.textContent = '';
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration);
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
    document.getElementById('error-msg').textContent = msg;
    sessionStorage.removeItem(KEY_STORE_NAME); 
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
    // Load state to prime the keys if available, but do not connect automatically.
    await loadState();
    
    // Always show the login container first to enforce password requirement on refresh.
    document.getElementById('login-container').classList.remove('hidden');
    document.getElementById('chat-container').classList.add('hidden');
}

attemptAutoLogin();
