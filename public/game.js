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
let lastSubmittedWord = '';
let playerColors = {};   // { name: color } for all players
let chatHistory = [];    // Cached chat history for this client session
let topWarningTimeout = null;
let suggestionAbortController = null;
let suggestionDebounceTimer = null;

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
const roundTimer         = document.getElementById('round-timer');
const promptLabel        = document.getElementById('prompt-label');
const revealedWordsEl    = document.getElementById('revealed-words');
const wordInput          = document.getElementById('word-input');
const submitWordBtn      = document.getElementById('submit-word-btn');
const editWordBtn        = document.getElementById('edit-word-btn');
const wordSuggestionsEl  = document.getElementById('word-suggestions');
const wordError          = document.getElementById('word-error');
const submittedConfirm   = document.getElementById('submitted-confirmation');
const playersGrid        = document.getElementById('players-grid');
const historyWrap        = document.getElementById('history-wrap');
const historyList        = document.getElementById('history-list');
const topWarningCard     = document.getElementById('top-warning-card');

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
    revealedWords.forEach((entry, i) => {
      const word = typeof entry === 'string' ? entry : entry.word;
      const count = typeof entry === 'string' ? 1 : Number(entry.count || 1);
      const chip = document.createElement('div');
      chip.className = 'word-chip';
      chip.innerHTML = `${escapeHtml(word)}${count > 1 ? ` <span class="chip-count">x${count}</span>` : ''}`;
      chip.style.animationDelay = `${i * 0.08}s`;
      revealedWordsEl.appendChild(chip);
    });
  } else {
    promptLabel.textContent = `Round ${round} — Submit your word`;
    revealedWordsEl.innerHTML = '';
  }
}

// Reset the word input for a new round
function resetWordInput() {
  hasSubmitted = false;
  lastSubmittedWord = '';
  wordInput.disabled = false;
  wordInput.value = '';
  submitWordBtn.disabled = false;
  editWordBtn.classList.add('hidden');
  editWordBtn.disabled = true;
  wordError.textContent = '';
  submittedConfirm.textContent = '';
  clearWordSuggestions();
  wordInput.focus();
}

function setSubmittedState(word) {
  hasSubmitted = true;
  lastSubmittedWord = word;
  wordInput.disabled = true;
  submitWordBtn.disabled = true;
  editWordBtn.disabled = false;
  editWordBtn.classList.remove('hidden');
  wordError.textContent = '';
  submittedConfirm.textContent = `✓ "${word}" submitted — waiting for others…`;
  clearWordSuggestions();
}

function setEditableState(prefillWord = '') {
  hasSubmitted = false;
  wordInput.disabled = false;
  submitWordBtn.disabled = false;
  editWordBtn.classList.add('hidden');
  editWordBtn.disabled = true;
  if (prefillWord) {
    wordInput.value = prefillWord;
  }
  if (wordInput.value.trim().length < 2) {
    clearWordSuggestions();
  }
  submittedConfirm.textContent = '';
  wordInput.focus();
}

function setWaitingForNextRoundState() {
  hasSubmitted = false;
  wordInput.disabled = true;
  submitWordBtn.disabled = true;
  editWordBtn.classList.add('hidden');
  editWordBtn.disabled = true;
  submittedConfirm.textContent = '';
  clearWordSuggestions();
}

function clearWordSuggestions() {
  if (suggestionAbortController) {
    suggestionAbortController.abort();
    suggestionAbortController = null;
  }
  if (suggestionDebounceTimer) {
    clearTimeout(suggestionDebounceTimer);
    suggestionDebounceTimer = null;
  }
  wordSuggestionsEl.innerHTML = '';
  wordSuggestionsEl.classList.add('hidden');
}

