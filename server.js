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
content: 'Generate a short initial scenario for a text-based RPG game. Include three options for the player to choose from.'
}
],
});
const result = response.content[0].text.trim().split('\n');
gameState.currentSituation = result[0];
gameState.options = result.slice(1).map(option => option.replace(/^\d+.\s*/, ''));
}
async function generateNextStep(chosenOption) {
const prompt = `
Story so far: ${gameState.storySoFar}
Last decision: ${gameState.lastDecision}
Current situation: ${gameState.currentSituation}
Player chose: ${chosenOption}
Continue the story based on this choice and provide three new options for the player.
Ensure the new part of the story is no more than two sentences long.
If the chosen option would result in the player's death, end the story and indicate that the game is over.
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
const newSituation = result[0];
if (newSituation.toLowerCase().includes('game over')) {
gameState.storySoFar += `\n${gameState.currentSituation}`;
gameState.lastDecision = chosenOption;
gameState.currentSituation = newSituation;
gameState.options = ['Game Over'];
return false;
} else {
gameState.storySoFar += `\n${gameState.currentSituation}`;
gameState.lastDecision = chosenOption;
gameState.currentSituation = newSituation;
gameState.options = result.slice(1).map(option => option.replace(/^\d+.\s*/, ''));
return true;
}
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
const voteCounts = Object.values(gameState.votes).reduce((acc, vote) => {
acc[vote] = (acc[vote] || 0) + 1;
return acc;
}, {});
const winningOption = Object.keys(voteCounts).reduce((a, b) =>
voteCounts[a] > voteCounts[b] ? a : b, '0'
);
const chosenOption = gameState.options[winningOption];
const gameContinues = await generateNextStep(chosenOption);
if (gameState.options.includes('Game Over') || !gameState.options.length) {
io.emit('gameOver');
} else if (gameState.players.size > 0) {
startNewRound();
}
}
io.on('connection', (socket) => {
console.log('A user connected');
gameState.players.add(socket.id);
socket.on('disconnect', () => {
console.log('A user disconnected');
gameState.players.delete(socket.id);
});
socket.on('vote', (option) => {
gameState.votes[socket.id] = option;
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