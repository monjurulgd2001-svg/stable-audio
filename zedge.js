const fetch = require("node-fetch");

const ZEDGE_GQL = "https://api-gateway.zedge.net/graphql";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://www.zedge.net",
  Referer: "https://www.zedge.net/",
};

// Copyright-safe: Words/titles to NEVER use in prompts (registered trademarks, song titles, artist names)
const BLOCKED_TERMS = [
  "iphone", "android", "samsung", "nokia", "whatsapp", "messenger", "discord", "snapchat",
  "eminem", "drake", "taylor swift", "beyonce", "kendrick", "rihanna", "adele",
  "minecraft", "fortnite", "valorant", "league of legends", "gta", "call of duty",
  "marvel", "disney", "pixar", "dc comics", "star wars", "harry potter",
  "bollywood", "hollywood", "netflix", "spotify", "tiktok", "instagram",
];

// Copyright-safe: Never include specific song/artist references
const BLOCKED_PATTERNS = [
  /\b(song|track|album|remix)\s+by\b/i,
  /\b(cover|version)\s+of\b/i,
  /\b(feat|featuring|ft\.?)\s+/i,
  /\b(official|original)\s+(video|audio|song)\b/i,
];

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  if (BLOCKED_TERMS.some((term) => lower.includes(term))) return true;
  if (BLOCKED_PATTERNS.some((pat) => pat.test(text))) return true;
  return false;
}

const BROWSE_QUERY = `
query browse($input: BrowseAsUgcInput!) {
  browseAsUgc(input: $input) {
    page
    total
    items {
      ... on BrowseRingtone {
        id
        contentType
        title
        tags
        meta {
          durationMs
          previewUrl
        }
      }
      ... on BrowseNotificationSound {
        id
        contentType
        title
        tags
        meta {
          durationMs
          previewUrl
        }
      }
    }
  }
}`;

const CATEGORY_MAP = {
  ringtone: "RINGTONE",
  notification: "NOTIFICATION_SOUND",
  message: "RINGTONE",
};

const SEARCH_QUERIES = {
  ringtone: [
    "trending ringtone",
    "popular ringtone 2024",
    "best ringtone",
    "cool ringtone",
    "iphone ringtone",
    "android ringtone",
    "funny ringtone",
    "classic ringtone",
    "melody ringtone",
    "bass ringtone",
  ],
  notification: [
    "notification sound",
    "alert tone",
    "message alert",
    "popup sound",
    "bell notification",
    "chime alert",
    "quick notification",
    "soft notification",
    "digital alert",
    "system notification",
  ],
  message: [
    "message tone",
    "text message sound",
    "sms tone",
    "whatsapp tone",
    "messenger alert",
    "chat notification",
    "incoming message",
    "reply tone",
    "new message alert",
    "inbox tone",
  ],
};

async function fetchTrending(contentType, page = 1, size = 24) {
  const gqlType = CATEGORY_MAP[contentType] || "RINGTONE";
  const variables = {
    input: {
      contentType: gqlType,
      page,
      size,
    },
  };

  try {
    const res = await fetch(ZEDGE_GQL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query: BROWSE_QUERY, variables }),
    });

    if (!res.ok) {
      console.warn(`  Zedge API error: ${res.status} for ${contentType}`);
      return [];
    }

    const json = await res.json();
    const items = json?.data?.browseAsUgc?.items || [];
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      tags: item.tags || [],
      durationMs: item.meta?.durationMs || 30000,
      previewUrl: item.meta?.previewUrl,
      contentType: item.contentType,
      source: "zedge_trending",
      category: contentType,
    }));
  } catch (err) {
    console.warn(`  Error fetching trending ${contentType}:`, err.message);
    return [];
  }
}

