const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const axios = require('axios');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));
let gameState = {
story: '',
options: [],
votes: {},
players: new Set(),
timer: null,
};
function startNewRound() {
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
function processVotes() {
const voteCounts = Object.values(gameState.votes).reduce((acc, vote) => {
acc[vote] = (acc[vote] || 0) + 1;
return acc;
}, {});
const winningOption = Object.keys(voteCounts).reduce((a, b) =>
voteCounts[a] > voteCounts[b] ? a : b
);
// Here you would call Claude API to get the next part of the story
// For now, we'll just use a placeholder
gameState.story += `\n\nOption ${winningOption} was chosen.`;
gameState.options = ['Continue the adventure', 'Rest for a while', 'Explore the surroundings'];
startNewRound();
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
// Start the initial round
gameState.story = "You find yourself at the entrance of a dark cave. What do you do?";
gameState.options = ['Enter the cave', 'Look for another way', 'Set up camp outside'];
startNewRound();
server.listen(PORT, () => {
console.log(`Server is running on http://localhost:${PORT}`);
});