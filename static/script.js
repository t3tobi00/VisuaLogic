// --- Global State & Constants ---
// Use sessionStorage for tab-specific user identity
let currentUserId = sessionStorage.getItem('group_decider_user_id_v4_topsis_tab');
let currentUserName = sessionStorage.getItem('group_decider_user_name_v4_topsis_tab');
let currentRoomData = null;
let isHost = false;

const FAKE_DATA_ITEMS_FRONTEND = [
    { id: 'p1', name: 'Eiffel Tower', category: 'Landmark', type: 'place' },
    { id: 'r1', name: 'Pizza Place Roma', category: 'Italian', type: 'restaurant' },
    { id: 'a1', name: 'Cinema City - Action Movie', category: 'Entertainment', type: 'activity' },
    { id: 'p2', name: 'Louvre Museum', category: 'Art', type: 'place' },
    { id: 'r2', name: 'Sushi Samba', category: 'Japanese', type: 'restaurant' },
    { id: 'a2', name: 'The Board Room Cafe', category: 'Games', type: 'activity' },
];

const EMOTION_RATINGS_FRONTEND = {
    'VERY_INTERESTED': { emoji: '😍', score: 5, label: 'Very Interested' },
    'INTERESTED': { emoji: '🙂', score: 3, label: 'Interested' },
    'OKAY': { emoji: '😐', score: 1, label: 'Okay' },
    'NOT_INTERESTED': { emoji: '😕', score: -2, label: 'Not Interested' },
    'NOT_AT_ALL': { emoji: '😠', score: -5, label: 'Not Interested At All' }
};
const EMOTION_KEYS_FRONTEND = Object.keys(EMOTION_RATINGS_FRONTEND);

// --- Socket.IO Connection ---
const socket = io();

socket.on('connect', () => {
    console.log('CLIENT: Connected to Socket.IO server with SID:', socket.id);
    // Ensure currentUserId exists before trying to rejoin
    if (currentUserId && currentRoomData && currentRoomData.id) {
        console.log('CLIENT: Re-emitting join_sio_room on connect for room:', currentRoomData.id, "User:", currentUserId);
        socket.emit('join_sio_room', { room_id: currentRoomData.id, user_id: currentUserId });
    }
});

socket.on('disconnect', (reason) => {
    console.warn('CLIENT: Disconnected from Socket.IO server:', reason);
});

socket.on('connect_error', (error) => {
    console.error('CLIENT: Socket.IO connection error:', error);
    setHomeError("Connection to server failed. Please refresh.");
});

socket.on('room_state_updated', (data) => {
    console.log('CLIENT: Received room_state_updated. Raw data snippet:', JSON.stringify(data).substring(0, 200) + "...");
    if (!data || !data.room) {
        console.error("CLIENT: room_state_updated received invalid data or no room object:", data);
        return;
    }
    console.log("CLIENT: Processing room_state_updated. Current room ID:", currentRoomData ? currentRoomData.id : "None", "Received room ID:", data.room.id, "My User ID:", currentUserId);

    const wasPreviouslyInARoom = !!currentRoomData;
    const previousRoomId = wasPreviouslyInARoom ? currentRoomData.id : null;

    // Check if this update is relevant to the current tab's user
    const isMemberOfReceivedRoom = data.room.members && data.room.members.find(m => m.id === currentUserId);

    if (isMemberOfReceivedRoom) {
        currentRoomData = data.room;
        isHost = currentRoomData.host_id === currentUserId;

        if (!wasPreviouslyInARoom || (previousRoomId && previousRoomId !== currentRoomData.id)) {
            // First update for this room in this tab, or switched rooms
            console.log("CLIENT: First room update or switched room. Transitioning to room page for room:", currentRoomData.id);
            showRoomPageUI();
        } else if (previousRoomId && currentRoomData.id === previousRoomId) {
            // Subsequent update for the same room
            console.log("CLIENT: Subsequent room update. Re-rendering room page for room:", currentRoomData.id);
            renderRoomPageUI();
        }
    } else if (currentRoomData && currentRoomData.id === data.room.id && !isMemberOfReceivedRoom) {
        // Was in this room, but no longer a member (e.g., kicked or left from another tab - though explicit leave is better)
        console.log("CLIENT: No longer a member of room", data.room.id, ". Leaving room.");
        alert("You are no longer in this room.");
        leaveCurrentRoomClientSide(); // Clean up client state and go home
    } else {
        console.log("CLIENT: Received update for a room I'm not part of or not relevant. Ignoring. Received Room ID:", data.room.id);
    }
});