async function fetchSearch(query, size = 24) {
  const searchQuery = `
  query search($input: SearchAsUgcInput!) {
    searchAsUgc(input: $input) {
      items {
        ... on SearchRingtone {
          id
          contentType
          title
          tags
          meta {
            durationMs
            previewUrl
          }
        }
        ... on SearchNotificationSound {
          id
          contentType
          title
          tags
          meta {
            durationMs
            previewUrl
          }
        }
      }
    }
  }`;

  const variables = {
    input: {
      keyword: query,
      contentType: "RINGTONE",
      size,
    },
  };

  try {
    const res = await fetch(ZEDGE_GQL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query: searchQuery, variables }),
    });

    if (!res.ok) return [];

    const json = await res.json();
    const items = json?.data?.searchAsUgc?.items || [];
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      tags: item.tags || [],
      durationMs: item.meta?.durationMs || 30000,
      previewUrl: item.meta?.previewUrl,
      contentType: item.contentType,
      source: "zedge_search",
      query,
    }));
  } catch (err) {
    console.warn(`  Search error for "${query}":`, err.message);
    return [];
  }
}

function generatePrompt(item) {
  const tags = (item.tags || []).filter((t) => !containsBlockedContent(t));
  const category = item.category || "ringtone";
  const durationSec = Math.round((item.durationMs || 30000) / 1000);

  let audioType;
  switch (category) {
    case "notification":
      audioType = "short notification alert sound";
      break;
    case "message":
      audioType = "message notification tone";
      break;
    default:
      audioType = "mobile ringtone";
  }

  const safeTags = tags.slice(0, 3).filter((t) => {
    const lower = t.toLowerCase();
    return lower.length > 2 && lower.length < 30 && !containsBlockedContent(lower);
  });

  const moodWords = ["upbeat", "calm", "energetic", "soft", "bright", "warm", "modern", "clean"];
  const mood = moodWords[Math.floor(Math.random() * moodWords.length)];

  const promptParts = [
    `An original ${mood} ${audioType}`,
    "created as a completely new composition",
    safeTags.length > 0 ? `featuring ${safeTags.join(" and ")} style elements` : "",
    `${durationSec} seconds long`,
    "professional studio quality production",
    "100 percent copyright free original work",
    "no vocals pure instrumental",
    "designed for mobile devices",
  ];

  const prompt = promptParts.filter(Boolean).join(". ");

  if (containsBlockedContent(prompt)) {
    return null;
  }

  return {
    prompt,
    duration: Math.min(Math.max(durationSec, 5), 30),
    originalTags: tags,
    sourceCategory: category,
    isOriginal: true,
  };
}

async function collectTrends(count = 50) {
  console.log("\n--- Collecting Zedge Trends for Copyright-Safe Prompts ---");
  console.log("  NOTE: Only using tags/genres for inspiration. All audio will be AI-generated original content.");
  const allItems = [];
  const categories = ["ringtone", "notification", "message"];

  for (const cat of categories) {
    console.log(`  Fetching trending ${cat}s...`);
    const items = await fetchTrending(cat, 1, 15);
    allItems.push(...items);
    await new Promise((r) => setTimeout(r, 500));
  }

  const searchBatch = SEARCH_QUERIES.ringtone
    .concat(SEARCH_QUERIES.notification)
    .concat(SEARCH_QUERIES.message);

  const searchCount = Math.min(5, Math.ceil(count / 5));
  const selectedSearches = searchBatch
    .sort(() => Math.random() - 0.5)
    .slice(0, searchCount);

  for (const q of selectedSearches) {
    console.log(`  Searching: "${q}"...`);
    const items = await fetchSearch(q, 8);
    allItems.push(...items);
    await new Promise((r) => setTimeout(r, 400));
  }

  const seen = new Set();
  const unique = [];
  for (const item of allItems) {
    const key = item.id || item.title;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  console.log(`  Total unique trends collected: ${unique.length}`);

  const prompts = [];
  for (const item of unique) {
    if (prompts.length >= count) break;
    const generated = generatePrompt(item);
    if (generated) {
      prompts.push({
        ...generated,
        zedgeId: item.id,
        zedgeTitle: item.title,
        sourceCategory: item.category,
      });
    }
  }

  console.log(`  Generated ${prompts.length} copyright-safe audio prompts`);
  console.log("  All prompts are for ORIGINAL AI-generated compositions only.");
  return prompts;
}

module.exports = { collectTrends, generatePrompt, fetchTrending, fetchSearch, containsBlockedContent, BLOCKED_TERMS };