function renderWordSuggestions(words) {
  wordSuggestionsEl.innerHTML = '';

  if (!Array.isArray(words) || words.length === 0) {
    wordSuggestionsEl.classList.add('hidden');
    return;
  }

  words.forEach((word) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'word-suggestion-item';
    btn.textContent = word;
    btn.addEventListener('click', () => {
      wordInput.value = word;
      clearWordSuggestions();
      wordInput.focus();
    });
    wordSuggestionsEl.appendChild(btn);
  });

  const note = document.createElement('div');
  note.className = 'word-suggestions-note';
  note.textContent = 'English suggestions to help spelling.';
  wordSuggestionsEl.appendChild(note);
  wordSuggestionsEl.classList.remove('hidden');
}

async function fetchEnglishWordSuggestions(query) {
  if (suggestionAbortController) {
    suggestionAbortController.abort();
  }
  suggestionAbortController = new AbortController();

  const url = `https://api.datamuse.com/sug?s=${encodeURIComponent(query)}&max=8&v=enwiki`;
  const res = await fetch(url, { signal: suggestionAbortController.signal });
  if (!res.ok) throw new Error('Suggestion lookup failed');

  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .map((entry) => String(entry.word || '').toLowerCase())
    .filter((w) => /^[a-z]+$/.test(w));
}

function scheduleWordSuggestions() {
  if (hasSubmitted || wordInput.disabled) {
    clearWordSuggestions();
    return;
  }

  const query = wordInput.value.trim().toLowerCase();
  if (query.length < 2 || query.includes(' ')) {
    clearWordSuggestions();
    return;
  }

  if (suggestionDebounceTimer) {
    clearTimeout(suggestionDebounceTimer);
  }

  suggestionDebounceTimer = setTimeout(async () => {
    try {
      const suggestions = await fetchEnglishWordSuggestions(query);
      renderWordSuggestions(suggestions.filter((w) => w !== query));
    } catch (err) {
      if (err.name !== 'AbortError') {
        clearWordSuggestions();
      }
    }
  }, 220);
}

