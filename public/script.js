const socket = io();

// UI Elements
const loginContainer = document.getElementById('login-container');
const chatContainer = document.getElementById('chat-container');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');
const callNotification = document.getElementById('call-notification');
const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

// Buttons
const startCallBtn = document.getElementById('start-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const acceptCallBtn = document.getElementById('accept-call');
const declineCallBtn = document.getElementById('decline-call');

let myKey = null;
let myUsername = null;
let peerConnection = null;
let localStream = null;
const iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- CRYPTO (AES-GCM) ---
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("salt"), iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}
async function encryptMessage(text) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, myKey, encoded);
    return { iv: Array.from(iv), content: Array.from(new Uint8Array(ciphertext)) };
}
async function decryptMessage(data) {
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(data.iv) }, myKey, new Uint8Array(data.content)
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "⚠️ Decryption Error"; }
}

// --- LOGIN ---
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (!user || !pass) return;

    myUsername = user;
    myKey = await deriveKey(pass);
    socket.emit('join-chat', { username: user, roomKey: pass });
    
    loginContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
});

// --- CHAT ---
document.getElementById('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const text = input.value;
    if (!text) return;

    const id = crypto.randomUUID();
    const timer = parseInt(document.getElementById('timer-setting').value);
    const encrypted = await encryptMessage(text);

    addMessage(text, 'sent', id, myUsername);
    socket.emit('send-message', { encryptedData: encrypted, messageId: id, timer: timer }, (isDelivered) => {
        if (isDelivered) updateStatus(id, 'delivered');
    });
    input.value = '';
});

// --- UI HELPER FUNCTIONS ---
function addMessage(text, type, id, user) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.setAttribute('data-id', id);
    
    // Status Icon
    let statusHTML = type === 'sent' ? '<span class="status-icon">✔️</span>' : '';
    
    div.innerHTML = `<div>${text}</div>${statusHTML}`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Mobile Long Press Context Menu
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, id, type === 'sent');
    });
}

function updateStatus(id, status) {
    const el = document.querySelector(`.message[data-id="${id}"] .status-icon`);
    if (el) {
        if (status === 'delivered') el.textContent = '✔️✔️';
        if (status === 'read') { el.textContent = '✔️✔️'; el.style.color = '#00bcd4'; }
    }
}

// --- CLEAR CHAT ---
clearChatBtn.addEventListener('click', () => {
    if(confirm('Clear all chat history?')) {
        socket.emit('clear-chat-room');
    }
});

socket.on('chat-cleared-local', () => {
    messagesDiv.innerHTML = '<div style="text-align:center;color:#888;margin:10px;">Chat Cleared</div>';
});

// --- VIDEO CALL (FIXED) ---
async function setupMedia() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStream = stream;
        localVideo.srcObject = stream; // FIX: Explicit assignment
        return true;
    } catch (e) {
        alert("Camera/Mic access denied.");
        return false;
    }
}

function createPeer(isCaller, targetId) {
    peerConnection = new RTCPeerConnection(iceServers);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = event => {
        // FIX: Ensure remote stream is assigned
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
        videoContainer.classList.remove('hidden');
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) socket.emit('ice-candidate', { candidate: event.candidate });
    };

    if (isCaller) {
        peerConnection.onnegotiationneeded = async () => {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('call-offer', { offer });
        };
    }
}

// Start Call
startCallBtn.addEventListener('click', async () => {
    if (await setupMedia()) {
        createPeer(true, null);
        startCallBtn.classList.add('hidden');
        endCallBtn.classList.remove('hidden');
    }
});

// End Call
endCallBtn.addEventListener('click', () => {
    endCallRoutine();
    socket.emit('end-call');
});

function endCallRoutine() {
    if (peerConnection) peerConnection.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    videoContainer.classList.add('hidden');
    startCallBtn.classList.remove('hidden');
    endCallBtn.classList.add('hidden');
    callNotification.classList.add('hidden');
}

// --- SOCKET EVENTS ---
socket.on('receive-message', async (data) => {
    const text = await decryptMessage(data.data);
    addMessage(text, 'received', data.messageId, data.user);
    socket.emit('message-viewed', data.messageId);
    
    if (data.timer > 0) {
        setTimeout(() => {
             const el = document.querySelector(`.message[data-id="${data.messageId}"]`);
             if(el) { el.textContent = '💥 Destructed'; el.classList.add('deleted'); }
             socket.emit('self-destruct-complete', data.messageId);
        }, data.timer * 1000);
    }
});

socket.on('message-read', (id) => updateStatus(id, 'read'));

socket.on('message-deleted-local', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if(el) { el.textContent = 'Deleted'; el.classList.add('deleted'); }
});
socket.on('message-deleted-partner', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if(el) { el.textContent = 'Partner deleted this'; el.classList.add('deleted'); }
});

socket.on('call-offer', async (data) => {
    callNotification.classList.remove('hidden');
    acceptCallBtn.onclick = async () => {
        callNotification.classList.add('hidden');
        if (await setupMedia()) {
            createPeer(false, null);
            await peerConnection.setRemoteDescription(data.offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('call-answer', { answer });
            videoContainer.classList.remove('hidden');
            startCallBtn.classList.add('hidden');
            endCallBtn.classList.remove('hidden');
        }
    };
    declineCallBtn.onclick = () => {
        callNotification.classList.add('hidden');
        socket.emit('end-call');
    };
});

socket.on('call-answer', async (data) => await peerConnection.setRemoteDescription(data.answer));
socket.on('ice-candidate', async (data) => { if (peerConnection) await peerConnection.addIceCandidate(data.candidate); });
socket.on('end-call', () => endCallRoutine());
socket.on('partner-online', (u) => { partnerStatusEl.textContent = `🟢 ${u} Online`; partnerStatusEl.style.color = '#4CAF50'; });
socket.on('partner-offline', () => { partnerStatusEl.textContent = '⚫ Offline'; partnerStatusEl.style.color = '#aaa'; });

// --- CONTEXT MENU (Delete) ---
function showContextMenu(x, y, id, isSender) {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`; menu.style.top = `${y}px`;
    
    menu.innerHTML = `<button onclick="emitDelete('${id}', 'for_me')">Delete for Me</button>`;
    if (isSender) menu.innerHTML += `<button onclick="emitDelete('${id}', 'for_everyone')">Delete for Everyone</button>`;

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

window.emitDelete = (id, scope) => {
    socket.emit('delete-message', { messageId: id, scope });
    document.querySelector('.context-menu')?.remove();
};
