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
const deleteTimerSelect = document.getElementById('delete-timer'); 
const typingIndicatorEl = document.getElementById('typing-indicator'); 

let myUsername = null; 
let myKeyPair = null;     
let sharedSecret = null;  
let isE2EEReady = false;  
let isTyping = false;
let timeout = undefined;
let currentSelfDestructTime = 10000;

// --- CONNECTION CHECKS ---
socket.on('connect', () => {
    if (myUsername) {
        // If reconnected but we lost session context, reload to force clean login
        console.log("Reconnected to server.");
    }
});

// --- E2EE CRYPTO FUNCTIONS ---
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
            "jwk", partnerPublicKeyJwk, { name: "ECDH", namedCurve: "P-256" }, false, []
        );
        return await window.crypto.subtle.deriveKey(
            { name: "ECDH", public: partnerPublicKey },
            myKeyPair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
    } catch(e) { return null; }
}

const bufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
};

async function encryptE2EE(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); 
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, sharedSecret, enc.encode(text)
    );
    return { text: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

async function decryptE2EE(b64Cipher, b64Iv) {
    try {
        const iv = Uint8Array.from(atob(b64Iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(b64Cipher), c => c.charCodeAt(0));
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, sharedSecret, ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "🔒 Encrypted (Key Lost)"; }
}

// --- UI HELPER FUNCTIONS ---
async function addMessage(text, type, user, timestamp, messageId, isE2EE = false, iv = null, timerDuration = 0) {
    let displayText = text;
    if (isE2EE && type === 'received') {
        if (sharedSecret && iv) displayText = await decryptE2EE(text, iv);
        else displayText = "🔒 Encrypted (Key Lost)";
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
    
    // Auto-Delete based on server Timer
    if (timerDuration > 0 && messageType === 'received') { 
        socket.emit('message-viewed-and-delete', messageId);
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, timerDuration); 
    }
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        // Use msg.user for comparison
        addMessage(msg.text, null, msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration || 0); 
    });
}

// --- LISTENERS ---
if (deleteTimerSelect) {
    deleteTimerSelect.addEventListener('change', (e) => {
        const newTime = parseInt(e.target.value);
        socket.emit('set-self-destruct-time', newTime);
        currentSelfDestructTime = newTime; 
    });
}

messageInput.addEventListener('input', () => {
    if (!isTyping) { isTyping = true; socket.emit('typing'); }
    clearTimeout(timeout);
    timeout = setTimeout(() => { isTyping = false; socket.emit('stop-typing'); }, 1000); 
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    
    // Fresh login always generates new keys
    myKeyPair = await generateKeyPair();
    socket.emit('authenticate-user', { password: pass });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawText = messageInput.value;
    if (!rawText) return;

    // 🔥 CHECK IF CONNECTED
    if (!socket.connected) {
        alert("Connection lost. Reloading page...");
        location.reload();
        return;
    }

    const id = crypto.randomUUID();
    let payload = { messageId: id, text: rawText, isE2EE: false, timerDuration: currentSelfDestructTime };

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
    
    clearTimeout(timeout);
    isTyping = false;
    socket.emit('stop-typing');
});

// --- SOCKET EVENTS ---
socket.on('auth-success', async ({ username, history, selfDestructTime }) => {
    myUsername = username;
    currentSelfDestructTime = selfDestructTime;
    if (deleteTimerSelect) deleteTimerSelect.value = selfDestructTime.toString();
    
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    document.getElementById('chat-header').textContent = `Chat: ${username === 'UserA' ? 'UserB' : 'UserA'} (${username})`;
    
    loadHistory(history);
    
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

socket.on('sync-self-destruct-time', (newTime) => {
    currentSelfDestructTime = newTime;
    if (deleteTimerSelect) deleteTimerSelect.value = newTime.toString();
});

socket.on('partner-online', async (user) => {
    // Partner online: Try to establish E2EE immediately
    if (myKeyPair) {
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
    // Pass the received timer duration to addMessage
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration);
});

socket.on('partner-typing', (user) => {
    if (user !== myUsername) {
        const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
        typingIndicatorEl.textContent = `${partnerName} is typing...`;
    }
});

socket.on('partner-stop-typing', (user) => {
    if (user !== myUsername) typingIndicatorEl.textContent = '';
});

socket.on('auth-failure', (msg) => {
    if (msg.includes('Refresh') || msg.includes('Connection Lost')) {
        alert(msg);
        location.reload();
    } else {
        document.getElementById('error-msg').textContent = msg;
    }
});

socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});