function toWordCountMap(round) {
  if (Array.isArray(round.wordStats) && round.wordStats.length > 0) {
    const map = new Map();
    round.wordStats.forEach((entry) => {
      map.set(String(entry.word || '').trim().toLowerCase(), Number(entry.count || 1));
    });
    return map;
  }

  const map = new Map();
  Object.values(round.words || {}).forEach((word) => {
    const key = String(word || '').trim().toLowerCase();
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

// Add a round to the history panel
function addRoundToHistory(round) {
  historyWrap.classList.remove('hidden');
  const div = document.createElement('div');
  div.className = 'history-round';
  const wordCounts = toWordCountMap(round);

  const wordsHtml = Object.entries(round.words).map(([name, word]) => {
    const color = playerColors[name] || '#666';
    const key = String(word || '').trim().toLowerCase();
    const count = wordCounts.get(key) || 1;
    return `
      <div class="history-word-item">
        <span class="history-dot" style="background:${color}"></span>
        <span class="history-word-text">${escapeHtml(word)}</span>
        ${count > 1 ? `<span class="history-duplicate-tag">shared by ${count}</span>` : ''}
        <span class="history-player-name">${escapeHtml(name)}</span>
      </div>
    `;
  }).join('');

  div.innerHTML = `
    <div class="history-round-label">Round ${round.roundNumber}</div>
    <div class="history-words">${wordsHtml}</div>
  `;
  historyList.prepend(div);
}

function addInvalidRoundToHistory({ round, missingPlayers, submittedPlayers }) {
  historyWrap.classList.remove('hidden');
  const div = document.createElement('div');
  div.className = 'history-round history-round-invalidated';

  const missing = Array.isArray(missingPlayers) && missingPlayers.length > 0
    ? missingPlayers.join(', ')
    : 'none';
  const submitted = Array.isArray(submittedPlayers) && submittedPlayers.length > 0
    ? submittedPlayers.join(', ')
    : 'none';

  div.innerHTML = `
    <div class="history-round-label history-round-label-inline">
      <span class="history-invalid-icon" aria-hidden="true">!</span>
      <span>Round ${round} Invalidated</span>
      <span class="history-invalid-pill">Timeout</span>
    </div>
    <div class="history-invalidated-text">Time expired at 01:00 limit.</div>
    <div class="history-invalidated-meta">Missing: ${escapeHtml(missing)}</div>
    <div class="history-invalidated-meta">Submitted (discarded): ${escapeHtml(submitted)}</div>
  `;

  historyList.prepend(div);
}

function formatRoundTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const m = String(Math.floor(safe / 60)).padStart(2, '0');
  const s = String(safe % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function updateRoundTimer(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  roundTimer.textContent = formatRoundTime(safe);
  roundTimer.classList.remove('round-timer-warning', 'round-timer-danger');

  if (safe <= 10) {
    roundTimer.classList.add('round-timer-danger');
  } else if (safe <= 20) {
    roundTimer.classList.add('round-timer-warning');
  }
}

function showTopWarningCard(text, durationMs = 2000) {
  if (topWarningTimeout) {
    clearTimeout(topWarningTimeout);
    topWarningTimeout = null;
  }

  topWarningCard.textContent = text;
  topWarningCard.classList.remove('hidden');

  topWarningTimeout = setTimeout(() => {
    topWarningCard.classList.add('hidden');
  }, durationMs);
}

function syncMySubmissionState(players) {
  const me = players.find((p) => p.name === myName);
  if (!me) return;

  if (me.submitted && !hasSubmitted) {
    hasSubmitted = true;
    wordInput.disabled = true;
    submitWordBtn.disabled = true;
    editWordBtn.disabled = false;
    editWordBtn.classList.remove('hidden');
    submittedConfirm.textContent = '✓ submitted — waiting for others…';
  }

  if (!me.submitted && hasSubmitted) {
    setEditableState(lastSubmittedWord);
  }
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
    const wordCounts = toWordCountMap(round);
    const wordsHtml = Object.entries(round.words).map(([name, word]) => {
      const color = playerColors[name] || '#666';
      const key = String(word || '').trim().toLowerCase();
      const count = wordCounts.get(key) || 1;
      return `
        <div class="history-word-item">
          <span class="history-dot" style="background:${color}"></span>
          <span class="history-word-text">${escapeHtml(word)}</span>
          ${count > 1 ? `<span class="history-duplicate-tag">shared by ${count}</span>` : ''}
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
    updateRoundTimer(state.roundTimeRemaining || 60);
    syncMySubmissionState(state.players);
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
    syncMySubmissionState(players);
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
  updateRoundTimer(60);
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

socket.on('round_timer_update', ({ secondsRemaining }) => {
  updateRoundTimer(secondsRemaining);
});

socket.on('round_invalidated', ({ round, missingPlayers, submittedPlayers, players }) => {
  renderPlayersGrid(players);
  setWaitingForNextRoundState();
  addInvalidRoundToHistory({ round, missingPlayers, submittedPlayers });

  const missingList = Array.isArray(missingPlayers) && missingPlayers.length > 0
    ? ` Missing: ${missingPlayers.join(', ')}.`
    : '';
  wordError.textContent = `Round ${round} invalidated (1-minute timer expired). Moving to the next round automatically.${missingList}`;
});

socket.on('round_advanced_after_invalidation', ({ nextRound, revealedWords, players }) => {
  setRoundPrompt(nextRound, revealedWords);
  renderPlayersGrid(players);
  resetWordInput();
  wordError.textContent = '';
});

socket.on('round_warning', ({ phrase, durationMs }) => {
  showTopWarningCard(phrase || 'haloy sana!!', durationMs || 2000);
});

socket.on('submission_edit_enabled', () => {
  setEditableState(lastSubmittedWord);
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
  lastSubmittedWord = '';
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
  updateRoundTimer(60);
  topWarningCard.classList.add('hidden');
  clearWordSuggestions();
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
  if (!myName) {
    wordError.textContent = 'Join with your name first to submit a word.';
    return;
  }
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
  setSubmittedState(word);
}

submitWordBtn.addEventListener('click', handleWordSubmit);
editWordBtn.addEventListener('click', () => {
  if (!hasSubmitted) return;
  socket.emit('edit_submission');
});
wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleWordSubmit();
});
wordInput.addEventListener('input', () => {
  wordError.textContent = '';
  scheduleWordSuggestions();
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
