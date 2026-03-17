/**
 * WordSync - Multiplayer Word Convergence Game
 * Server: Express + Socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ───────────────────────────────────────────────────────────────

const gameState = {
  phase: 'lobby',       // 'lobby' | 'submitting' | 'reveal' | 'finished'
  players: {},          // { socketId: { name, color, submitted, word } }
  rounds: [],           // Array of round objects { words: {name: word}, allSame: bool }
  currentRound: 0,
  revealedWords: [],    // Words shown as prompts for next round
  chatMessages: [],     // Chat history shown to newly connected players
  usedWords: new Set(), // Lower-cased words used in finalized rounds
};

// Palette of distinct player colors
const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF',
  '#FF8B94', '#A3D977', '#74B9FF', '#FD79A8',
  '#FDCB6E', '#6C5CE7', '#00CEC9', '#E17055',
];

let colorIndex = 0;
const MAX_CHAT_MESSAGES = 120;
const ROUND_DURATION_MS = 60 * 1000;
const ROUND_WARNING_30_SECONDS = 30;
const ROUND_WARNING_10_SECONDS = 10;
const REVEAL_PAUSE_MS = 2200;
const INVALIDATION_ADVANCE_PAUSE_MS = 2200;
const WARNING_POPUP_DURATION_MS = 5000;

let roundDeadlineTs = null;
let roundTimerInterval = null;
let roundTimeout = null;
let revealTimerStartTimeout = null;
let invalidationAdvanceTimeout = null;
let warning30SentForRound = null;
let warning10SentForRound = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPlayerList() {
  return Object.values(gameState.players).map(p => ({
    name: p.name,
    color: p.color,
    submitted: p.submitted,
  }));
}

function resetRoundSubmissions() {
  Object.keys(gameState.players).forEach(id => {
    gameState.players[id].submitted = false;
    gameState.players[id].word = null;
  });
}

function checkAllSubmitted() {
  const players = Object.values(gameState.players);
  return players.length > 0 && players.every(p => p.submitted);
}

function checkWinCondition(words) {
  // All words match (case-insensitive, trimmed)
  const normalized = words.map(w => w.trim().toLowerCase());
  return normalized.every(w => w === normalized[0]);
}

function normalizeWord(word) {
  return String(word || '').trim().toLowerCase();
}

function buildWordStats(words) {
  const groups = new Map();

  words.forEach((word) => {
    const key = word.trim().toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { word, count: 0 });
    }
    groups.get(key).count += 1;
  });

  return Array.from(groups.values());
}

function getRoundTimeRemainingSeconds() {
  if (!roundDeadlineTs) return Math.ceil(ROUND_DURATION_MS / 1000);
  return Math.max(0, Math.ceil((roundDeadlineTs - Date.now()) / 1000));
}

function clearRoundTimers() {
  if (roundTimerInterval) {
    clearInterval(roundTimerInterval);
    roundTimerInterval = null;
  }

  if (roundTimeout) {
    clearTimeout(roundTimeout);
    roundTimeout = null;
  }

  if (revealTimerStartTimeout) {
    clearTimeout(revealTimerStartTimeout);
    revealTimerStartTimeout = null;
  }

  if (invalidationAdvanceTimeout) {
    clearTimeout(invalidationAdvanceTimeout);
    invalidationAdvanceTimeout = null;
  }

  roundDeadlineTs = null;
  warning30SentForRound = null;
  warning10SentForRound = null;
}

function startRoundTimer() {
  clearRoundTimers();

  if (gameState.phase !== 'submitting') return;

  roundDeadlineTs = Date.now() + ROUND_DURATION_MS;
  warning30SentForRound = null;
  warning10SentForRound = null;

  io.emit('round_timer_update', {
    round: gameState.currentRound,
    secondsRemaining: getRoundTimeRemainingSeconds(),
  });

  roundTimerInterval = setInterval(() => {
    if (gameState.phase !== 'submitting') return;

    const secondsRemaining = getRoundTimeRemainingSeconds();
    io.emit('round_timer_update', {
      round: gameState.currentRound,
      secondsRemaining,
    });

    if (
      secondsRemaining <= ROUND_WARNING_30_SECONDS &&
      warning30SentForRound !== gameState.currentRound
    ) {
      const hasUnsubmitted = Object.values(gameState.players).some((player) => !player.submitted);
      if (hasUnsubmitted) {
        warning30SentForRound = gameState.currentRound;
        io.emit('round_warning', {
          round: gameState.currentRound,
          phrase: 'haloy sana!!',
          durationMs: WARNING_POPUP_DURATION_MS,
        });
      }
    }

    if (
      secondsRemaining <= ROUND_WARNING_10_SECONDS &&
      warning10SentForRound !== gameState.currentRound
    ) {
      const missingPlayers = Object.values(gameState.players)
        .filter((player) => !player.submitted)
        .map((player) => player.name);
      if (missingPlayers.length > 0) {
        warning10SentForRound = gameState.currentRound;
        io.emit('round_warning', {
          round: gameState.currentRound,
          phrase: `tultol ngani ${missingPlayers.join(', ')}!!`,
          durationMs: WARNING_POPUP_DURATION_MS,
        });
      }
    }
  }, 1000);

  roundTimeout = setTimeout(() => {
    invalidateCurrentRoundDueToTimeout();
  }, ROUND_DURATION_MS);
}

function invalidateCurrentRoundDueToTimeout() {
  if (gameState.phase !== 'submitting') return;

  clearRoundTimers();

  const players = Object.values(gameState.players);
  const submittedPlayers = players.filter((p) => p.submitted).map((p) => p.name);
  const missingPlayers = players.filter((p) => !p.submitted).map((p) => p.name);
  const invalidatedRound = gameState.currentRound;

  resetRoundSubmissions();

  io.emit('round_invalidated', {
    round: invalidatedRound,
    reason: 'timeout',
    submittedPlayers,
    missingPlayers,
    players: getPlayerList(),
  });

  broadcastSystemMessage(`Round ${invalidatedRound} invalidated (time limit reached). Advancing automatically.`);

  invalidationAdvanceTimeout = setTimeout(() => {
    if (gameState.phase !== 'submitting' || gameState.currentRound !== invalidatedRound) {
      return;
    }

    gameState.currentRound += 1;
    resetRoundSubmissions();

    io.emit('round_advanced_after_invalidation', {
      invalidatedRound,
      nextRound: gameState.currentRound,
      revealedWords: gameState.revealedWords,
      players: getPlayerList(),
    });

    broadcastSystemMessage(`Round ${gameState.currentRound} started after timeout invalidation.`);
    startRoundTimer();
  }, INVALIDATION_ADVANCE_PAUSE_MS);
}

function buildChatMessage(name, text, system = false) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    text,
    system,
    timestamp: new Date().toISOString(),
  };
}

function appendChatMessage(message) {
  gameState.chatMessages.push(message);
  if (gameState.chatMessages.length > MAX_CHAT_MESSAGES) {
    gameState.chatMessages.shift();
  }
}

function broadcastSystemMessage(text) {
  const message = buildChatMessage('System', text, true);
  appendChatMessage(message);
  io.emit('chat_message', message);
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // Send current game state to newly connected client
  socket.emit('state_sync', {
    phase: gameState.phase,
    players: getPlayerList(),
    rounds: gameState.rounds,
    currentRound: gameState.currentRound,
    revealedWords: gameState.revealedWords,
    chatMessages: gameState.chatMessages,
    roundTimeRemaining: getRoundTimeRemainingSeconds(),
  });

  // ── Player joins lobby ──────────────────────────────────────────────────────
  socket.on('join_lobby', ({ name }) => {
    // Validate name
    const trimmedName = (name || '').trim();
    if (!trimmedName) return socket.emit('join_error', 'Name cannot be empty.');
    const nameTaken = Object.values(gameState.players).some(
      p => p.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (nameTaken) return socket.emit('join_error', 'That name is already taken!');
    if (gameState.phase === 'finished') {
      return socket.emit('join_error', 'Match already finished. Please wait for reset.');
    }

    // Register player
    gameState.players[socket.id] = {
      name: trimmedName,
      color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
      submitted: false,
      word: null,
    };
    colorIndex++;

    console.log(`  Player joined: ${trimmedName}`);
    socket.emit('join_success', { name: trimmedName, color: gameState.players[socket.id].color });
    io.emit('players_update', getPlayerList());
    if (gameState.phase === 'lobby') {
      broadcastSystemMessage(`${trimmedName} joined the lobby.`);
    } else {
      broadcastSystemMessage(`${trimmedName} joined the ongoing match.`);
    }

    if (gameState.phase === 'submitting') {
      socket.emit('round_timer_update', {
        round: gameState.currentRound,
        secondsRemaining: getRoundTimeRemainingSeconds(),
      });
    }
  });

  // ── Chat message ───────────────────────────────────────────────────────────
  socket.on('send_chat', ({ text }) => {
    const trimmedText = (text || '').trim();
    if (!trimmedText) return;
    if (trimmedText.length > 180) {
      return socket.emit('chat_error', 'Message is too long (max 180 characters).');
    }

    const sender = gameState.players[socket.id]?.name || 'Guest';
    const message = buildChatMessage(sender, trimmedText, false);
    appendChatMessage(message);
    io.emit('chat_message', message);
  });

  // ── Host starts game ────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const playerCount = Object.keys(gameState.players).length;
    if (playerCount < 2) {
      return socket.emit('start_error', 'Need at least 2 players to start.');
    }
    if (gameState.phase !== 'lobby') return;

    gameState.phase = 'submitting';
    gameState.currentRound = 1;
    gameState.rounds = [];
    gameState.revealedWords = [];
    gameState.usedWords = new Set();
    resetRoundSubmissions();
    startRoundTimer();

    console.log(`[GAME] Started with ${playerCount} players`);
    io.emit('game_started', {
      players: getPlayerList(),
      round: gameState.currentRound,
      revealedWords: [],
    });
    broadcastSystemMessage('Game started. Good luck!');
  });

  // ── Player submits a word ───────────────────────────────────────────────────
  socket.on('submit_word', ({ word }) => {
    const player = gameState.players[socket.id];
    if (!player || gameState.phase !== 'submitting') return;
    if (player.submitted) return; // Already submitted this round

    const trimmedWord = (word || '').trim();
    if (!trimmedWord || trimmedWord.includes(' ')) {
      return socket.emit('word_error', 'Please submit a single word (no spaces).');
    }

    const normalizedWord = normalizeWord(trimmedWord);
    if (gameState.usedWords.has(normalizedWord)) {
      return socket.emit('word_error', 'Already used. Please try another word.');
    }

    player.submitted = true;
    player.word = trimmedWord;

    console.log(`  ${player.name} submitted: "${trimmedWord}" (Round ${gameState.currentRound})`);

    // Broadcast updated submission status (hide actual words until all done)
    io.emit('players_update', getPlayerList());

    // Check if all players have submitted
    if (checkAllSubmitted()) {
      processRoundEnd();
    }
  });

  // ── Player re-opens submission (edit / undo) ─────────────────────────────
  socket.on('edit_submission', () => {
    const player = gameState.players[socket.id];
    if (!player || gameState.phase !== 'submitting') return;
    if (!player.submitted) return;

    player.submitted = false;
    player.word = null;

    io.emit('players_update', getPlayerList());
    socket.emit('submission_edit_enabled');
  });

  // ── Player disconnects ──────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      console.log(`[-] ${player.name} disconnected`);
      const playerName = player.name;
      delete gameState.players[socket.id];

      const remainingPlayers = Object.keys(gameState.players).length;
      if (remainingPlayers === 0) {
        clearRoundTimers();
        gameState.phase = 'lobby';
        gameState.rounds = [];
        gameState.currentRound = 0;
        gameState.revealedWords = [];
        gameState.usedWords = new Set();
        gameState.chatMessages = [];
        colorIndex = 0;

        console.log('[GAME] No players remaining, reset to lobby');
        io.emit('game_reset');
        return;
      }

      io.emit('players_update', getPlayerList());
      broadcastSystemMessage(`${playerName} disconnected.`);

      // If game is running and everyone remaining has submitted, process round
      if (gameState.phase === 'submitting' && checkAllSubmitted()) {
        processRoundEnd();
      }
    }
  });

  // ── Reset game ──────────────────────────────────────────────────────────────
  socket.on('reset_game', () => {
    clearRoundTimers();

    Object.keys(gameState.players).forEach(id => {
      gameState.players[id].submitted = false;
      gameState.players[id].word = null;
    });
    gameState.phase = 'lobby';
    gameState.rounds = [];
    gameState.currentRound = 0;
    gameState.revealedWords = [];
    gameState.usedWords = new Set();
    colorIndex = 0;

    // Clear all players so everyone re-joins fresh
    gameState.players = {};
    gameState.chatMessages = [];

    console.log('[GAME] Reset to lobby');
    io.emit('game_reset');
    broadcastSystemMessage('Game reset. Join to start a new match.');
  });
});

// ─── Round Processing ─────────────────────────────────────────────────────────

function processRoundEnd() {
  clearRoundTimers();

  const players = Object.values(gameState.players);
  const wordMap = {}; // { playerName: word }
  const wordList = [];

  players.forEach(p => {
    wordMap[p.name] = p.word;
    wordList.push(p.word);
  });

  wordList.forEach((word) => {
    gameState.usedWords.add(normalizeWord(word));
  });

  const roundData = {
    roundNumber: gameState.currentRound,
    words: wordMap,
    wordStats: buildWordStats(wordList),
    allSame: checkWinCondition(wordList),
  };

  gameState.rounds.push(roundData);

  if (roundData.allSame) {
    // ── WIN! ──────────────────────────────────────────────────────────────────
    gameState.phase = 'finished';
    console.log(`[GAME] WIN on round ${gameState.currentRound}!`);
    io.emit('game_finished', {
      rounds: gameState.rounds,
      totalRounds: gameState.currentRound,
      winningWord: wordList[0],
    });
  } else {
    // ── Next Round ────────────────────────────────────────────────────────────
    gameState.revealedWords = roundData.wordStats;
    gameState.currentRound++;
    resetRoundSubmissions();
    gameState.phase = 'submitting';

    console.log(
      `[GAME] Round ${gameState.currentRound} — revealed: ${gameState.revealedWords
        .map((entry) => `${entry.word}${entry.count > 1 ? ` x${entry.count}` : ''}`)
        .join(', ')}`
    );
    io.emit('round_reveal', {
      round: roundData,
      nextRound: gameState.currentRound,
      revealedWords: gameState.revealedWords,
      players: getPlayerList(),
    });

    revealTimerStartTimeout = setTimeout(() => {
      startRoundTimer();
    }, REVEAL_PAUSE_MS);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢 WordSync server running at http://localhost:${PORT}\n`);
});
