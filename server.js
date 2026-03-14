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
};

// Palette of distinct player colors
const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF',
  '#FF8B94', '#A3D977', '#74B9FF', '#FD79A8',
  '#FDCB6E', '#6C5CE7', '#00CEC9', '#E17055',
];

let colorIndex = 0;
const MAX_CHAT_MESSAGES = 120;

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
    if (gameState.phase !== 'lobby') return socket.emit('join_error', 'Game already in progress.');

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
    broadcastSystemMessage(`${trimmedName} joined the lobby.`);
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
    resetRoundSubmissions();

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

  // ── Player disconnects ──────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      console.log(`[-] ${player.name} disconnected`);
      const playerName = player.name;
      delete gameState.players[socket.id];
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
    Object.keys(gameState.players).forEach(id => {
      gameState.players[id].submitted = false;
      gameState.players[id].word = null;
    });
    gameState.phase = 'lobby';
    gameState.rounds = [];
    gameState.currentRound = 0;
    gameState.revealedWords = [];
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
  const players = Object.values(gameState.players);
  const wordMap = {}; // { playerName: word }
  const wordList = [];

  players.forEach(p => {
    wordMap[p.name] = p.word;
    wordList.push(p.word);
  });

  const roundData = {
    roundNumber: gameState.currentRound,
    words: wordMap,
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
    // Collect unique revealed words for the next prompt
    const uniqueWords = [...new Set(wordList.map(w => w.toLowerCase()))].map(
      w => wordList.find(x => x.toLowerCase() === w) // preserve original casing
    );
    gameState.revealedWords = uniqueWords;
    gameState.currentRound++;
    resetRoundSubmissions();
    gameState.phase = 'submitting';

    console.log(`[GAME] Round ${gameState.currentRound} — revealed: ${uniqueWords.join(', ')}`);
    io.emit('round_reveal', {
      round: roundData,
      nextRound: gameState.currentRound,
      revealedWords: uniqueWords,
      players: getPlayerList(),
    });
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢 WordSync server running at http://localhost:${PORT}\n`);
});
