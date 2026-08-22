import chalk from "chalk";
import { subagentManager } from "./subagentManager.js";
import { TOOL_DEFS } from "./tools.js";
import { colors, renderBox } from "./theme.js";

/**
 * Interactive Agent Creator Wizard
 * Allows developers to create highly customized subagents with tailored instructions,
 * specialized tools, model overrides, max rounds, and role configurations.
 */
export async function launchAgentCreator(reader) {
  console.log("\n" + renderBox([
    colors.secondary.bold("✦  A G E N T   C R E A T O R   W I Z A R D  ✦"),
    colors.dim("Design and instantiate custom high-precision subagents."),
  ], { borderColor: colors.secondary }));

  const nameInput = await reader.question(colors.accent.bold("\n1. Agent Identifier (e.g. 'sql_optimizer', 'api_designer'): "));
  if (!nameInput || !nameInput.trim()) {
    console.log(colors.warning("Creation aborted. Name cannot be empty."));
    return null;
  }
  const name = nameInput.trim().toLowerCase().replace(/\s+/g, "_");

  const roleInput = await reader.question(colors.accent.bold("2. Agent Title/Role (e.g. 'SQL Database Performance Specialist'): "));
  const role = roleInput?.trim() || name;

  const descInput = await reader.question(colors.accent.bold("3. Short Description (e.g. 'Analyzes query plans and indexes'): "));
  const description = descInput?.trim() || "Specialized assistant";

  console.log(colors.accent.bold("\n4. System Prompt / Detailed Instructions:"));
  console.log(colors.dim("   (Paste or type instructions. You can use multi-line text. Finish with Enter)"));
  const promptInput = await reader.question(colors.primary("   » "));
  const systemPrompt = promptInput?.trim() || `You are ${role}, a high-precision specialized agent. Focus strictly on your designated scope.`;

  console.log(colors.accent.bold("\n5. Select Allowed Tools:"));
  const allToolNames = TOOL_DEFS.map((t) => t.function.name);
  allToolNames.forEach((tName, i) => {
    console.log(`   ${colors.accent(i + 1)}. ${tName}`);
  });
  console.log(`   ${colors.dim("0. ALL TOOLS (Full Access)")}`);

  const toolsChoice = await reader.question(colors.accent.bold("   Select numbers separated by commas (e.g. '1, 3, 5' or '0' for all): "));
  let allowedTools = "all";
  if (toolsChoice && toolsChoice.trim() !== "0" && toolsChoice.trim() !== "") {
    const indices = toolsChoice
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < allToolNames.length);
    if (indices.length > 0) {
      allowedTools = indices.map((i) => allToolNames[i]);
    }
  }

  const modelOverride = await reader.question(colors.accent.bold("\n6. Model Override (leave empty to inherit main session model): "));
  const model = modelOverride?.trim() || null;

  const roundsInput = await reader.question(colors.accent.bold("\n7. Max Tool Rounds Limit (default: 20): "));
  const maxRounds = parseInt(roundsInput?.trim(), 10) || 20;

  const newAgent = {
    name,
    role,
    description,
    systemPrompt,
    allowedTools,
    model,
    maxRounds,
  };

  subagentManager.registerAgent(newAgent);

  console.log("\n" + renderBox([
    colors.success.bold(`✔ Agent "${name}" successfully created and persisted!`),
    colors.dim(`Role: `) + colors.boldWhite(role),
    colors.dim(`Tools: `) + colors.primary(Array.isArray(allowedTools) ? allowedTools.join(", ") : "ALL"),
    colors.dim(`Model: `) + colors.accent(model || "inherit"),
    colors.dim(`Max Rounds: `) + colors.warning(String(maxRounds)),
    ``,
    colors.subtle(`Invoke anywhere in chat: `) + colors.warning(`/subagents`) + colors.subtle(` or the agent can call it via `) + colors.warning(`invoke_subagent`),
  ], { borderColor: colors.success }));

  return newAgent;
}