// --- API Helper ---
async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }
    try {
        // console.log(`CLIENT: API Call - ${method} ${endpoint}`, body ? body : ''); // Can be noisy
        const response = await fetch(`/api${endpoint}`, options);
        const responseText = await response.text();
        if (!response.ok) {
            let errorData;
            try { errorData = JSON.parse(responseText); }
            catch (e) { errorData = { error: `Server returned non-JSON error (Status ${response.status}): ${responseText.substring(0, 100)}` }; }
            console.error(`CLIENT: API Error (${response.status}) ${endpoint}:`, errorData.error || responseText);
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        if (response.status === 204 || !responseText) return null;
        return JSON.parse(responseText);
    } catch (error) {
        console.error(`CLIENT: Fetch Error ${endpoint}:`, error);
        throw error;
    }
}

// --- Initialization ---
window.onload = () => {
    console.log("CLIENT: window.onload");
    // Use sessionStorage for tab-specific user ID
    if (!sessionStorage.getItem('group_decider_user_id_v4_topsis_tab')) {
        currentUserId = 'user_' + Date.now().toString().slice(-6) + Math.random().toString(36).substring(2, 6);
        sessionStorage.setItem('group_decider_user_id_v4_topsis_tab', currentUserId);
        console.log("CLIENT: Generated new currentUserId for this tab:", currentUserId);
    } else {
        currentUserId = sessionStorage.getItem('group_decider_user_id_v4_topsis_tab');
        console.log("CLIENT: Using existing currentUserId for this tab:", currentUserId);
    }

    // User name can also be tab-specific or prompt every time a new tab opens without a name
    currentUserName = sessionStorage.getItem('group_decider_user_name_v4_topsis_tab');
    if (currentUserName) {
        document.getElementById('userName').value = currentUserName;
        document.getElementById('currentUserDisplay').textContent = `You are: ${currentUserName} (ID: ${currentUserId.slice(-6)})`;
        console.log("CLIENT: Using existing currentUserName for this tab:", currentUserName);
    } else {
        // Optional: Prompt for name if not set for this tab
        // For now, user has to click "Set Name"
        document.getElementById('currentUserDisplay').textContent = `Your ID: ${currentUserId.slice(-6)} (Please set your name)`;
    }

    // Attempt to restore room if user was in one (more advanced, requires storing currentRoomId in sessionStorage too)
    const storedRoomId = sessionStorage.getItem('group_decider_current_room_id_tab');
    if (storedRoomId && currentUserName) { // Only try to rejoin if name is also set
        console.log("CLIENT: Found storedRoomId in sessionStorage:", storedRoomId, "Attempting to rejoin.");
        // We can't just set currentRoomData, we need to fetch its state or join
        // For simplicity, let's just clear it and user has to manually rejoin.
        // A more robust solution would be to try and fetch the room state for storedRoomId.
        // For now, let's just make them rejoin.
        sessionStorage.removeItem('group_decider_current_room_id_tab'); // Clear it so they don't get stuck
    }


    showHomePageUI();
    renderLocalSearchResults('');
    setupDragAndDrop();
};

function setUserName() {
    const nameInput = document.getElementById('userName').value.trim();
    if (!nameInput) {
        alert("Please enter your name.");
        return;
    }
    currentUserName = nameInput;
    // Store in sessionStorage for this tab
    sessionStorage.setItem('group_decider_user_name_v4_topsis_tab', currentUserName);
    document.getElementById('currentUserDisplay').textContent = `You are: ${currentUserName} (ID: ${currentUserId.slice(-6)})`;
    console.log("CLIENT: Name set for this tab:", currentUserName);
    alert("Name set: " + currentUserName);
}


// --- UI Navigation ---
function showHomePageUI() {
    console.log("CLIENT: showHomePageUI()");
    document.getElementById('homePage').classList.remove('hidden');
    document.getElementById('roomPage').classList.add('hidden');
    setHomeError('');
}

