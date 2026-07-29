const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const EDUMAILS_API = "https://api.edu-mails.com/api";

const PASSWORD = "AudioGen@2024!Strong";

const FIRST_NAMES = [
  "James", "Olivia", "Liam", "Emma", "Noah", "Ava", "William", "Sophia",
  "Benjamin", "Isabella", "Lucas", "Mia", "Henry", "Charlotte", "Alexander",
  "Amelia", "Daniel", "Harper", "Michael", "Evelyn", "Ethan", "Abigail",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Wilson", "Anderson", "Taylor", "Thomas",
  "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = (min = 400, max = 1200) => sleep(min + Math.random() * (max - min));

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
}

function getActiveAccount() {
  const accounts = loadAccounts();
  return accounts.find((a) => a.active && a.apiKeys?.length > 0) || null;
}

function getWorkingApiKey() {
  const accounts = loadAccounts();
  for (const acc of accounts) {
    if (acc.active && acc.apiKeys?.length > 0) {
      for (const key of acc.apiKeys) {
        if (!key.exhausted) return { account: acc, apiKey: key };
      }
    }
  }
  return null;
}

function markKeyExhausted(apiKey) {
  const accounts = loadAccounts();
  for (const acc of accounts) {
    if (acc.apiKeys) {
      for (const key of acc.apiKeys) {
        if (key.key === apiKey) {
          key.exhausted = true;
          key.exhaustedAt = new Date().toISOString();
        }
      }
    }
  }
  saveAccounts(accounts);
}

function markAccountExhausted(email) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.email === email);
  if (acc) {
    acc.active = false;
    acc.exhaustedAt = new Date().toISOString();
  }
  saveAccounts(accounts);
}

async function generateEduEmail() {
  const res = await fetch(`${EDUMAILS_API}/emails/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action: "random" }),
  });
  if (!res.ok) throw new Error(`Email generation failed: HTTP ${res.status}`);
  const json = await res.json();
  const email = json?.data?.email;
  if (!email?.address) throw new Error("Invalid email API response");
  return { address: email.address, uuid: email.uuid };
}

async function fetchInbox(uuid) {
  const res = await fetch(`${EDUMAILS_API}/emails/${uuid}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Inbox fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  return json?.data?.messages || [];
}

async function waitForMessages(uuid, timeout = 120000, interval = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const messages = await fetchInbox(uuid);
      if (messages.length > 0) return messages;
    } catch (e) {
      console.warn("    Inbox poll retry:", e.message);
    }
    await sleep(interval);
  }
  return [];
}

function extractOtp(messages) {
  for (const m of messages) {
    const parts = [
      m.subject, m.body, m.html, m.text, m.content,
      m.text_body, m.html_body, m.body_html, m.body_text,
      JSON.stringify(m),
    ].filter(Boolean).join("\n");

    const codeParam = parts.match(/code=(\d{6})/i);
    if (codeParam) return codeParam[1];
    const htmlMatch = parts.match(/>(\d{6})</);
    if (htmlMatch) return htmlMatch[1];
    const standalone = parts.match(/(?<!\d)\d{6}(?!\d)/);
    if (standalone) return standalone[0];
  }
  return null;
}

