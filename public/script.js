// public/script.js

const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; // UPDATE THIS
const socket = io(RENDER_APP_URL, { transports: ['websocket', 'polling'] }); 

const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');

let myUsername = null; 
let myKeyPair = null;     // My Public/Private Keys
let sharedSecret = null;  // The secret key combined with partner
let isE2EEReady = false;  // Flag to check if E2EE is active

// --- E2EE CRYPTO FUNCTIONS (Browser Native) ---

// 1. Generate Key Pair (ECDH)
async function generateKeyPair() {
    return window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
    );
}

// 2. Derive Shared Secret (from my Private + Partner's Public)
async function deriveSharedSecret(partnerPublicKeyJwk) {
    try {
        const partnerPublicKey = await window.crypto.subtle.importKey(
            "jwk",
            partnerPublicKeyJwk,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
        );

        const secret = await window.crypto.subtle.deriveKey(
            { name: "ECDH", public: partnerPublicKey },
            myKeyPair.privateKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
        return secret;
    } catch(e) {
        console.error("Key derivation failed", e);
        return null;
    }
}

// 3. Encrypt Message (AES-GCM)
async function encryptE2EE(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        sharedSecret,
        enc.encode(text)
    );
    
    // Convert buffer to Base64 string for sending
    const b64Cipher = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const b64Iv = btoa(String.fromCharCode(...iv));
    return { text: b64Cipher, iv: b64Iv };
}

// 4. Decrypt Message (AES-GCM)
async function decryptE2EE(b64Cipher, b64Iv) {
    try {
        const iv = Uint8Array.from(atob(b64Iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(b64Cipher), c => c.charCodeAt(0));
        
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            sharedSecret,
            ciphertext
        );
        
        const dec = new TextDecoder();
        return dec.decode(decrypted);
    } catch (e) {
        return "🔒 Encrypted Message (Key changed/lost)";
    }
}


// --- UI FUNCTIONS ---
async function addMessage(text, type, user, timestamp, messageId, isE2EE = false, iv = null) {
    let displayText = text;

    // Decrypt if it's an E2EE message and we have the secret
    if (isE2EE && type === 'received') {
        if (sharedSecret && iv) {
            displayText = await decryptE2EE(text, iv);
        } else {
            displayText = "🔒 Encrypted (Waiting for key...)";
        }
    }

    const div = document.createElement('div');
    div.classList.add('message', type);
    div.setAttribute('data-id', messageId); 

    const date = new Date(timestamp);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const headerText = user === myUsername ? 'You' : (user === 'UserA' ? 'UserB' : 'UserA');
    
    // Add Lock Icon for E2EE
    const lockIcon = isE2EE ? '🔒 ' : '';

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text" style="${isE2EE ? 'color:#2e7d32; font-weight:500;' : ''}">${lockIcon}${displayText}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Auto-delete logic
    if (type === 'received') {
        socket.emit('message-viewed-and-delete', messageId);
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, 3000); 
    }
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        const type = msg.user === myUsername ? 'sent' : 'received';
        // Note: Old E2EE messages from history might not be readable if key changed (Security Feature)
        addMessage(msg.text, type, msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv); 
    });
}

// --- LOGIC ---

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    // Generate my keys immediately upon login attempt
    myKeyPair = await generateKeyPair();
    socket.emit('authenticate-user', { password: pass });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const rawText = input.value;
    if (!rawText) return;

    const id = crypto.randomUUID();
    let payload = { messageId: id, text: rawText, isE2EE: false };

    // 🔥 HYBRID LOGIC: If E2EE is ready, encrypt locally!
    if (isE2EEReady && sharedSecret) {
        const encryptedData = await encryptE2EE(rawText);
        payload.text = encryptedData.text;
        payload.iv = encryptedData.iv;
        payload.isE2EE = true;
        
        // Show local message immediately (Plain text for me)
        addMessage(rawText, 'sent', myUsername, Date.now(), id, true);
    } else {
        // Fallback: Send plain (Server will encrypt for storage)
        addMessage(rawText, 'sent', myUsername, Date.now(), id, false);
    }
    
    socket.emit('send-message', payload);
    input.value = '';
});

// --- SOCKET EVENTS ---

socket.on('auth-success', async ({ username, history }) => {
    myUsername = username;
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    const partner = username === 'UserA' ? 'UserB' : 'UserA';
    document.getElementById('chat-header').textContent = `Chat with ${partner} (${username})`;
    loadHistory(history);
    partnerStatusEl.textContent = 'Connecting...';
    
    // Broadcast my Public Key to partner to start E2EE
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

// Partner sent their key
socket.on('exchange-key', async (data) => {
    console.log("Received Public Key from Partner. Establishing E2EE...");
    sharedSecret = await deriveSharedSecret(data.key);
    if (sharedSecret) {
        isE2EEReady = true;
        partnerStatusEl.textContent = "🔒 Secure E2EE Connected";
        partnerStatusEl.style.color = "#2e7d32"; // Green
        
        // If I haven't sent my key yet (I joined second), send it now
        const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        socket.emit('exchange-key', { key: publicKeyJwk });
    }
});

socket.on('partner-online', async (user) => {
    // If partner comes online, try to handshake again
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

socket.on('receive-message', (msg) => {
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv);
});

socket.on('auth-failure', (msg) => {
    if (msg.includes('Refresh')) location.reload();
    else document.getElementById('error-msg').textContent = msg;
});

socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});