function showRoomPageUI() {
    console.log("CLIENT: showRoomPageUI() called.");
    if (!currentUserName) { // User must have a name to enter a room
        alert("Please set your name first on the home page!");
        console.warn("CLIENT: showRoomPageUI() - currentUserName not set for this tab.");
        showHomePageUI(); // Send back to home
        return;
    }
    if (!currentRoomData) {
        alert("Error: No room data available to show room page.");
        console.error("CLIENT: showRoomPageUI() - currentRoomData is null.");
        showHomePageUI();
        return;
    }
    console.log("CLIENT: Transitioning to room page. Room ID:", currentRoomData.id);
    document.getElementById('homePage').classList.add('hidden');
    document.getElementById('roomPage').classList.remove('hidden');
    renderRoomPageUI();
    showTab('myRoom');
}

function setHomeError(message) {
    const errorEl = document.getElementById('homeError');
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
    if (message) console.error("CLIENT: Home Error Set - ", message);
}

// --- Room Actions ---
async function createRoom() {
    console.log("CLIENT: createRoom() called.");
    if (!currentUserName) { alert("Please set your name on the home page first!"); return; }
    const roomName = document.getElementById('createRoomName').value.trim();
    if (!roomName) { alert("Please enter a room name."); return; }

    try {
        const data = await apiCall('/create_room', 'POST', {
            room_name: roomName,
            user_name: currentUserName,
            user_id: currentUserId // Tab-specific user ID
        });
        // currentRoomData will be set by the 'room_state_updated' event
        // after the server processes the join_sio_room emit.
        console.log("CLIENT: Room created via API (response):", data.room.id, "Emitting join_sio_room.");
        socket.emit('join_sio_room', { room_id: data.room.id, user_id: currentUserId });
        sessionStorage.setItem('group_decider_current_room_id_tab', data.room.id); // Store current room for this tab
        // The 'room_state_updated' handler will call showRoomPageUI
    } catch (error) {
        setHomeError(`Failed to create room: ${error.message}`);
    }
}

async function joinRoom() {
    console.log("CLIENT: joinRoom() called.");
    if (!currentUserName) { alert("Please set your name on the home page first!"); return; }
    const roomIdToJoin = document.getElementById('joinRoomIdInput').value.trim().toUpperCase();
    if (!roomIdToJoin) { alert("Please enter a Room ID."); return; }

    try {
        // The API call itself adds the user to the room's member list on the server
        const data = await apiCall('/join_room', 'POST', {
            room_id: roomIdToJoin,
            user_name: currentUserName,
            user_id: currentUserId // Tab-specific user ID
        });
        console.log("CLIENT: Room joined via API (response):", data.room.id, "Emitting join_sio_room.");
        socket.emit('join_sio_room', { room_id: data.room.id, user_id: currentUserId });
        sessionStorage.setItem('group_decider_current_room_id_tab', data.room.id);
        // The 'room_state_updated' handler will call showRoomPageUI
    } catch (error) {
        setHomeError(`Failed to join room: ${error.message}`);
    }
}

// Client-side cleanup and navigation
function leaveCurrentRoomClientSide() {
    console.log("CLIENT: leaveCurrentRoomClientSide() called.");
    currentRoomData = null;
    isHost = false;
    sessionStorage.removeItem('group_decider_current_room_id_tab');
    showHomePageUI();
}

async function leaveCurrentRoom() {
    console.log("CLIENT: leaveCurrentRoom() API call initiated.");
    if (!currentRoomData) {
        leaveCurrentRoomClientSide(); // Already not in a room client-side
        return;
    }
    const roomId = currentRoomData.id; // Store before clearing currentRoomData
    try {
        await apiCall(`/room/${roomId}/leave`, 'POST', { user_id: currentUserId });
        console.log("CLIENT: Emitting leave_sio_room for room:", roomId);
        socket.emit('leave_sio_room', { room_id: roomId, user_id: currentUserId });
    } catch (error) {
        // Even if API fails, proceed with client-side cleanup
        alert(`Failed to notify server about leaving room: ${error.message}. You will be removed locally.`);
    } finally {
        leaveCurrentRoomClientSide();
    }
}

