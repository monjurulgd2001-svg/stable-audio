const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const GEMINI_MODELS = [
  { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", maxTokens: 8192 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", maxTokens: 8192 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", maxTokens: 8192 },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", maxTokens: 8192 },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", maxTokens: 8192 },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", maxTokens: 8192 },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", maxTokens: 8192 },
  { id: "gemini-1.5-flash-8b", name: "Gemini 1.5 Flash 8B", maxTokens: 8192 },
  { id: "gemini-1.0-pro", name: "Gemini 1.0 Pro", maxTokens: 4096 },
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const USED_PROMPTS_FILE = path.join(__dirname, "used_prompts.json");
const MODEL_CONFIG_FILE = path.join(__dirname, "gemini_model_config.json");

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(MODEL_CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { preferredModel: null, failedModels: [] };
}

function saveModelConfig(config) {
  fs.writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function loadUsedPrompts() {
  try {
    if (fs.existsSync(USED_PROMPTS_FILE)) {
      return JSON.parse(fs.readFileSync(USED_PROMPTS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveUsedPrompts(prompts) {
  fs.writeFileSync(USED_PROMPTS_FILE, JSON.stringify(prompts, null, 2), "utf-8");
}

function isDuplicate(prompt, usedPrompts) {
  const normalized = prompt.toLowerCase().trim().replace(/\s+/g, " ");
  return usedPrompts.some((used) => {
    const usedNorm = used.toLowerCase().trim().replace(/\s+/g, " ");
    if (normalized === usedNorm) return true;
    if (normalized.includes(usedNorm) || usedNorm.includes(normalized)) return true;
    const words1 = new Set(normalized.split(" "));
    const words2 = new Set(usedNorm.split(" "));
    const intersection = [...words1].filter((w) => words2.has(w) && w.length > 3);
    if (intersection.length > Math.min(words1.size, words2.size) * 0.7) return true;
    return false;
  });
}

async function callGeminiModel(model, apiKey, prompt) {
  const url = `${GEMINI_BASE_URL}/${model.id}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: model.maxTokens,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${res.status}: ${errText.substring(0, 200)}`);
  }

  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function buildPrompt(trendData, count) {
  const systemPrompt = `You are an expert audio prompt engineer for creating copyright-free ringtones, notification sounds, and message tones.

RULES:
1. Every prompt MUST describe an ORIGINAL composition - never reference existing songs, artists, or copyrighted material
2. Each prompt must be UNIQUE and different from others
3. Use only genre, mood, instrument, and style descriptions
4. Include specific audio characteristics (tempo, key, texture)
5. Each prompt should be 1-2 sentences long
6. All prompts must be safe for all audiences - no offensive content
7. Focus on mobile-friendly audio (clear, distinctive, not too complex)

FORBIDDEN in prompts:
- Any artist names, song titles, album names
- Brand names (iPhone, Samsung, WhatsApp, etc.)
- References to existing copyrighted works
- Any offensive, violent, or inappropriate content

OUTPUT FORMAT: Return exactly ${count} prompts as a JSON array of strings. Nothing else.

Example format:
["An upbeat electronic ringtone with bright synth melody and steady beat, 15 seconds", "A soft ambient notification sound with gentle chime and warm pad, 8 seconds"]`;

  const userPrompt = `Based on these trending categories from Zedge, generate ${count} unique, copyright-free audio prompts for ringtones, notifications, and message tones.

Trending data: ${JSON.stringify(trendData, null, 2)}

Generate ${count} diverse prompts covering:
- ${Math.ceil(count * 0.4)} ringtones (upbeat, melodic, distinctive)
- ${Math.ceil(count * 0.3)} notification sounds (short, clear, alerting)
- ${Math.ceil(count * 0.3)} message tones (gentle, pleasant, brief)

IMPORTANT: Every prompt must start with "An original" or "A original" to ensure copyright compliance.
Return ONLY the JSON array, no other text.`;

  return systemPrompt + "\n\n" + userPrompt;
}

function parsePromptsFromResponse(text) {
  let prompts = [];

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      prompts = JSON.parse(jsonMatch[0]);
    }
  } catch {
    prompts = text
      .split("\n")
      .map((l) => l.replace(/^\d+[\.\)]\s*/, "").replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 20 && l.length < 300);
  }

  return prompts.filter((p) => typeof p === "string" && p.length > 10);
}

async function generatePromptsWithGemini(trends, apiKey, count = 50) {
  console.log("\n--- Generating Prompts via Gemini AI ---");

  const config = loadModelConfig();
  const usedPrompts = loadUsedPrompts();
  console.log(`  Previously used prompts: ${usedPrompts.length}`);

  const trendData = trends.slice(0, 20).map((t) => ({
    tags: t.tags?.slice(0, 5) || [],
    category: t.sourceCategory || "ringtone",
    title: t.zedgeTitle || "",
  }));

  const fullPrompt = buildPrompt(trendData, count);

  let modelsToTry = GEMINI_MODELS.filter((m) => !config.failedModels?.includes(m.id));

  if (config.preferredModel) {
    const preferred = modelsToTry.find((m) => m.id === config.preferredModel);
    if (preferred) {
      modelsToTry = [preferred, ...modelsToTry.filter((m) => m.id !== preferred.id)];
    }
  }

  console.log(`  Models to try: ${modelsToTry.map((m) => m.name).join(", ")}`);

  for (const model of modelsToTry) {
    console.log(`\n  Trying ${model.name} (${model.id})...`);

    try {
      const text = await callGeminiModel(model, apiKey, fullPrompt);

      if (!text) {
        console.warn(`  ${model.name}: Empty response`);
        continue;
      }

      const rawPrompts = parsePromptsFromResponse(text);

      if (rawPrompts.length === 0) {
        console.warn(`  ${model.name}: No valid prompts parsed`);
        continue;
      }

      const uniquePrompts = [];
      for (const prompt of rawPrompts) {
        if (uniquePrompts.length >= count) break;
        if (!isDuplicate(prompt, usedPrompts) && !isDuplicate(prompt, uniquePrompts)) {
          uniquePrompts.push(prompt);
        }
      }

      console.log(`  ${model.name} success! Raw: ${rawPrompts.length}, Unique: ${uniquePrompts.length}`);

      config.preferredModel = model.id;
      saveModelConfig(config);

      const allUsed = [...usedPrompts, ...uniquePrompts];
      saveUsedPrompts(allUsed);

      return uniquePrompts.map((prompt) => ({
        prompt,
        duration: 10 + Math.floor(Math.random() * 20),
        sourceCategory: prompt.toLowerCase().includes("notification")
          ? "notification"
          : prompt.toLowerCase().includes("message")
          ? "message"
          : "ringtone",
        source: `gemini_${model.id}`,
        isOriginal: true,
      }));
    } catch (err) {
      console.error(`  ${model.name} failed: ${err.message}`);

      if (err.status === 429 || err.message.includes("429")) {
        console.warn(`  Rate limited. Trying next model in 5 seconds...`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (!config.failedModels) config.failedModels = [];
      if (!config.failedModels.includes(model.id)) {
        config.failedModels.push(model.id);
        saveModelConfig(config);
      }
    }
  }

  console.error("  All Gemini models failed!");
  return null;
}

function cleanupOldPrompts() {
  const usedPrompts = loadUsedPrompts();
  if (usedPrompts.length > 500) {
    const trimmed = usedPrompts.slice(-300);
    saveUsedPrompts(trimmed);
    console.log(`  Cleaned up prompts: ${usedPrompts.length} -> ${trimmed.length}`);
  }
}

function resetFailedModels() {
  const config = loadModelConfig();
  config.failedModels = [];
  saveModelConfig(config);
  console.log("  Reset failed models list");
}

module.exports = {
  generatePromptsWithGemini,
  isDuplicate,
  loadUsedPrompts,
  saveUsedPrompts,
  cleanupOldPrompts,
  resetFailedModels,
  GEMINI_MODELS,
};
