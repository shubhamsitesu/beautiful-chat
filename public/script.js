const socket = io();

// DOM Elements
const loginContainer = document.getElementById('login-container');
const chatContainer = document.getElementById('chat-container');
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('message-input');
const messagesDiv = document.getElementById('messages');
const errorMsg = document.getElementById('error-msg');

let myKey = null; // Will hold the CryptoKey
let myUsername = null;

// --- 1. CRYPTO FUNCTIONS (Web Crypto API) ---

// Generate a key from the password string
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode("somesalt"), // In prod, salt should be random/unique
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

// Encrypt message
async function encryptMessage(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // Initialization Vector
    const encoded = enc.encode(text);
    
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        myKey,
        encoded
    );

    // Convert buffer to Array to send over socket
    return {
        iv: Array.from(iv),
        content: Array.from(new Uint8Array(ciphertext))
    };
}

// Decrypt message
async function decryptMessage(encryptedData) {
    try {
        const iv = new Uint8Array(encryptedData.iv);
        const content = new Uint8Array(encryptedData.content);
        
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            myKey,
            content
        );

        const dec = new TextDecoder();
        return dec.decode(decrypted);
    } catch (e) {
        return "⚠️ Error: Could not decrypt message (Wrong password?)";
    }
}

// --- 2. UI LOGIC ---

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    if(!username || !password) return;

    myUsername = username;
    
    // Create the crypto key from password immediately
    myKey = await deriveKey(password);

    // Join the room (password is the room ID)
    socket.emit('join-chat', { username, roomKey: password });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = msgInput.value;
    if(!text) return;

    // Encrypt before sending
    const encryptedData = await encryptMessage(text);
    
    // Send to server
    socket.emit('send-message', encryptedData);

    // Show my own message immediately
    addMessage(text, 'sent');
    msgInput.value = '';
});

document.getElementById('leave-btn').addEventListener('click', () => {
    location.reload();
});

function addMessage(text, type) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// --- 3. SOCKET EVENTS ---

socket.on('receive-message', async ({ user, data }) => {
    const text = await decryptMessage(data);
    addMessage(`${user}: ${text}`, 'received');
});

socket.on('system-message', (msg) => {
    // Switch to chat view if not already
    loginContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    
    const div = document.createElement('div');
    div.classList.add('system-msg');
    div.textContent = msg;
    messagesDiv.appendChild(div);
});

socket.on('error-message', (msg) => {
    errorMsg.textContent = msg;
});
