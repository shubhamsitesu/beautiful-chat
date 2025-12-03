const socket = io();

// DOM Elements
const loginContainer = document.getElementById('login-container');
const chatContainer = document.getElementById('chat-container');
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('message-input');
const messagesDiv = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const partnerStatusEl = document.getElementById('partner-status');
const timerSetting = document.getElementById('timer-setting');

// Video Elements
const mediaContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startCallBtn = document.getElementById('start-call-btn');
const endCallBtn = document.getElementById('end-call-btn');

let myKey = null;
let myUsername = null;
let typingTimeout = null;
let peerConnection = null;
let localStream = null;

const iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- CRYPTO FUNCTIONS ---
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("fixed_salt_for_demo"), iterations: 300000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

async function encryptMessage(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = enc.encode(text);
    const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, myKey, encoded);
    return { iv: Array.from(iv), content: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptMessage(data) {
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(data.iv) }, myKey, new Uint8Array(data.content)
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "⚠️ Decryption Failed"; }
}

// --- UI FUNCTIONS ---
function addMessage(text, type, messageId, user = null) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.setAttribute('data-id', messageId);

    if (type === 'received' && user) {
        const header = document.createElement('div');
        header.classList.add('message-header');
        header.textContent = user;
        div.appendChild(header);
    }

    const content = document.createElement('span');
    content.textContent = text;
    div.appendChild(content);

    if (type === 'sent') {
        const statusEl = document.createElement('span');
        statusEl.classList.add('status-icon');
        statusEl.innerHTML = '✔️'; // Single Tick
        div.appendChild(statusEl);
    }

    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateMessageStatus(id, status) {
    const el = document.querySelector(`.message[data-id="${id}"] .status-icon`);
    if (!el) return;
    if (status === 'delivered') { el.innerHTML = '✔️✔️'; el.style.color = '#999'; }
    if (status === 'read') { el.innerHTML = '✔️✔️'; el.style.color = '#34b7f1'; } // Blue ticks
}

function startTimer(messageId, seconds) {
    const el = document.querySelector(`.message[data-id="${messageId}"]`);
    if (!el || el.querySelector('.countdown-timer')) return;

    const timerEl = document.createElement('span');
    timerEl.classList.add('countdown-timer');
    el.appendChild(timerEl);

    let left = seconds;
    const interval = setInterval(() => {
        left--;
        timerEl.textContent = `💣 ${left}s`;
        if (left <= 0) {
            clearInterval(interval);
            el.textContent = "— 💥 Self-Destructed —";
            el.className = "message deleted";
            socket.emit('self-destruct-complete', messageId);
        }
    }, 1000);
}

// --- EVENT LISTENERS ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (!user || !pass) return;

    myUsername = user;
    myKey = await deriveKey(pass);
    
    document.title = `Chat - ${user}`;
    socket.emit('join-chat', { username: user, roomKey: pass });
    
    loginContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = msgInput.value;
    if (!text) return;

    const id = crypto.randomUUID();
    const encrypted = await encryptMessage(text);
    const timer = parseInt(timerSetting.value);

    socket.emit('send-message', { encryptedData: encrypted, messageId: id, timer: timer }, (isDelivered) => {
        if (isDelivered) updateMessageStatus(id, 'delivered');
    });

    addMessage(text, 'sent', id, myUsername);
    msgInput.value = '';
});

msgInput.addEventListener('input', () => {
    socket.emit('typing');
});

// --- SOCKET EVENTS ---
socket.on('receive-message', async ({ user, data, messageId, timer }) => {
    typingIndicator.textContent = '';
    const text = await decryptMessage(data);
    addMessage(text, 'received', messageId, user);
    socket.emit('message-viewed', messageId);
    if (timer > 0) startTimer(messageId, timer);
});

socket.on('message-read', (id) => updateMessageStatus(id, 'read'));
socket.on('message-deleted', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el) {
        el.textContent = "— Partner deleted message —";
        el.className = "message deleted";
    }
});

socket.on('is-typing', (user) => {
    typingIndicator.textContent = `${user} is typing...`;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { typingIndicator.textContent = ''; }, 2000);
});

socket.on('partner-online', (user) => {
    partnerStatusEl.textContent = `🟢 ${user} Online`;
    partnerStatusEl.style.color = '#25d366';
});

socket.on('partner-offline', () => {
    partnerStatusEl.textContent = '⚫ Offline';
    partnerStatusEl.style.color = '#999';
});

socket.on('system-message', (msg) => {
    const div = document.createElement('div');
    div.classList.add('system-msg');
    div.textContent = msg;
    messagesDiv.appendChild(div);
});

socket.on('error-message', (msg) => alert(msg));


// --- WEBRTC VIDEO CALL LOGIC ---
async function setupMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        return true;
    } catch(e) { alert("Camera Access Denied"); return false; }
}

function createPeer(isCaller, targetId) {
    peerConnection = new RTCPeerConnection(iceServers);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
        remoteVideo.srcObject = e.streams[0];
        mediaContainer.classList.remove('hidden');
    };
    peerConnection.onicecandidate = e => {
        if(e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, receiverId: targetId });
    };

    if(isCaller) {
        peerConnection.onnegotiationneeded = async () => {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('call-offer', offer);
        };
    }
}

startCallBtn.addEventListener('click', async () => {
    if(await setupMedia()) {
        createPeer(true, null);
        startCallBtn.classList.add('hidden');
        endCallBtn.classList.remove('hidden');
    }
});

endCallBtn.addEventListener('click', () => {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(t => t.stop());
    mediaContainer.classList.add('hidden');
    startCallBtn.classList.remove('hidden');
    endCallBtn.classList.add('hidden');
    socket.emit('end-call');
});

socket.on('call-offer', async ({offer, sender, senderId}) => {
    if(confirm(`${sender} is calling... Accept?`)) {
        if(await setupMedia()) {
            createPeer(false, senderId);
            await peerConnection.setRemoteDescription(offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('call-answer', { answer, receiverId: senderId });
            mediaContainer.classList.remove('hidden');
            startCallBtn.classList.add('hidden');
            endCallBtn.classList.remove('hidden');
        }
    }
});

socket.on('call-answer', async ({answer}) => {
    if(peerConnection) await peerConnection.setRemoteDescription(answer);
});

socket.on('ice-candidate', async (candidate) => {
    if(peerConnection) await peerConnection.addIceCandidate(candidate);
});

socket.on('end-call', () => {
    alert('Call Ended');
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(t => t.stop());
    mediaContainer.classList.add('hidden');
    startCallBtn.classList.remove('hidden');
    endCallBtn.classList.add('hidden');
});
