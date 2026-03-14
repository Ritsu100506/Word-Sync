/**
 * WordSync — Client-side game logic
 * Handles Socket.io events, UI transitions, and player interactions
 */

// ─── Socket Connection ────────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myName = null;       // This player's name
let myColor = null;      // This player's assigned color
let hasSubmitted = false; // Whether we've submitted this round
let playerColors = {};   // { name: color } for all players
let chatHistory = [];    // Cached chat history for this client session

// ─── DOM References ───────────────────────────────────────────────────────────
const screens = {
  lobby:    document.getElementById('screen-lobby'),
  game:     document.getElementById('screen-game'),
  finished: document.getElementById('screen-finished'),
};

// Lobby elements
const nameInput      = document.getElementById('name-input');
const joinBtn        = document.getElementById('join-btn');
const joinError      = document.getElementById('join-error');
const playerList     = document.getElementById('player-list');
const playerCount    = document.getElementById('player-count');
const startBtn       = document.getElementById('start-btn');
const startHint      = document.getElementById('start-hint');

// Game elements
const roundNumber        = document.getElementById('round-number');
const promptLabel        = document.getElementById('prompt-label');
const revealedWordsEl    = document.getElementById('revealed-words');
const wordInput          = document.getElementById('word-input');
const submitWordBtn      = document.getElementById('submit-word-btn');
const wordError          = document.getElementById('word-error');
const submittedConfirm   = document.getElementById('submitted-confirmation');
const playersGrid        = document.getElementById('players-grid');
const historyWrap        = document.getElementById('history-wrap');
const historyList        = document.getElementById('history-list');

// Finished elements
const winningWordEl   = document.getElementById('winning-word');
const roundsTakenEl   = document.getElementById('rounds-taken');
const resultsRoundsEl = document.getElementById('results-rounds');
const playAgainBtn    = document.getElementById('play-again-btn');

// Chat elements
const chatMessagesEl = document.getElementById('chat-messages');
const chatForm       = document.getElementById('chat-form');
const chatInput      = document.getElementById('chat-input');
const chatError      = document.getElementById('chat-error');

// ─── Screen Management ────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── Lobby UI ─────────────────────────────────────────────────────────────────

// Render the player list in the lobby
function renderLobbyPlayers(players) {
  playerCount.textContent = players.length;
  playerList.innerHTML = '';

  if (players.length === 0) {
    playerList.innerHTML = '<li class="empty-state">Waiting for players…</li>';
  } else {
    players.forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const isMe = p.name === myName;
      li.innerHTML = `
        <span class="player-dot" style="background:${p.color}"></span>
        <span class="player-name-label">${escapeHtml(p.name)}</span>
        ${isMe ? '<span class="player-you-tag">you</span>' : ''}
      `;
      playerList.appendChild(li);
      // Track colors
      playerColors[p.name] = p.color;
    });
  }

  // Enable start button only with 2+ players (anyone can start)
  if (players.length >= 2) {
    startBtn.disabled = false;
    startHint.textContent = 'Anyone can start the game';
  } else {
    startBtn.disabled = true;
    startHint.textContent = `Need at least 2 players (${players.length}/2)`;
  }
}

// ─── Game UI ──────────────────────────────────────────────────────────────────

// Render the players grid (shows who has submitted)
function renderPlayersGrid(players, revealWords = false) {
  playersGrid.innerHTML = '';
  players.forEach(p => {
    const tile = document.createElement('div');
    tile.className = `player-tile${p.submitted ? ' submitted' : ''}`;
    tile.style.setProperty('--tile-color', p.color);

    // Show the word if we're revealing (only after round ends)
    const wordHtml = revealWords && p.word
      ? `<div class="tile-word reveal">${escapeHtml(p.word)}</div>`
      : `<div class="tile-word"></div>`;

    tile.innerHTML = `
      <div class="tile-name">${escapeHtml(p.name)}${p.name === myName ? ' <span style="color:var(--muted);font-weight:400;font-size:10px">you</span>' : ''}</div>
      <div class="tile-status">${p.submitted ? '✓ submitted' : 'thinking…'}</div>
      ${wordHtml}
    `;
    playersGrid.appendChild(tile);
  });
}

// Update prompt for the current round
function setRoundPrompt(round, revealedWords) {
  roundNumber.textContent = round;

  if (revealedWords && revealedWords.length > 0) {
    promptLabel.textContent = 'Think of a word related to:';
    revealedWordsEl.innerHTML = '';
    revealedWords.forEach((word, i) => {
      const chip = document.createElement('div');
      chip.className = 'word-chip';
      chip.textContent = word;
      chip.style.animationDelay = `${i * 0.08}s`;
      revealedWordsEl.appendChild(chip);
    });
  } else {
    promptLabel.textContent = 'Round 1 — Submit your opening word';
    revealedWordsEl.innerHTML = '';
  }
}

