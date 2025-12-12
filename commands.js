import "dotenv/config";
import { getRPSChoices } from "./game.js";
import { capitalize, InstallGlobalCommands } from "./utils.js";

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

const HOTDOG_COMMAND = {
  name: "hotdog",
  description: "Add hot dogs",
  options: [
    {
      type: 4, // integer
      name: "amount",
      description: "Number of hot dogs to add",
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1],
};

const ALL_COMMANDS = [HOTDOG_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
