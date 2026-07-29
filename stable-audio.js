const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const STABILITY_API = "https://api.stability.ai/v2beta/audio/stable-audio-2";

class StableAudioAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = STABILITY_API;
  }

  getHeaders(isMultipart = false) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  async generateAudio({ prompt, duration = 30, outputFormat = "mp3" }, retries = 0) {
    const MAX_RETRIES = 3;
    const body = {
      prompt,
      duration,
      output_format: outputFormat,
      steps: 8,
      cfg_scale: 1,
      model: "stable-audio-2.5",
    };

    try {
      const res = await fetch(`${this.baseURL}/text-to-audio`, {
        method: "POST",
        headers: this.getHeaders(false),
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        if (retries >= MAX_RETRIES) {
          throw new Error(`Rate limited ${MAX_RETRIES} times. Skipping.`);
        }
        console.warn(`    Rate limited (429). Retry ${retries + 1}/${MAX_RETRIES}. Waiting 60s...`);
        await new Promise((r) => setTimeout(r, 60000));
        return this.generateAudio({ prompt, duration, outputFormat }, retries + 1);
      }

      if (res.status === 402) {
        throw new Error("QUOTA_EXCEEDED");
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error ${res.status}: ${errText}`);
      }

      const json = await res.json();
      return {
        id: json.id,
        status: json.status,
      };
    } catch (err) {
      if (err.message === "QUOTA_EXCEEDED") throw err;
      throw new Error(`Generation failed: ${err.message}`);
    }
  }

  async pollResult(generationId, maxWait = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(
          `${this.baseURL}/result/${generationId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              Accept: "application/json",
            },
          }
        );

        if (!res.ok) {
          console.warn(`    Poll error: ${res.status}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const json = await res.json();

        if (json.status === "completed" || json.status === "done") {
          return {
            status: "completed",
            audioUrl: json.audio_file?.url || json.audio?.url,
            audioData: json.audio_file?.base64 || json.audio?.base64,
          };
        }

        if (json.status === "failed" || json.status === "error") {
          throw new Error(`Generation failed: ${json.error || "unknown"}`);
        }

        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        if (err.message.includes("Generation failed")) throw err;
        console.warn(`    Poll retry: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw new Error("Generation timed out");
  }

  async generate({ prompt, duration, outputPath }) {
    console.log(`    Submitting: "${prompt.substring(0, 60)}..."`);
    const result = await this.generateAudio({ prompt, duration });
    console.log(`    Job ID: ${result.id}, polling...`);

    const pollResult = await this.pollResult(result.id);

    if (pollResult.audioUrl) {
      const audioRes = await fetch(pollResult.audioUrl);
      if (!audioRes.ok) throw new Error("Failed to download audio");
      const buffer = await audioRes.buffer();
      fs.writeFileSync(outputPath, buffer);
    } else if (pollResult.audioData) {
      const buffer = Buffer.from(pollResult.audioData, "base64");
      fs.writeFileSync(outputPath, buffer);
    } else {
      throw new Error("No audio data in response");
    }

    return outputPath;
  }
}

function createAudioFilename(prompt, index) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50);
  const timestamp = Date.now();
  return `${String(index).padStart(3, "0")}_${slug}_${timestamp}.mp3`;
}

module.exports = { StableAudioAPI, createAudioFilename };
