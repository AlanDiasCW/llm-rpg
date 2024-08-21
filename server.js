require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;
const anthropic = new Anthropic({
apiKey: process.env.ANTHROPIC_API_KEY,
});
app.use(express.static(path.join(__dirname, 'public')));
let gameState = {
storySoFar: '',
lastDecision: '',
currentSituation: '',
options: [],
votes: {},
players: new Set(),
timer: null,
};

async function generateInitialStory() {
    const response = await anthropic.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: 'Generate a short initial scenario for a text-based RPG game. Include exactly three options for the player to choose from. Format your response as follows:\nScenario: [Your scenario here]\nOptions:\n1. [First option]\n2. [Second option]\n3. [Third option]'
        }
      ],
    });
  const result = response.content[0].text.trim().split('\n');
  const scenarioIndex = result.findIndex(line => line.startsWith('Scenario:'));
  const optionsIndex = result.findIndex(line => line.startsWith('Options:'));
  if (scenarioIndex !== -1 && optionsIndex !== -1) {
  gameState.currentSituation = result[scenarioIndex].replace('Scenario:', '').trim();
  gameState.options = result.slice(optionsIndex + 1).map(option => option.replace(/^\d+.\s*/, '').trim()).filter(option => option !== '');
  } else {
  console.error('Unexpected response format from Claude');
  gameState.currentSituation = 'Error generating scenario';
  gameState.options = [];
  }
  // Ensure we always have exactly 3 non-empty options
  while (gameState.options.length < 3) {
  gameState.options.push(`Fallback option ${gameState.options.length + 1}`);
  }
  gameState.options = gameState.options.slice(0, 3);
  console.log('Initial story generated:');
  console.log('Current situation:', gameState.currentSituation);
  console.log('Options:', gameState.options);
  }


  async function generateNextStep(chosenOption) {
    const prompt = `
    Story so far: ${gameState.storySoFar}
    Last decision: ${gameState.lastDecision}
    Current situation: ${gameState.currentSituation}
    Player chose: ${chosenOption}
    Continue the story based on this choice and provide exactly three new options for the player.
    Ensure the new part of the story is no more than two sentences long.
    If the chosen option would result in the player's death, end the story and indicate that the game is over.
    Format your response as follows:
    New situation: [Your new situation here]
    Options:
    
    [First option]
    [Second option]
    [Third option]
    
    If it's a game over scenario, just respond with:
    Game over: [Your game over message here]
    `;
    const response = await anthropic.messages.create({
    model: 'claude-3-sonnet-20240229',
    max_tokens: 300,
    messages: [
    {
    role: 'user',
    content: prompt
    }
    ],
    });
    const result = response.content[0].text.trim().split('\n');
    const situationIndex = result.findIndex(line => line.startsWith('New situation:'));
    const optionsIndex = result.findIndex(line => line.startsWith('Options:'));
    if (result[0].toLowerCase().startsWith('game over:')) {
    gameState.storySoFar += `\n${gameState.currentSituation}`;
    gameState.lastDecision = chosenOption;
    gameState.currentSituation = result[0];
    gameState.options = ['Game Over'];
    return false;
    } else if (situationIndex !== -1 && optionsIndex !== -1) {
    gameState.storySoFar += `\n${gameState.currentSituation}`;
    gameState.lastDecision = chosenOption;
    gameState.currentSituation = result[situationIndex].replace('New situation:', '').trim();
    gameState.options = result.slice(optionsIndex + 1).map(option => option.replace(/^\d+.\s*/, '').trim()).filter(option => option !== '');
    } else {
    console.error('Unexpected response format from Claude');
    gameState.currentSituation = 'Error generating next step';
    gameState.options = [];
    }
    // Ensure we always have exactly 3 non-empty options
    while (gameState.options.length < 3) {
    gameState.options.push(`Fallback option ${gameState.options.length + 1}`);
    }
    gameState.options = gameState.options.slice(0, 3);
    console.log('Next step generated:');
    console.log('Current situation:', gameState.currentSituation);
    console.log('Options:', gameState.options);
    return true;
    }


async function startNewRound() {
gameState.votes = {};
gameState.timer = 45;
io.emit('updateGameState', gameState);
const timerInterval = setInterval(() => {
gameState.timer--;
io.emit('updateTimer', gameState.timer);
if (gameState.timer <= 0) {
  clearInterval(timerInterval);
  processVotes();
}
}, 1000);
}
async function processVotes() {
console.log('Processing votes:');
console.log('Current votes:', gameState.votes);
const voteCounts = Object.values(gameState.votes).reduce((acc, vote) => {
acc[vote] = (acc[vote] || 0) + 1;
return acc;
}, {});
console.log('Vote counts:', voteCounts);
const winningOption = Object.keys(voteCounts).reduce((a, b) =>
voteCounts[a] > voteCounts[b] ? a : b, '0'
);
console.log('Winning option:', winningOption);
const chosenOption = gameState.options[winningOption];
console.log('Chosen option:', chosenOption);
const gameContinues = await generateNextStep(chosenOption);
if (gameState.options.includes('Game Over') || !gameState.options.length) {
io.emit('gameOver');
} else if (gameState.players.size > 0) {
startNewRound();
}
}
io.on('connection', (socket) => {
console.log('A user connected. Socket ID:', socket.id);
gameState.players.add(socket.id);
console.log('Current players:', Array.from(gameState.players));
socket.on('disconnect', () => {
console.log('A user disconnected. Socket ID:', socket.id);
gameState.players.delete(socket.id);
console.log('Current players:', Array.from(gameState.players));
});
socket.on('vote', (option) => {
console.log(`Vote received from ${socket.id}: Option ${option}`);
gameState.votes[socket.id] = option;
console.log('Current votes:', gameState.votes);
});
socket.emit('updateGameState', gameState);
});
async function initGame() {
await generateInitialStory();
startNewRound();
}
server.listen(PORT, () => {
console.log(`Server is running on http://localhost:${PORT}`);
initGame();
});