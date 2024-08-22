require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
  storySoFar: '',
  lastDecision: '',
  currentSituation: '',
  options: [],
  nextOutcomes: {},
  votes: {},
  players: new Set(),
  timer: null,
  currentImage: '',
  player: {
    hp: 100,
    maxHp: 100
  }
};

async function generateImage(prompt) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
    });
    return response.data[0].url;
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
}

async function generateOutcome(option) {
  const prompt = `
Story so far: ${gameState.storySoFar}
Last decision: ${gameState.lastDecision}
Current situation: ${gameState.currentSituation}
Player HP: ${gameState.player.hp}/${gameState.player.maxHp}

Player chose: ${option}

Continue the story based on this choice. Occasionally include events that affect the player's HP.
Provide exactly three new options for the player to choose from.
Ensure the new part of the story is no more than two sentences long.
If the player's HP reaches 0, end the story and indicate that the game is over.

Format your response as follows:
New situation: [Your new situation here]
Player HP: [Updated player HP]
Options:
1. [First option]
2. [Second option]
3. [Third option]

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
  let newSituation, newOptions, newPlayerHp;

  if (result[0].toLowerCase().startsWith('game over:')) {
    newSituation = result[0];
    newOptions = ['Game Over'];
    newPlayerHp = 0;
  } else {
    const situationIndex = result.findIndex(line => line.startsWith('New situation:'));
    const playerHpIndex = result.findIndex(line => line.startsWith('Player HP:'));
    const optionsIndex = result.findIndex(line => line.startsWith('Options:'));

    newSituation = result[situationIndex].replace('New situation:', '').trim();
    newPlayerHp = parseInt(result[playerHpIndex].split(':')[1].trim());
    newOptions = result.slice(optionsIndex + 1).map(option => option.replace(/^\d+\.\s*/, '').trim()).filter(option => option !== '');
  }

  while (newOptions.length < 3 && !newOptions.includes('Game Over')) {
    newOptions.push(`Fallback option ${newOptions.length + 1}`);
  }
  newOptions = newOptions.slice(0, 3);

  const imagePrompt = `point of view perspective, create a simple image: ${newSituation}`;
  const imageUrl = await generateImage(imagePrompt);

  return { newSituation, newOptions, imageUrl, newPlayerHp };
}

async function preloadOutcomes() {
  const outcomePromises = gameState.options.map(async (option, index) => {
    const outcome = await generateOutcome(option);
    return { index, outcome };
  });

  const outcomes = await Promise.all(outcomePromises);
  const outcomeMap = {};
  outcomes.forEach(({ index, outcome }) => {
    outcomeMap[index] = outcome;
  });

  gameState.nextOutcomes = outcomeMap;
  console.log('Preloaded outcomes:', gameState.nextOutcomes);
}

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
    gameState.options = result.slice(optionsIndex + 1).map(option => option.replace(/^\d+\.\s*/, '').trim()).filter(option => option !== '');
  } else {
    console.error('Unexpected response format from Claude');
    gameState.currentSituation = 'Error generating scenario';
    gameState.options = [];
  }

  while (gameState.options.length < 3) {
    gameState.options.push(`Fallback option ${gameState.options.length + 1}`);
  }
  gameState.options = gameState.options.slice(0, 3);

  const imagePrompt = `Create a simple image for a text-based RPG game scenario: ${gameState.currentSituation}`;
  gameState.currentImage = await generateImage(imagePrompt);

  console.log('Initial story generated:');
  console.log('Current situation:', gameState.currentSituation);
  console.log('Options:', gameState.options);
  console.log('Current image:', gameState.currentImage);

  await preloadOutcomes();
}

function moveToNextStep(chosenOption) {
  const outcome = gameState.nextOutcomes[chosenOption];
  
  gameState.storySoFar += `\n${gameState.currentSituation}`;
  gameState.lastDecision = gameState.options[chosenOption];
  gameState.currentSituation = outcome.newSituation;
  gameState.options = outcome.newOptions;
  gameState.currentImage = outcome.imageUrl;
  gameState.player.hp = outcome.newPlayerHp;

  console.log('Moved to next step:');
  console.log('Current situation:', gameState.currentSituation);
  console.log('Options:', gameState.options);
  console.log('Current image:', gameState.currentImage);
  console.log('Player HP:', gameState.player.hp);

  if (gameState.options.includes('Game Over') || gameState.player.hp <= 0) {
    return false;
  }

  return true;
}

function startNewRound() {
  gameState.votes = {};
  gameState.timer = 25; 
  io.emit('updateGameState', gameState);
  
  const timerInterval = setInterval(() => {
    gameState.timer--;
    io.emit('updateTimer', gameState.timer);
    
    if (gameState.timer <= 0) {
      clearInterval(timerInterval);
      processVotes();
    }
  }, 1000);

  preloadOutcomes().catch(console.error);
}

function processVotes() {
  console.log('Processing votes:', gameState.votes);

  const voteCounts = Object.values(gameState.votes).reduce((acc, vote) => {
    acc[vote] = (acc[vote] || 0) + 1;
    return acc;
  }, {});
  
  console.log('Vote counts:', voteCounts);

  const winningOption = Object.keys(voteCounts).reduce((a, b) => 
    voteCounts[a] > voteCounts[b] ? a : b, '0'
  );
  
  console.log('Winning option:', winningOption);

  const gameContinues = moveToNextStep(winningOption);
  
  io.emit('updateGameState', gameState);
  
  if (!gameContinues) {
    io.emit('gameOver');
  } else if (gameState.players.size > 0) {
    startNewRound();
  }
}

io.on('connection', (socket) => {
  console.log('A user connected. Socket ID:', socket.id);
  gameState.players.add(socket.id);
  console.log('Current players:', Array.from(gameState.players));

  // Send current game state if the game has already started
  if (gameState.currentSituation) {
    socket.emit('gameReady', gameState);
  }

  socket.on('disconnect', () => {
    console.log('A user disconnected. Socket ID:', socket.id);
    gameState.players.delete(socket.id);
    delete gameState.votes[socket.id];
    console.log('Current players:', Array.from(gameState.players));
    io.emit('updateVotes', gameState.votes);
  });

  socket.on('vote', (option) => {
    console.log(`Vote received from ${socket.id}: Option ${option}`);
    gameState.votes[socket.id] = option;
    console.log('Current votes:', gameState.votes);
    io.emit('updateVotes', gameState.votes);
  });

  socket.emit('updateGameState', gameState);
});

async function initGame() {
  await generateInitialStory();
  io.emit('gameReady', gameState);  // Emit gameReady event with initial game state
  startNewRound();
}

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  initGame();
});