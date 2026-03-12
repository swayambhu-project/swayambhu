// Swayambhu Chat Handler — Platform-agnostic chat session pipeline
// Channel adapters (KV-loaded) handle platform specifics.
// The chat system prompt (prompt:chat) is in KV = agent-evolvable.
//
// Every kernel method is called via K (the KernelRPC binding or DevBrainstem).
// This module is kernel-level code — imported directly, not loaded from KV.

export async function handleChat(K, channel, inbound, adapter) {
  const { chatId, text, command } = inbound;
  const convKey = `chat:state:${channel}:${chatId}`;

  // Load or init conversation state
  let conv = await K.kvGet(convKey) || {
    messages: [],
    total_cost: 0,
    created_at: new Date().toISOString(),
    turn_count: 0,
  };

  // Handle commands
  if (command === "reset") {
    conv.total_cost = 0;
    await K.kvPutSafe(convKey, conv);
    await adapter.sendReply(chatId, "Budget refilled. Conversation history preserved.");
    return { ok: true, reason: "reset" };
  }
  if (command === "clear") {
    await K.kvDeleteSafe(convKey);
    await adapter.sendReply(chatId, "Conversation cleared.");
    return { ok: true, reason: "clear" };
  }

  // Load config: global defaults + person profile overrides
  const defaults = await K.getDefaults();
  const person = await K.kvGet(`person:${inbound.userId}`);
  const chatDefaults = defaults?.chat || {};
  const personConfig = person?.config || {};
  const chatConfig = { ...chatDefaults, ...personConfig };
  const maxCost = chatConfig.max_cost_per_conversation || 0.50;
  if (conv.total_cost >= maxCost) {
    await adapter.sendReply(chatId, "Budget reached. Send /reset to refill or /clear to start fresh.");
    return { ok: true, reason: "budget_exhausted" };
  }

  // Build system prompt (dharma injected by kernel in callLLM)
  const [wisdom, chatPrompt] = await Promise.all([
    K.kvGet("wisdom"),
    K.kvGet("prompt:chat"),
  ]);
  const personContext = person
    ? `\n\nPerson profile:\n${JSON.stringify(person)}`
    : "";
  const systemPrompt = [
    wisdom ? `Wisdom:\n${wisdom}` : "",
    chatPrompt || "You are in a live chat. Respond conversationally.",
    personContext,
  ].join("\n\n").trim();

  // Append user message
  conv.messages.push({ role: "user", content: text });

  // Resolve model + tools
  const chatModel = chatConfig.model || defaults?.orient?.model || "sonnet";
  const model = K.resolveModel(chatModel);
  const tools = K.buildToolDefinitions();

  // Tool-calling loop
  const maxRounds = chatConfig.max_tool_rounds || 5;
  let reply = null;

  for (let i = 0; i < maxRounds; i++) {
    const response = await K.callLLM({
      model,
      effort: chatConfig.effort || "low",
      maxTokens: chatConfig.max_output_tokens || 1000,
      systemPrompt,
      messages: conv.messages,
      tools,
      step: `chat_${channel}_t${conv.turn_count}_r${i}`,
    });
    conv.total_cost += response.cost || 0;

    if (response.toolCalls?.length) {
      conv.messages.push({
        role: "assistant",
        content: response.content || null,
        tool_calls: response.toolCalls,
      });
      const results = await Promise.all(
        response.toolCalls.map(tc =>
          K.executeToolCall(tc).catch(err => ({ error: err.message }))
        )
      );
      for (let j = 0; j < response.toolCalls.length; j++) {
        conv.messages.push({
          role: "tool",
          tool_call_id: response.toolCalls[j].id,
          content: JSON.stringify(results[j]),
        });
      }
      continue;
    }

    reply = response.content;
    conv.messages.push({ role: "assistant", content: reply });
    break;
  }

  if (!reply) reply = "(no response)";

  // Send via channel adapter
  await adapter.sendReply(chatId, reply);

  // Trim + save state
  conv.turn_count++;
  conv.last_activity = new Date().toISOString();
  const maxMsgs = chatConfig.max_history_messages || 40;
  if (conv.messages.length > maxMsgs) {
    conv.messages = conv.messages.slice(-maxMsgs);
  }
  await K.kvPutSafe(convKey, conv);

  await K.karmaRecord({
    event: "chat_turn",
    channel,
    chat_id: chatId,
    turn: conv.turn_count,
    cost: conv.total_cost,
  });

  return { ok: true, turn: conv.turn_count };
}
