import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import xml2js from "xml2js"; // <-- need this for XML parsing
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.text({ type: "*/*" }));

// -------------------- CONFIG --------------------
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "https://bla-bla-bla-xzpf.onrender.com/oauth2callback";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

let ACCESS_TOKEN = null;
let CHANNEL_ID = null;
app.get("/auth", (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&response_type=code&scope=${encodeURIComponent(
    SCOPE
  )}&access_type=offline&prompt=consent`;
  res.redirect(authUrl);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenResp.json();
  console.log("Tokens:", tokens);

  ACCESS_TOKEN = tokens.access_token;

  const channelResp = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
    { headers: { Authorization: "Bearer " + ACCESS_TOKEN } }
  );
  const channelData = await channelResp.json();
  CHANNEL_ID = channelData.items?.[0]?.id;
  console.log("Channel ID:", CHANNEL_ID);

  await subscribeToFeed(CHANNEL_ID);

  res.send("✅ Auth successful! Subscribed to YouTube PubSub feed.");
});

// -------------------- STEP 2: SUBSCRIBE --------------------
async function subscribeToFeed(channelId) {
  const hubUrl = "https://pubsubhubbub.appspot.com/subscribe";
  const callbackUrl = "https://bla-bla-bla-xzpf.onrender.com/webhook";
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    "hub.callback": callbackUrl,
    "hub.verify": "async",
  });

  const resp = await fetch(hubUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  console.log("Subscribe response:", await resp.text());
}

// -------------------- STEP 3: VERIFY WEBHOOK --------------------
app.get("/webhook", (req, res) => {
  const challenge = req.query["hub.challenge"];
  if (challenge) {
    console.log("Verification challenge:", challenge);
    res.status(200).send(challenge);
  } else {
    res.status(400).send("No challenge found");
  }
});

// -------------------- STEP 4: HANDLE NEW VIDEO UPLOAD --------------------
app.post("/webhook", async (req, res) => {
  console.log("📩 New PubSub notification received");
  console.log("Raw body:", req.body);  // 👈 should now print the XML

  // Parse XML body from YouTube
  xml2js.parseString(req.body, (err, result) => {
    if (err) {
      console.error("XML parse error:", err);
    } else {
      const entry = result.feed?.entry?.[0];
      if (entry) {
        const videoId = entry["yt:videoId"]?.[0];
        const title = entry.title?.[0];
        console.log("🎬 New Video Uploaded:", title, "(ID:", videoId, ")");
      } else {
        console.log("⚠️ No <entry> found in feed");
      }
    }
  });

  // Respond quickly so YouTube doesn’t retry
  res.status(200).send("OK");

  // Fetch comments asynchronously (don’t block YouTube’s request)
  fetchAllComments().catch(console.error);
});

// -------------------- FETCH ALL COMMENTS --------------------
async function fetchAllComments() {
  if (!ACCESS_TOKEN || !CHANNEL_ID) return;

  try {
    // Get up to 5 latest videos
    const videoResp = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${CHANNEL_ID}&maxResults=5&order=date&type=video`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    const videoData = await videoResp.json();
    const videos = videoData.items || [];

    for (const v of videos) {
      const videoId = v.id.videoId;
      console.log(`\n📹 Fetching comments for video: ${videoId}`);

      const commentResp = await fetch(
        `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=10&order=time`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
      const data = await commentResp.json();

      if (data.items) {
        data.items.forEach((item) => {
          const snippet = item.snippet.topLevelComment.snippet;
          console.log("Name:", snippet.authorDisplayName);
          console.log("Comment:", snippet.textDisplay);
          console.log("---------------------------");
        });
      } else {
        console.log("No comments found for this video:", data);
      }
    }
  } catch (err) {
    console.error("Error fetching comments:", err);
  }
}
let lastFetchedVideo = null;

setInterval(async () => {
    await fetchAllComments();
  }
}, 60000);

// -------------------- START --------------------
app.listen(7070, () =>
  console.log("🚀 Server running on http://localhost:7070")
);