// ... (copyRoomIdToClipboard, filterLocalItems, renderLocalSearchResults - same)
function copyRoomIdToClipboard() {
    if (!currentRoomData) return;
    navigator.clipboard.writeText(currentRoomData.id).then(() => {
        alert('Room ID copied to clipboard!');
    }).catch(err => { console.error('CLIENT: Failed to copy Room ID: ', err); prompt("Copy Room ID:", currentRoomData.id); });
}
function filterLocalItems() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    renderLocalSearchResults(searchTerm);
}
function renderLocalSearchResults(term) {
    const resultsUl = document.getElementById('searchResults');
    resultsUl.innerHTML = '';
    const filtered = FAKE_DATA_ITEMS_FRONTEND.filter(item =>
        item.name.toLowerCase().includes(term) || item.category.toLowerCase().includes(term) || item.type.toLowerCase().includes(term)
    );
    filtered.forEach(item => {
        const li = document.createElement('li');
        li.innerHTML = `<div class="item-main-info"><span class="item-text">${item.name} (${item.category})</span></div>`;
        li.draggable = true;
        li.dataset.itemId = item.id; li.dataset.itemName = item.name;
        li.dataset.itemCategory = item.category; li.dataset.itemType = item.type;
        li.addEventListener('dragstart', handleDragStart);
        resultsUl.appendChild(li);
    });
}


// --- Drag & Drop (same as before, ensure console logs for debugging) ---
let draggedItemData = null;
function handleDragStart(event) {
    draggedItemData = {
        id: event.target.dataset.itemId, name: event.target.dataset.itemName,
        category: event.target.dataset.itemCategory, type: event.target.dataset.itemType,
        uniqueInstanceId: event.target.dataset.uniqueInstanceId,
        isCustomFromPrivate: !!event.target.dataset.uniqueInstanceId
    };
    // console.log("CLIENT: Drag Start - ", draggedItemData); // Can be noisy
    event.dataTransfer.setData('application/json', JSON.stringify(draggedItemData));
}
function setupDragAndDrop() {
    ['myRoomDropZone', 'publicRoomDropZone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        zone.addEventListener('dragover', handleDragOver);
        zone.addEventListener('dragleave', handleDragLeave);
        zone.addEventListener('drop', handleDrop);
    });
}
function handleDragOver(event) { event.preventDefault(); event.currentTarget.classList.add('drag-over'); }
function handleDragLeave(event) { event.currentTarget.classList.remove('drag-over'); }
async function handleDrop(event) {
    event.preventDefault(); event.currentTarget.classList.remove('drag-over');
    if (!currentRoomData || !currentUserId) return; // Need user context
    const droppedItem = JSON.parse(event.dataTransfer.getData('application/json'));
    // console.log("CLIENT: Drop Event - Target:", event.currentTarget.id, "Item:", droppedItem); // Can be noisy
    const targetZoneId = event.currentTarget.id;
    try {
        if (targetZoneId === 'myRoomDropZone') {
            await apiCall(`/room/${currentRoomData.id}/item/private`, 'POST', {
                user_id: currentUserId, // Use tab-specific user ID
                item: { name: droppedItem.name, category: droppedItem.category, type: droppedItem.type, item_original_id: droppedItem.id }
            });
        } else if (targetZoneId === 'publicRoomDropZone') {
            if (droppedItem.isCustomFromPrivate) {
                await apiCall(`/room/${currentRoomData.id}/item/send_to_public`, 'POST', {
                    user_id: currentUserId, // Tab-specific user ID
                    user_name: currentUserName, private_item_instance_id: droppedItem.uniqueInstanceId
                });
            } else {
                alert("To add from search to public: first drag to 'My Ideas', then 'Send to Group'.");
                console.log("CLIENT: Item from search dropped on public. User should add to private then send.");
            }
        }
    } catch (error) { alert(`Error handling drop: ${error.message}`); }
}

