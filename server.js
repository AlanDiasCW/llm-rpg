require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const fs = require('fs');

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
  },
  goldenCapybaraEncountered: false
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
  try {
    const prompt = `
    Story so far: ${gameState.storySoFar}
    Last decision: ${gameState.lastDecision}
    Current situation: ${gameState.currentSituation}
    Player HP: ${gameState.player.hp}/${gameState.player.maxHp}

    Player chose: ${option}

    Continue the story based on this choice. 
    Occasionally include events that affect the player's HP.
    Provide exactly three new options for the player to choose from.
    Ensure the new part of the story is no more than two sentences long.
    If the player's HP reaches 0, end the story and indicate that the game is over.

    ${!gameState.goldenCapybaraEncountered ? "There's a small chance (about 5%) that the player encounters a mysterious golden capybara. If this happens, make sure one of the options is to pet it." : ""}

    ${gameState.goldenCapybaraEncountered && option.toLowerCase().includes('pet') && option.toLowerCase().includes('golden capybara') ? 
      "The player has chosen to pet the golden capybara. This is a special win condition. End the game with a message about the player escaping the simulation." : 
      ""}

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

    const content = response.content[0].text.trim().split('\n');
    let newSituation, newOptions, newPlayerHp;

    if (content[0].toLowerCase().startsWith('game over:')) {
      newSituation = content[0];
      newOptions = ['Game Over'];
      newPlayerHp = 0;
    } else {
      const situationIndex = content.findIndex(line => line.startsWith('New situation:'));
      const playerHpIndex = content.findIndex(line => line.startsWith('Player HP:'));
      const optionsIndex = content.findIndex(line => line.startsWith('Options:'));

      newSituation = content[situationIndex].replace('New situation:', '').trim();
      newPlayerHp = parseInt(content[playerHpIndex].split(':')[1].trim());
      newOptions = content.slice(optionsIndex + 1).map(option => option.replace(/^\d+\.\s*/, '').trim()).filter(option => option !== '');
    }

    while (newOptions.length < 3 && !newOptions.includes('Game Over')) {
      newOptions.push(`Fallback option ${newOptions.length + 1}`);
    }
    newOptions = newOptions.slice(0, 3);

    const imagePrompt = `point of view perspective, create a simple image: ${newSituation}`;
    const imageUrl = await generateImage(imagePrompt);

    // After processing the AI response, check if the golden capybara was introduced
    if (newSituation.toLowerCase().includes('golden capybara')) {
      gameState.goldenCapybaraEncountered = true;
      console.log('Golden capybara encountered!');
    }

    return { newSituation, newOptions, imageUrl, newPlayerHp };
  } catch (error) {
    console.error("Error in generateOutcome:", error);
    return {
      newSituation: "An unexpected error occurred. Please try again.",
      newOptions: ["Restart the game"],
      newPlayerHp: gameState.player.hp,
      imageUrl: gameState.currentImage
    };
  }
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
        content: 'Generate a short initial scenario for a text-based RPG game. Try to add sci-fi elements to the scenario, aliens, robots, AI. Include exactly three options for the player to choose from. Format your response as follows:\nScenario: [Your scenario here]\nOptions:\n1. [First option]\n2. [Second option]\n3. [Third option]'
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
  // Check for the golden capybara win condition before generating the next outcome
  if (gameState.goldenCapybaraEncountered && gameState.options[chosenOption].toLowerCase().includes('pet') && gameState.options[chosenOption].toLowerCase().includes('golden capybara')) {
    console.log('Win condition met! Player pet the golden capybara.');
    gameState.currentSituation = "As you pet the golden capybara, the world around you begins to dissolve. You realize you've been in a simulation all along, and you've just found the way out. Congratulations, you've won the game!";
    gameState.options = ['Game Over - You Win!'];
    io.emit('updateGameState', gameState);
    io.emit('gameOver', 'win');
    return false;
  }

  const outcome = gameState.nextOutcomes[chosenOption];
  
  // Update game state
  gameState.storySoFar += `\n${gameState.currentSituation}`;
  gameState.lastDecision = gameState.options[chosenOption];
  gameState.currentSituation = outcome.newSituation;
  gameState.options = outcome.newOptions;
  gameState.currentImage = outcome.imageUrl;
  gameState.player.hp = outcome.newPlayerHp;

  console.log('Moved to next step:');
  console.log('Current situation:', gameState.currentSituation);
  console.log('Last decision:', gameState.lastDecision);
  console.log('Options:', gameState.options);
  console.log('Golden capybara encountered:', gameState.goldenCapybaraEncountered);

  // Check if the LLM has triggered the win condition
  if (gameState.currentSituation.toLowerCase().includes('congratulations') && gameState.currentSituation.toLowerCase().includes('won the game')) {
    io.emit('updateGameState', gameState);
    io.emit('gameOver', 'win');
    return false;
  }

  if (gameState.options.includes('Game Over') || gameState.player.hp <= 0) {
    io.emit('gameOver', 'lose');
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
    io.emit('gameOver', gameState.options.includes('Game Over - You Win!') ? 'win' : 'lose');
  } else if (gameState.players.size > 0) {
    startNewRound();
  }
}

function getMusicFileName() {
  const musicFiles = ['infiniteverse.mp3', 'infiniteverse_2.mp3'];
  const randomIndex = Math.floor(Math.random() * musicFiles.length);
  const selectedFile = musicFiles[randomIndex];
  
  const musicFilePath = path.join(__dirname, 'public', selectedFile);
  
  if (fs.existsSync(musicFilePath)) {
    console.log('Selected music file:', selectedFile);
    return selectedFile;
  } else {
    console.error('Selected music file not found:', musicFilePath);
    return null;
  }
}

async function initGame() {
  // Reset game state
  gameState = {
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
    },
    goldenCapybaraEncountered: false
  };

  const musicFileName = getMusicFileName();

  try {
    await generateInitialStory();
    io.emit('gameReady', { ...gameState, musicFileName });  // Include musicFileName in the gameReady event
  } catch (error) {
    console.error("Error initializing game:", error);
    gameState.currentSituation = "An error occurred while starting the game. Please try again.";
    gameState.options = ["Restart Game"];
    io.emit('gameReady', { ...gameState, musicFileName });
  }
}

let musicFileName;

io.on('connection', (socket) => {
  console.log('A user connected. Socket ID:', socket.id);
  const selectedMusicFile = getMusicFileName();
  if (selectedMusicFile) {
    console.log('Sending music file name:', selectedMusicFile);
    socket.emit('musicFile', selectedMusicFile);
  } else {
    console.error('No music file available to send');
  }
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

  socket.on('restartGame', () => {
    console.log('Restarting game...');
    initGame();
  });

  socket.on('startGame', () => {
    console.log('Starting game for player:', socket.id);
    startNewRound();
  });

  socket.emit('updateGameState', gameState);
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  const musicFileName = getMusicFileName();
  if (musicFileName) {
    console.log('Music file selected for initial load:', musicFileName);
  } else {
    console.warn('No music file available for initial load');
  }
  initGame();
});