// Reset the word input for a new round
function resetWordInput() {
  hasSubmitted = false;
  wordInput.disabled = false;
  wordInput.value = '';
  submitWordBtn.disabled = false;
  wordError.textContent = '';
  submittedConfirm.textContent = '';
  wordInput.focus();
}

// Add a round to the history panel
function addRoundToHistory(round) {
  historyWrap.classList.remove('hidden');
  const div = document.createElement('div');
  div.className = 'history-round';

  const wordsHtml = Object.entries(round.words).map(([name, word]) => {
    const color = playerColors[name] || '#666';
    return `
      <div class="history-word-item">
        <span class="history-dot" style="background:${color}"></span>
        <span class="history-word-text">${escapeHtml(word)}</span>
        <span class="history-player-name">${escapeHtml(name)}</span>
      </div>
    `;
  }).join('');

  div.innerHTML = `
    <div class="history-round-label">Round ${round.roundNumber}</div>
    <div class="history-words">${wordsHtml}</div>
  `;
  historyList.appendChild(div);
}

// ─── Finished UI ──────────────────────────────────────────────────────────────

function renderFinishScreen(data) {
  winningWordEl.textContent = data.winningWord;
  const r = data.totalRounds;
  roundsTakenEl.innerHTML = `Converged in <strong>${r} round${r !== 1 ? 's' : ''}</strong>`;

  resultsRoundsEl.innerHTML = '';
  data.rounds.forEach(round => {
    const div = document.createElement('div');
    div.className = 'history-round';
    const wordsHtml = Object.entries(round.words).map(([name, word]) => {
      const color = playerColors[name] || '#666';
      return `
        <div class="history-word-item">
          <span class="history-dot" style="background:${color}"></span>
          <span class="history-word-text">${escapeHtml(word)}</span>
          <span class="history-player-name">${escapeHtml(name)}</span>
        </div>
      `;
    }).join('');
    div.innerHTML = `
      <div class="history-round-label">Round ${round.roundNumber}</div>
      <div class="history-words">${wordsHtml}</div>
    `;
    resultsRoundsEl.appendChild(div);
  });

  showScreen('finished');
}

// ─── Chat UI ─────────────────────────────────────────────────────────────────

function formatChatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shouldStickToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 36;
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function makeChatMessageHtml(message) {
  const mineClass = !message.system && message.name === myName ? ' me' : '';
  const systemClass = message.system ? ' system' : '';
  const sender = message.system ? 'System' : escapeHtml(message.name || 'Guest');
  const text = escapeHtml(message.text || '');
  const time = escapeHtml(formatChatTime(message.timestamp));

  return `
    <div class="chat-message${mineClass}${systemClass}">
      <div class="chat-message-meta">
        <span class="chat-message-name">${sender}</span>
        <span class="chat-message-time">${time}</span>
      </div>
      <div class="chat-message-text">${text}</div>
    </div>
  `;
}

function renderChatHistory(messages) {
  chatHistory = Array.isArray(messages) ? messages.slice() : [];
  chatMessagesEl.innerHTML = '';

  if (chatHistory.length === 0) {
    chatMessagesEl.innerHTML = '<p class="chat-empty">No messages yet.</p>';
    return;
  }

  chatHistory.forEach((message) => {
    chatMessagesEl.insertAdjacentHTML('beforeend', makeChatMessageHtml(message));
  });
  scrollChatToBottom();
}

function addChatMessage(message) {
  const stickToBottom = shouldStickToBottom(chatMessagesEl);
  const hasEmpty = chatMessagesEl.querySelector('.chat-empty');
  if (hasEmpty) {
    chatMessagesEl.innerHTML = '';
  }

  chatHistory.push(message);
  chatMessagesEl.insertAdjacentHTML('beforeend', makeChatMessageHtml(message));

  if (stickToBottom) {
    scrollChatToBottom();
  }
}

// ─── Socket Events ────────────────────────────────────────────────────────────