// --- Item Actions (Private & Public - ensure currentUserId is used) ---
async function addCustomItemToPrivate() {
    if (!currentRoomData || !currentUserId) return;
    const inputEl = document.getElementById('myCustomItemInput');
    const itemName = inputEl.value.trim();
    if (!itemName) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/private`, 'POST', {
            user_id: currentUserId, item: { name: itemName, category: 'Custom Idea', type: 'User Input' }
        });
        inputEl.value = '';
    } catch (error) { alert(`Failed to add custom item: ${error.message}`); }
}
async function deletePrivateItem(privateItemInstanceId) {
    if (!currentRoomData || !currentUserId || !confirm("Delete this private item?")) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/private/delete`, 'POST', {
            user_id: currentUserId, item_instance_id: privateItemInstanceId
        });
    } catch (error) { alert(`Failed to delete private item: ${error.message}`); }
}
async function sendToPublic(privateItemInstanceId) {
    if (!currentRoomData || !currentUserId || !currentUserName) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/send_to_public`, 'POST', {
            user_id: currentUserId, user_name: currentUserName, private_item_instance_id: privateItemInstanceId
        });
    } catch (error) { alert(`Failed to send item to public: ${error.message}`); }
}
async function addCustomItemToPublicByHost() {
    if (!currentRoomData || !isHost || !currentUserId || !currentUserName) return;
    const inputEl = document.getElementById('hostCustomItemInput');
    const itemName = inputEl.value.trim();
    if (!itemName) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/public/host_add`, 'POST', {
            user_id: currentUserId, user_name: currentUserName, item: { name: itemName }
        });
        inputEl.value = '';
    } catch (error) { alert(`Failed to add public item: ${error.message}`); }
}
async function deletePublicItem(publicItemInstanceId) {
    if (!currentRoomData || !currentUserId || !currentUserName || !confirm("Delete this public item?")) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/public/delete`, 'POST', {
            user_id: currentUserId, user_name: currentUserName, item_instance_id: publicItemInstanceId
        });
    } catch (error) { alert(`Failed to delete public item: ${error.message}`); }
}

// --- Rating Actions (ensure currentUserId is used) ---
async function rateItem(publicItemInstanceId, emotionKey) {
    if (!currentRoomData || !currentUserId) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/item/public/rate`, 'POST', {
            user_id: currentUserId, item_instance_id: publicItemInstanceId, emotion_key: emotionKey
        });
    } catch (error) { alert(`Failed to rate item: ${error.message}`); }
}
async function finalizeRatings() {
    if (!currentRoomData || !currentUserId) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/finalize_ratings`, 'POST', { user_id: currentUserId });
    } catch (error) { alert(`Failed to finalize ratings: ${error.message}`); }
}
async function restartRatingProcess() {
    if (!currentRoomData || !isHost || !currentUserId || !confirm("Restart rating process for everyone?")) return;
    try {
        await apiCall(`/room/${currentRoomData.id}/restart_ratings`, 'POST', { user_id: currentUserId });
    } catch (error) { alert(`Failed to restart ratings: ${error.message}`); }
}

// --- UI Rendering ---
function showTab(tabName) {
    document.getElementById('myRoomContent').classList.add('hidden');
    document.getElementById('publicRoomContent').classList.add('hidden');
    document.getElementById('myRoomTab').classList.remove('active');
    document.getElementById('publicRoomTab').classList.remove('active');
    if (tabName === 'myRoom') {
        document.getElementById('myRoomContent').classList.remove('hidden');
        document.getElementById('myRoomTab').classList.add('active');
    } else {
        document.getElementById('publicRoomContent').classList.remove('hidden');
        document.getElementById('publicRoomTab').classList.add('active');
    }
}

function renderRoomPageUI() {
    console.log("CLIENT: renderRoomPageUI() called. currentRoomData ID:", currentRoomData ? currentRoomData.id : "null", "My User ID:", currentUserId);
    if (!currentRoomData || !currentUserId) { // Ensure we have context
        console.warn("CLIENT: renderRoomPageUI - currentRoomData or currentUserId is null. Attempting to go home.");
        leaveCurrentRoomClientSide(); // More robust cleanup
        return;
    }

    try {
        document.getElementById('roomPageTitle').textContent = `Room: ${currentRoomData.name || 'N/A'}`;
        document.getElementById('roomPageId').textContent = currentRoomData.id || 'N/A';

        const usersListEl = document.getElementById('roomUsersList');
        usersListEl.innerHTML = '';
        (currentRoomData.members || []).forEach(member => {
            const userSpan = document.createElement('span');
            userSpan.textContent = member.name + (member.id === currentRoomData.host_id ? ' (Host)' : '');
            if (member.id === currentUserId) userSpan.style.fontWeight = 'bold'; // Highlight current tab's user
            usersListEl.appendChild(userSpan);
        });

        isHost = currentRoomData.host_id === currentUserId; // Re-evaluate host status based on tab's user
        document.getElementById('hostAddPublicItemSection').classList.toggle('hidden', !isHost);
        const usersDoneRating = currentRoomData.users_done_rating || [];
        document.getElementById('restartRatingButton').classList.toggle('hidden', !isHost || usersDoneRating.length < (currentRoomData.members || []).length);

        const myRoomItemsUl = document.getElementById('myRoomItems');
        myRoomItemsUl.innerHTML = '';
        const myPrivateItems = (currentRoomData.private_items || {})[currentUserId] || []; // Use tab-specific user ID
        myPrivateItems.forEach(item => {
            const li = document.createElement('li');
            li.dataset.itemName = item.name; li.dataset.itemCategory = item.category;
            li.dataset.itemType = item.type; li.dataset.uniqueInstanceId = item.unique_instance_id;
            li.draggable = true; li.addEventListener('dragstart', handleDragStart);
            const itemMainInfo = document.createElement('div'); itemMainInfo.classList.add('item-main-info');
            const itemText = document.createElement('span'); itemText.classList.add('item-text');
            itemText.textContent = `${item.name} (${item.category || 'Custom'})`;
            itemMainInfo.appendChild(itemText);
            const actionsDiv = document.createElement('div'); actionsDiv.classList.add('item-actions');
            const sendButton = document.createElement('button'); sendButton.textContent = 'Send to Group';
            sendButton.classList.add('send-to-public-button'); sendButton.onclick = () => sendToPublic(item.unique_instance_id);
            actionsDiv.appendChild(sendButton);
            const deleteButton = document.createElement('button'); deleteButton.innerHTML = '';
            deleteButton.title = "Delete this item"; deleteButton.classList.add('delete-icon');
            deleteButton.onclick = () => deletePrivateItem(item.unique_instance_id);
            actionsDiv.appendChild(deleteButton);
            itemMainInfo.appendChild(actionsDiv); li.appendChild(itemMainInfo); myRoomItemsUl.appendChild(li);
        });

        const publicRoomItemsUl = document.getElementById('publicRoomItems');
        publicRoomItemsUl.innerHTML = '';
        (currentRoomData.public_items || []).forEach(item => {
            const li = document.createElement('li');
            const itemMainInfo = document.createElement('div'); itemMainInfo.classList.add('item-main-info');
            const itemDesc = document.createElement('span'); itemDesc.classList.add('item-text');
            itemDesc.textContent = `${item.name} (${item.category || 'N/A'}) - Added by ${item.submitted_by}`;
            itemMainInfo.appendChild(itemDesc);
            const actionsDiv = document.createElement('div'); actionsDiv.classList.add('item-actions');
            // Use currentUserName of this tab for submitter check
            let canDeletePublic = isHost || (item.submitted_by && item.submitted_by.startsWith(currentUserName) && !item.submitted_by.endsWith("(Host)"));
            if (canDeletePublic) {
                const deletePublicBtn = document.createElement('button'); deletePublicBtn.innerHTML = '';
                deletePublicBtn.title = "Delete public item"; deletePublicBtn.classList.add('delete-icon');
                deletePublicBtn.onclick = () => deletePublicItem(item.unique_instance_id);
                actionsDiv.appendChild(deletePublicBtn);
            }
            itemMainInfo.appendChild(actionsDiv); li.appendChild(itemMainInfo);
            const ratingBar = document.createElement('div'); ratingBar.classList.add('emotion-rating-bar');
            const userHasFinalized = usersDoneRating.includes(currentUserId); // Use tab-specific user ID
            const itemRatings = item.ratings || {};
            EMOTION_KEYS_FRONTEND.forEach(key => {
                const emotion = EMOTION_RATINGS_FRONTEND[key];
                const btn = document.createElement('button'); btn.innerHTML = emotion.emoji; btn.title = emotion.label;
                btn.dataset.emotionKey = key;
                if (itemRatings[currentUserId] === key) btn.classList.add('selected-emotion'); // Use tab-specific user ID
                btn.disabled = userHasFinalized; btn.onclick = () => rateItem(item.unique_instance_id, key);
                ratingBar.appendChild(btn);
            });
            li.appendChild(ratingBar);
            let sumScoresDisplay = 0; let countNIADisplay = 0; let numActualRatingsDisplay = 0;
            Object.values(itemRatings).forEach(emotionKey => {
                if (EMOTION_RATINGS_FRONTEND[emotionKey]) {
                    const score = EMOTION_RATINGS_FRONTEND[emotionKey].score; sumScoresDisplay += score; numActualRatingsDisplay++;
                    if (emotionKey === 'NOT_AT_ALL') countNIADisplay++;
                }
            });
            const avgScoreDisplay = numActualRatingsDisplay > 0 ? sumScoresDisplay / numActualRatingsDisplay : 0;
            const scoreDisplayDiv = document.createElement('div'); scoreDisplayDiv.classList.add('item-scores');
            scoreDisplayDiv.textContent = `Avg Score (approx): ${avgScoreDisplay.toFixed(2)}, NIA: ${countNIADisplay}`;
            li.appendChild(scoreDisplayDiv);
            publicRoomItemsUl.appendChild(li);
        });

        updateRatingStatusAndFinalDecisionUI();
        console.log("CLIENT: renderRoomPageUI() completed successfully for user", currentUserId);
    } catch (error) {
        console.error("CLIENT: Error during renderRoomPageUI():", error, "Problematic currentRoomData for user", currentUserId, ":", JSON.stringify(currentRoomData).substring(0, 500) + "...");
        alert("An error occurred while updating the room. Please try refreshing.");
    }
}

function updateRatingStatusAndFinalDecisionUI() {
    if (!currentRoomData || !currentUserId) return; // Ensure context

    const ratingStatusEl = document.getElementById('ratingStatus');
    const finalizeButton = document.getElementById('finalizeRatingsButton');
    const allDecisionsContainerEl = document.getElementById('allDecisionsContainer');
    const scoringDecisionTextEl = document.getElementById('scoringDecisionText');
    const scoringDecisionDetailsEl = document.getElementById('scoringDecisionDetails');
    const topsisDecisionTextEl = document.getElementById('topsisDecisionText');
    const topsisDecisionDetailsEl = document.getElementById('topsisDecisionDetails');

    const usersWhoFinalized = currentRoomData.users_done_rating || [];
    const allMembers = currentRoomData.members || [];

    finalizeButton.disabled = usersWhoFinalized.includes(currentUserId); // Use tab-specific user ID
    finalizeButton.textContent = usersWhoFinalized.includes(currentUserId) ? "You've Finalized Ratings" : "My Final Ratings are Done";

    const remainingToFinalize = allMembers.filter(m => !usersWhoFinalized.includes(m.id));
    if (remainingToFinalize.length > 0) {
        ratingStatusEl.textContent = `Waiting for: ${remainingToFinalize.map(m => m.name).join(', ')} to finalize ratings.`;
        allDecisionsContainerEl.classList.add('hidden');
    } else {
        ratingStatusEl.textContent = "All users have finalized their ratings!";
        allDecisionsContainerEl.classList.remove('hidden');

        if (currentRoomData.final_decision_scoring && currentRoomData.final_decision_scoring.text) {
            scoringDecisionTextEl.innerHTML = currentRoomData.final_decision_scoring.text;
            scoringDecisionDetailsEl.innerHTML = currentRoomData.final_decision_scoring.details || "";
        } else {
            scoringDecisionTextEl.innerHTML = "Scoring decision not available or still calculating.";
            scoringDecisionDetailsEl.innerHTML = "";
        }

        if (currentRoomData.final_decision_topsis && currentRoomData.final_decision_topsis.text) {
            topsisDecisionTextEl.innerHTML = currentRoomData.final_decision_topsis.text;
            topsisDecisionDetailsEl.innerHTML = currentRoomData.final_decision_topsis.details || "";
        } else {
            topsisDecisionTextEl.innerHTML = "TOPSIS decision not available or still calculating.";
            topsisDecisionDetailsEl.innerHTML = "";
        }
    }
}