function extractVerificationLink(messages) {
  for (const m of messages) {
    const parts = [
      m.subject, m.body, m.html, m.text, m.content,
      JSON.stringify(m),
    ].filter(Boolean).join("\n");

    const match = parts.match(/https?:\/\/[^\s"'<>]*(?:verification|verify|confirm)[^\s"'<>]+/i);
    if (match) return match[0].replace(/&amp;/g, "&");
  }
  return null;
}

async function autoDetectAndClick(page, selectors, label) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        console.log(`    Clicked ${label}: ${sel}`);
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickByText(page, text, label) {
  const clicked = await page.evaluate((txt) => {
    const elements = document.querySelectorAll("a, button, span, div");
    for (const el of elements) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t.includes(txt.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);

  if (clicked) {
    console.log(`    Clicked ${label} by text: "${text}"`);
    return true;
  }
  return false;
}

async function autoDetectInput(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(value, { delay: 30 });
        console.log(`    Filled ${label}: ${sel}`);
        return true;
      }
    } catch {}
  }
  return false;
}

async function screenshot(page, name) {
  try {
    const dir = path.join(__dirname, "screenshots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  } catch (err) {
    console.warn(`    Screenshot failed: ${err.message}`);
  }
}

async function registerNewAccount() {
  console.log("\n[AccountManager] Registering new Stable Audio account...");

  const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    defaultViewport: { width: 1920, height: 1080 },
    args: [
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-default-browser-check",
      "--no-first-run",
      "--ignore-certificate-errors",
      "--ignore-ssl-errors",
      "--disable-web-security",
      "--allow-running-insecure-content",
      "--disable-features=IsolateOrigins,site-per-process",
      "--ssl-version-min=tls1",
      "--disable-features=SecurityDisbleCertificateCheck",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const { address: EMAIL, uuid } = await generateEduEmail();
    console.log(`  Generated email: ${EMAIL}`);

    console.log("  Navigating to Stable Audio auth...");
    await page.goto("https://v2.auth.stableaudio.com", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await sleep(3000);
    await screenshot(page, "01-auth-page");

    console.log("  Looking for signup link...");
    let signupClicked = await autoDetectAndClick(page, [
      'a[href*="signup"]',
      'a[href*="register"]',
      'a[href*="sign-up"]',
      'a[href*="create"]',
    ], "signup link");

    if (!signupClicked) {
      signupClicked = await clickByText(page, "Sign up", "signup link");
    }
    if (!signupClicked) {
      signupClicked = await clickByText(page, "Create account", "signup link");
    }
    if (!signupClicked) {
      signupClicked = await clickByText(page, "Get started", "signup link");
    }
    if (!signupClicked) {
      signupClicked = await clickByText(page, "Register", "signup link");
    }
    if (!signupClicked) {
      signupClicked = await clickByText(page, "Don't have an account", "signup link");
    }

    if (!signupClicked) {
      console.log("  Trying direct signup URL...");
      await page.goto("https://v2.auth.stableaudio.com/signup", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
    }
    await sleep(3000);
    await screenshot(page, "02-signup-page");

    console.log("  Looking for email input fields...");
    const EMAIL_SELECTORS = [
      'input[name="email"]',
      'input[type="email"]',
      'input[inputmode="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="mail"]',
      'input[id*="email"]',
      'input[aria-label*="email" i]',
    ];

    const emailFilled = await autoDetectInput(page, EMAIL_SELECTORS, EMAIL, "email");
    if (!emailFilled) {
      console.log("  Email field not found. Checking page structure...");
      const pageContent = await page.content();
      console.log("  Page title:", await page.title());
      console.log("  Current URL:", page.url());

      const allInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("input")).map(i => ({
          name: i.name,
          type: i.type,
          placeholder: i.placeholder,
          id: i.id,
          class: i.className.substring(0, 50),
        }));
      });
      console.log("  Found inputs:", JSON.stringify(allInputs, null, 2));
      await screenshot(page, "02b-no-email-field");

      throw new Error("Could not find email input field on signup page");
    }
    await humanPause(200, 500);

    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);

    await autoDetectInput(page, [
      'input[name="firstName"]', 'input[name="first_name"]',
      'input[placeholder*="first" i]', 'input[aria-label*="first" i]',
      'input[id*="first"]',
    ], firstName, "firstName");

    await autoDetectInput(page, [
      'input[name="lastName"]', 'input[name="last_name"]',
      'input[placeholder*="last" i]', 'input[aria-label*="last" i]',
      'input[id*="last"]',
    ], lastName, "lastName");

    await autoDetectInput(page, [
      'input[name="password"]', 'input[type="password"]',
      'input[autocomplete="new-password"]',
    ], PASSWORD, "password");

    await humanPause(300, 700);
    await screenshot(page, "03-form-filled");

    console.log("  Submitting signup form...");
    let submitClicked = await autoDetectAndClick(page, [
      'button[type="submit"]',
      'input[type="submit"]',
    ], "submit button");

    if (!submitClicked) {
      submitClicked = await clickByText(page, "Sign up", "submit button");
    }
    if (!submitClicked) {
      submitClicked = await clickByText(page, "Create account", "submit button");
    }
    if (!submitClicked) {
      submitClicked = await clickByText(page, "Continue", "submit button");
    }
    if (!submitClicked) {
      await page.keyboard.press("Enter");
      console.log("    Pressed Enter as fallback");
    }

    await sleep(5000);
    await screenshot(page, "04-after-submit");

    console.log("  Waiting for verification email...");
    const messages = await waitForMessages(uuid, 120000, 5000);

    if (messages.length > 0) {
      console.log(`  Received ${messages.length} message(s)`);

      const verificationLink = extractVerificationLink(messages);
      if (verificationLink) {
        console.log("  Following verification link...");
        await page.goto(verificationLink, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
        await sleep(5000);
        await screenshot(page, "05-verified");
      } else {
        const otp = extractOtp(messages);
        if (otp) {
          console.log(`  OTP found: ${otp}`);
          const OTP_SELECTORS = [
            'input[data-input-otp="true"]',
            'input[autocomplete="one-time-code"]',
            'input[name="code"]',
            'input[name="otp"]',
            'input[placeholder*="code" i]',
            'input[placeholder*="otp" i]',
            'input[maxlength="6"]',
          ];
          await autoDetectInput(page, OTP_SELECTORS, otp, "OTP");
          await page.keyboard.press("Enter");
          await sleep(5000);
          await screenshot(page, "05-otp-entered");
        }
      }
    }

    console.log("  Navigating to API keys page...");
    await sleep(3000);
    await page.goto("https://stableaudio.com/settings/api-keys", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await sleep(5000);
    await screenshot(page, "06-api-keys-page");

    console.log("  Looking for create key button...");
    let newKeyClicked = await autoDetectAndClick(page, [
      'button[data-testid*="key"]',
      'button[data-testid*="create"]',
    ], "new key button");

    if (!newKeyClicked) {
      newKeyClicked = await clickByText(page, "New key", "new key button");
    }
    if (!newKeyClicked) {
      newKeyClicked = await clickByText(page, "Create key", "new key button");
    }
    if (!newKeyClicked) {
      newKeyClicked = await clickByText(page, "Generate", "new key button");
    }
    if (!newKeyClicked) {
      newKeyClicked = await clickByText(page, "Create API key", "new key button");
    }
    await sleep(3000);
    await screenshot(page, "07-key-modal");

    let apiKey = null;

    const keyFromInput = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input");
      for (const input of inputs) {
        const val = input.value || "";
        if (val.length > 10 && (val.startsWith("sk-") || val.includes("key") || input.readOnly)) {
          return val;
        }
      }
      return null;
    });

    if (keyFromInput) {
      apiKey = keyFromInput;
    }

    if (!apiKey) {
      await autoDetectAndClick(page, [
        'button[data-testid*="close"]',
        'button[aria-label*="close" i]',
      ], "close button");

      let closeClicked = await clickByText(page, "Done", "close button");
      if (!closeClicked) {
        closeClicked = await clickByText(page, "Close", "close button");
      }
      if (!closeClicked) {
        closeClicked = await clickByText(page, "Copy", "close button");
      }
      await sleep(2000);

      apiKey = await page.evaluate(() => {
        const allText = document.body.innerText;
        const keyMatch = allText.match(/sk-[a-zA-Z0-9]{20,}/);
        if (keyMatch) return keyMatch[0];

        const inputs = document.querySelectorAll("input");
        for (const input of inputs) {
          const val = input.value || "";
          if (val.length > 15) return val;
        }
        return null;
      });
    }

    if (apiKey) {
      console.log(`  API Key obtained: ${apiKey.substring(0, 15)}...`);
      const accounts = loadAccounts();
      accounts.push({
        email: EMAIL,
        password: PASSWORD,
        uuid,
        apiKey,
        apiKeys: [{ key: apiKey, exhausted: false, createdAt: new Date().toISOString() }],
        active: true,
        createdAt: new Date().toISOString(),
      });
      saveAccounts(accounts);
      return { email: EMAIL, apiKey };
    }

    await screenshot(page, "08-no-key-found");
    throw new Error("Could not extract API key from page");
  } catch (err) {
    console.error(`  Registration failed: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

async function getApiKey() {
  let working = getWorkingApiKey();
  if (working) return working.apiKey.key;

  console.log("[AccountManager] No working API keys found.");

  const envKey = process.env.STABLE_AUDIO_KEY;
  if (envKey && envKey.length > 10) {
    addManualApiKey("env@user.com", envKey);
    console.log(`  Loaded API key from STABLE_AUDIO_KEY env`);
    return envKey;
  }

  const keysFile = path.join(__dirname, "api_keys.txt");
  if (fs.existsSync(keysFile)) {
    const content = fs.readFileSync(keysFile, "utf-8").trim();
    const lines = content.split("\n").filter((l) => l.trim().length > 10);
    for (const line of lines) {
      const key = line.trim();
      if (key.startsWith("sk-") || key.length > 20) {
        addManualApiKey("manual@user.com", key);
        console.log(`  Loaded API key from api_keys.txt`);
        return key;
      }
    }
  }

  console.log("\n  Attempting auto-registration...");
  try {
    const newAcc = await registerNewAccount();
    return newAcc.apiKey;
  } catch (err) {
    console.error(`\n  Auto-registration failed: ${err.message}`);
    console.log("\n  Please add your Stable Audio API key manually:");
    console.log("  1. Go to https://stableaudio.com/settings/api-keys");
    console.log("  2. Create a new key");
    console.log("  3. Add to api_keys.txt or set STABLE_AUDIO_KEY env var\n");
    return null;
  }
}

module.exports = {
  loadAccounts,
  saveAccounts,
  getActiveAccount,
  getWorkingApiKey,
  markKeyExhausted,
  markAccountExhausted,
  registerNewAccount,
  getApiKey,
};