// Initial sync when we connect (e.g., on page refresh)
socket.on('state_sync', (state) => {
  // Rebuild color map
  state.players.forEach(p => { playerColors[p.name] = p.color; });
  renderChatHistory(state.chatMessages);

  if (state.phase === 'lobby') {
    showScreen('lobby');
    renderLobbyPlayers(state.players);
  } else if (state.phase === 'submitting') {
    // Reconnected mid-game — show game screen
    showScreen('game');
    setRoundPrompt(state.currentRound, state.revealedWords);
    renderPlayersGrid(state.players);
  } else if (state.phase === 'finished') {
    showScreen('finished');
  }
});

// A player joined or their status changed
socket.on('players_update', (players) => {
  players.forEach(p => { playerColors[p.name] = p.color; });

  if (screens.lobby.classList.contains('active')) {
    renderLobbyPlayers(players);
  } else if (screens.game.classList.contains('active')) {
    renderPlayersGrid(players);
  }
});

// Lobby: join succeeded
socket.on('join_success', ({ name, color }) => {
  myName = name;
  myColor = color;
  joinError.textContent = '';
  nameInput.disabled = true;
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joined ✓';
});

// Lobby: join failed
socket.on('join_error', (msg) => {
  joinError.textContent = msg;
});

// Chat send error
socket.on('chat_error', (msg) => {
  chatError.textContent = msg;
});

// New incoming chat message
socket.on('chat_message', (message) => {
  addChatMessage(message);
});

// Game started — transition to game screen
socket.on('game_started', ({ players, round, revealedWords }) => {
  players.forEach(p => { playerColors[p.name] = p.color; });

  // Reset history
  historyList.innerHTML = '';
  historyWrap.classList.add('hidden');

  showScreen('game');
  setRoundPrompt(round, revealedWords);
  renderPlayersGrid(players);
  resetWordInput();
});

// A round just ended — show reveal, then set up next round
socket.on('round_reveal', ({ round, nextRound, revealedWords, players }) => {
  players.forEach(p => { playerColors[p.name] = p.color; });

  // Show submitted words on tiles briefly before next round
  const playersWithWords = players.map(p => ({
    ...p,
    word: round.words[p.name] || null,
  }));
  renderPlayersGrid(playersWithWords, true);

  // Add to history
  addRoundToHistory(round);

  // After a short pause, advance to next round
  setTimeout(() => {
    setRoundPrompt(nextRound, revealedWords);
    renderPlayersGrid(players);
    resetWordInput();
  }, 2200);
});

// Word submission error
socket.on('word_error', (msg) => {
  wordError.textContent = msg;
});

// Game finished!
socket.on('game_finished', (data) => {
  // Brief pause so players see the last words
  setTimeout(() => {
    renderFinishScreen(data);
  }, 1800);
});

// Game was reset
socket.on('game_reset', () => {
  myName = null;
  myColor = null;
  hasSubmitted = false;
  playerColors = {};
  historyList.innerHTML = '';
  historyWrap.classList.add('hidden');
  nameInput.disabled = false;
  nameInput.value = '';
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join';
  joinError.textContent = '';
  chatError.textContent = '';
  showScreen('lobby');
  renderLobbyPlayers([]);
});

// ─── User Interactions ────────────────────────────────────────────────────────

// Join game
function handleJoin() {
  const name = nameInput.value.trim();
  if (!name) {
    joinError.textContent = 'Please enter your name.';
    return;
  }
  socket.emit('join_lobby', { name });
}

joinBtn.addEventListener('click', handleJoin);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleJoin();
});

// Start game
startBtn.addEventListener('click', () => {
  socket.emit('start_game');
});

// Submit word during game
function handleWordSubmit() {
  if (hasSubmitted) return;
  const word = wordInput.value.trim();
  if (!word) {
    wordError.textContent = 'Please enter a word.';
    return;
  }
  if (word.includes(' ')) {
    wordError.textContent = 'One word only — no spaces!';
    return;
  }

  socket.emit('submit_word', { word });
  hasSubmitted = true;
  wordInput.disabled = true;
  submitWordBtn.disabled = true;
  wordError.textContent = '';
  submittedConfirm.textContent = `✓ "${word}" submitted — waiting for others…`;
}

submitWordBtn.addEventListener('click', handleWordSubmit);
wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleWordSubmit();
});

// Play again → reset
playAgainBtn.addEventListener('click', () => {
  socket.emit('reset_game');
});

// Chat submit
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;
  if (text.length > 180) {
    chatError.textContent = 'Message is too long (max 180 characters).';
    return;
  }

  socket.emit('send_chat', { text });
  chatInput.value = '';
  chatError.textContent = '';
});

// ─── Utility ─────────────────────────────────────────────────────────────────

// Escape HTML to prevent XSS from player-submitted content
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
