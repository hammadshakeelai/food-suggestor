// Vercel serverless function for POST /api/suggest.
//
// This mirrors the recipe + image logic in server.js so the app can run on
// Vercel (static `public/` + this function) without a long-lived server.
// server.js remains the source of truth for local `npm start`; this file is
// self-contained on purpose so the two deploy targets never fight over shared
// state. Env vars (AGNES_API_KEY, etc.) are injected by Vercel.

const AGNES_BASE_URL = (process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1").replace(/\/$/, "");
const AGNES_TEXT_MODEL = process.env.AGNES_TEXT_MODEL || "agnes-2.0-flash";
const AGNES_IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL || "agnes-image-2.1-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!process.env.AGNES_API_KEY) {
    sendJson(res, 503, {
      error: "Missing AGNES_API_KEY. Set it in your Vercel project environment variables."
    });
    return;
  }

  try {
    const body = await readJson(req);
    const messages = normalizeMessages(body.messages);
    const userMood = typeof body.userMood === "string" ? body.userMood.trim() : "";

    const recipe = await createRecipe(messages, userMood);
    const imagePrompt = buildFoodImagePrompt(recipe);

    // Image generation is best-effort: if the image model is slow or errors,
    // still return the recipe so the user always gets something useful. The
    // frontend renders cleanly with an empty imageUrl.
    let imageUrl = "";
    try {
      const image = await generateFoodImage(imagePrompt);
      imageUrl = image.url;
    } catch (imageError) {
      console.error("Image generation failed:", imageError?.message || imageError);
    }

    const content = formatRecipeForChat(recipe);
    sendJson(res, 200, {
      title: recipe.chat_title || recipe.title || "New recipe",
      assistant: {
        role: "assistant",
        content,
        recipe,
        imageUrl,
        imagePrompt,
        createdAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong. Please try again." });
  }
}

async function createRecipe(messages, userMood) {
  const fallbackUserMessage = "Suggest a delicious food recipe for me.";
  const userMessages = messages.length
    ? messages
    : [{ role: "user", content: fallbackUserMessage }];

  const system = [
    "You are Pink Plate, a warm recipe chatbot.",
    "Generate one complete, practical recipe based on the conversation.",
    "If the user asks for changes, revise the recipe while keeping the conversation context.",
    "Return only valid minified JSON. Do not wrap it in markdown.",
    "JSON schema:",
    "{",
    "\"chat_title\":\"short sidebar title\",",
    "\"title\":\"recipe name\",",
    "\"short_intro\":\"one appetizing sentence\",",
    "\"servings\":\"serving count\",",
    "\"time\":\"total time\",",
    "\"ingredients\":[\"ingredient with quantity\"],",
    "\"steps\":[\"clear step\"],",
    "\"tips\":[\"short useful tip\"],",
    "\"image_notes\":\"visual description of the finished dish\"",
    "}"
  ].join(" ");

  const response = await agnesFetch("/chat/completions", {
    model: AGNES_TEXT_MODEL,
    temperature: 0.85,
    messages: [
      { role: "system", content: system },
      ...userMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || "").slice(0, 5000)
      })),
      ...(userMood ? [{ role: "user", content: `Extra craving or constraint: ${userMood}` }] : [])
    ]
  }, 45000);

  const raw = response?.choices?.[0]?.message?.content || "";
  const parsed = parseRecipeJson(raw);
  if (parsed) return cleanRecipe(parsed);

  return cleanRecipe({
    chat_title: "Recipe idea",
    title: "Chef's Surprise Plate",
    short_intro: raw || "A quick, cozy dish made around your current craving.",
    servings: "2 servings",
    time: "30 minutes",
    ingredients: ["Use the ingredients suggested in the chat response."],
    steps: [raw || "Ask for another suggestion once your Agnes key is connected."],
    tips: ["Taste and adjust seasoning at the end."],
    image_notes: raw || "A pretty plated homemade dish"
  });
}

async function generateFoodImage(prompt) {
  // Keep the image timeout inside Vercel's 60s function budget (see
  // vercel.json maxDuration) so a slow image never triggers a hard 504.
  const response = await agnesFetch("/images/generations", {
    model: AGNES_IMAGE_MODEL,
    prompt,
    size: "1024x768",
    extra_body: {
      response_format: "url"
    }
  }, 50000);

  const result = response?.data?.[0] || {};
  return {
    url: result.url || (result.b64_json ? `data:image/png;base64,${result.b64_json}` : ""),
    revisedPrompt: result.revised_prompt || null
  };
}

async function agnesFetch(endpoint, payload, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${AGNES_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `Agnes request failed with ${response.status}`;
      throw new Error(message);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function buildFoodImagePrompt(recipe) {
  const ingredients = recipe.ingredients.slice(0, 8).join(", ");
  const notes = recipe.image_notes || recipe.short_intro || recipe.title;

  return [
    `A mouthwatering finished plate of ${recipe.title}.`,
    notes,
    ingredients ? `Visible key ingredients: ${ingredients}.` : "",
    "Editorial food photography, pink ceramic plate, soft daylight, appetizing steam where appropriate, realistic texture, clean table styling, shallow depth of field, no text, no watermark."
  ].filter(Boolean).join(" ");
}

function formatRecipeForChat(recipe) {
  const ingredients = recipe.ingredients.map((item) => `- ${item}`).join("\n");
  const steps = recipe.steps.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const tips = recipe.tips.length ? `\n\nTips:\n${recipe.tips.map((item) => `- ${item}`).join("\n")}` : "";

  return `${recipe.title}\n${recipe.short_intro}\n\nServings: ${recipe.servings}\nTime: ${recipe.time}\n\nIngredients:\n${ingredients}\n\nSteps:\n${steps}${tips}`;
}

function parseRecipeJson(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf("{");
    const lastBrace = withoutFence.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    try {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function cleanRecipe(recipe) {
  const list = (value, fallback) => {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 16);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return fallback;
  };

  return {
    chat_title: stringOr(recipe.chat_title, recipe.title, "Recipe chat").slice(0, 42),
    title: stringOr(recipe.title, "Chef's Surprise Plate").slice(0, 90),
    short_intro: stringOr(recipe.short_intro, "A cheerful recipe made for your craving.").slice(0, 240),
    servings: stringOr(recipe.servings, "2 servings").slice(0, 40),
    time: stringOr(recipe.time, "30 minutes").slice(0, 40),
    ingredients: list(recipe.ingredients, ["Salt and pepper to taste"]),
    steps: list(recipe.steps, ["Cook until everything is tender, flavorful, and ready to serve."]),
    tips: list(recipe.tips, []),
    image_notes: stringOr(recipe.image_notes, recipe.short_intro, recipe.title, "A plated finished dish").slice(0, 500)
  };
}

function stringOr(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim()
    }))
    .filter((message) => message.content)
    .slice(-12);
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
