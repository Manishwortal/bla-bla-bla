import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import xml2js from "xml2js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(bodyParser.text({ type: "*/*" }));

// -------------------- CONFIG --------------------
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "https://bla-bla-bla-xzpf.onrender.com/oauth2callback";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

let ACCESS_TOKEN = null;
let REFRESH_TOKEN = null;
let CHANNEL_ID = null;

// -------------------- STORAGE FOR TRACKING --------------------
class CommentTracker {
  constructor() {
    this.dataFile = "comment_tracker.json";
    this.data = this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        return JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
      }
    } catch (error) {
      console.error("Error loading tracker data:", error);
    }
    return {
      processedComments: new Set(),
      lastVideoCheck: null,
      videoCommentCounts: {},
      processedVideos: new Set(),
    };
  }

  saveData() {
    try {
      const dataToSave = {
        processedComments: Array.from(this.data.processedComments),
        lastVideoCheck: this.data.lastVideoCheck,
        videoCommentCounts: this.data.videoCommentCounts,
        processedVideos: Array.from(this.data.processedVideos),
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(dataToSave, null, 2));
    } catch (error) {
      console.error("Error saving tracker data:", error);
    }
  }

  isCommentProcessed(commentId) {
    return this.data.processedComments.has(commentId);
  }

  markCommentProcessed(commentId) {
    this.data.processedComments.add(commentId);
    this.saveData();
  }

  updateVideoCommentCount(videoId, count) {
    this.data.videoCommentCounts[videoId] = count;
    this.saveData();
  }

  getVideoCommentCount(videoId) {
    return this.data.videoCommentCounts[videoId] || 0;
  }

  isVideoProcessed(videoId) {
    return this.data.processedVideos.has(videoId);
  }

  markVideoProcessed(videoId) {
    this.data.processedVideos.add(videoId);
    this.saveData();
  }
}

const tracker = new CommentTracker();

// -------------------- AUTH FLOW --------------------
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
  console.log("Tokens received");

  ACCESS_TOKEN = tokens.access_token;
  REFRESH_TOKEN = tokens.refresh_token; // Store for token refresh

  const channelResp = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
    { headers: { Authorization: "Bearer " + ACCESS_TOKEN } }
  );
  const channelData = await channelResp.json();
  CHANNEL_ID = channelData.items?.[0]?.id;
  console.log("Channel ID:", CHANNEL_ID);

  await subscribeToFeed(CHANNEL_ID);

  // Start initial comment processing for existing videos
  setTimeout(() => {
    processAllVideosForNewComments();
  }, 2000);

  res.send(
    "✅ Auth successful! Subscribed to YouTube PubSub feed and started comment monitoring."
  );
});

// -------------------- TOKEN REFRESH --------------------
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) return false;

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });

    const tokens = await tokenResp.json();
    if (tokens.access_token) {
      ACCESS_TOKEN = tokens.access_token;
      console.log("🔄 Access token refreshed");
      return true;
    }
  } catch (error) {
    console.error("Error refreshing token:", error);
  }
  return false;
}

// -------------------- SUBSCRIBE TO PUBSUB --------------------
async function subscribeToFeed(channelId) {
  const hubUrl = "https://pubsubhubbub.appspot.com/subscribe";
  const callbackUrl = "https://bla-bla-bla-xzpf.onrender.com/webhook"; // Updated to your render URL
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    "hub.callback": callbackUrl,
    "hub.verify": "async",
    "hub.lease_seconds": "864000", // 10 days
  });

  const resp = await fetch(hubUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  console.log("Subscribe response:", await resp.text());
}

// -------------------- WEBHOOK HANDLERS --------------------
app.get("/webhook", (req, res) => {
  const challenge = req.query["hub.challenge"];
  if (challenge) {
    console.log("✅ Webhook verification successful");
    res.status(200).send(challenge);
  } else {
    res.status(400).send("No challenge found");
  }
});

app.post("/webhook", async (req, res) => {
  console.log("📩 New PubSub notification received");

  // Respond immediately to YouTube
  res.status(200).send("OK");

  // Process the notification asynchronously
  try {
    xml2js.parseString(req.body, async (err, result) => {
      if (err) {
        console.error("XML parse error:", err);
        return;
      }

      const entry = result?.feed?.entry?.[0];
      if (entry) {
        const videoId = entry["yt:videoId"]?.[0];
        const title = entry.title?.[0];
        const publishedAt = entry.published?.[0];

        console.log("🎬 New Video Detected:", title, "(ID:", videoId, ")");

        // Wait a bit for video to be fully processed by YouTube
        setTimeout(() => {
          processNewVideoComments(videoId, title, publishedAt);
        }, 30000); // Wait 30 seconds
      }
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
  }
});

// -------------------- COMMENT PROCESSING --------------------
async function processNewVideoComments(videoId, videoTitle, publishedAt) {
  if (!ACCESS_TOKEN || !videoId) return;

  try {
    console.log(`\n🔍 Processing comments for NEW video: ${videoTitle}`);

    const comments = await fetchVideoComments(videoId);
    const newComments = comments.filter(
      (comment) => !tracker.isCommentProcessed(comment.commentId)
    );

    console.log(`Found ${newComments.length} new comments on new video`);

    for (const comment of newComments) {
      await createLeadFromComment(comment, videoId, videoTitle, "new_video");
      tracker.markCommentProcessed(comment.commentId);
    }

    tracker.markVideoProcessed(videoId);
  } catch (error) {
    console.error("Error processing new video comments:", error);
  }
}

async function processAllVideosForNewComments() {
  if (!ACCESS_TOKEN || !CHANNEL_ID) return;

  try {
    console.log("\n🔄 Checking all videos for new comments...");

    // Get recent videos (last 50)
    const videoResp = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=id,snippet&channelId=${CHANNEL_ID}&maxResults=50&order=date&type=video`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    if (videoResp.status === 401) {
      console.log("Token expired, refreshing...");
      if (await refreshAccessToken()) {
        return processAllVideosForNewComments(); // Retry with new token
      }
      return;
    }

    const videoData = await videoResp.json();
    const videos = videoData.items || [];

    console.log(`📊 Checking ${videos.length} videos for new comments`);

    for (const video of videos) {
      const videoId = video.id.videoId;
      const videoTitle = video.snippet.title;

      // Get current comment count
      const statsResp = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
      const statsData = await statsResp.json();
      const currentCommentCount = parseInt(
        statsData.items?.[0]?.statistics?.commentCount || 0
      );

      const lastKnownCount = tracker.getVideoCommentCount(videoId);

      // If comment count increased, fetch new comments
      if (currentCommentCount > lastKnownCount) {
        console.log(
          `📈 Video "${videoTitle}" has ${
            currentCommentCount - lastKnownCount
          } new comments`
        );

        const comments = await fetchVideoComments(videoId);
        const newComments = comments.filter(
          (comment) => !tracker.isCommentProcessed(comment.commentId)
        );

        console.log(`Processing ${newComments.length} new comments`);

        for (const comment of newComments) {
          await createLeadFromComment(
            comment,
            videoId,
            videoTitle,
            "existing_video"
          );
          tracker.markCommentProcessed(comment.commentId);
        }

        tracker.updateVideoCommentCount(videoId, currentCommentCount);
      }

      // Small delay to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error("Error processing all videos:", error);
  }
}

async function fetchVideoComments(videoId) {
  const comments = [];
  let pageToken = "";

  try {
    do {
      const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${videoId}&maxResults=100&order=time${
        pageToken ? "&pageToken=" + pageToken : ""
      }`;

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      });

      if (response.status === 401) {
        if (await refreshAccessToken()) {
          continue; // Retry with new token
        }
        break;
      }

      const data = await response.json();

      if (data.items) {
        for (const item of data.items) {
          const snippet = item.snippet.topLevelComment.snippet;

          // Extract detailed comment information for lead generation
          const commentData = {
            commentId: item.snippet.topLevelComment.id,
            authorName: snippet.authorDisplayName,
            authorChannelId: snippet.authorChannelId?.value,
            authorChannelUrl: snippet.authorChannelUrl,
            authorProfileImageUrl: snippet.authorProfileImageUrl,
            commentText: snippet.textDisplay,
            publishedAt: snippet.publishedAt,
            updatedAt: snippet.updatedAt,
            likeCount: snippet.likeCount,
            moderationStatus: snippet.moderationStatus,
            totalReplyCount: item.snippet.totalReplyCount,
            canReply: item.snippet.canReply,
            parentId: null, // This is a top-level comment
            replies: [],
          };

          // Process replies if they exist
          if (item.replies && item.replies.comments) {
            for (const reply of item.replies.comments) {
              const replySnippet = reply.snippet;
              commentData.replies.push({
                commentId: reply.id,
                authorName: replySnippet.authorDisplayName,
                authorChannelId: replySnippet.authorChannelId?.value,
                authorChannelUrl: replySnippet.authorChannelUrl,
                authorProfileImageUrl: replySnippet.authorProfileImageUrl,
                commentText: replySnippet.textDisplay,
                publishedAt: replySnippet.publishedAt,
                updatedAt: replySnippet.updatedAt,
                likeCount: replySnippet.likeCount,
                moderationStatus: replySnippet.moderationStatus,
                parentId: replySnippet.parentId,
              });
            }
          }

          comments.push(commentData);
        }
      }

      pageToken = data.nextPageToken;

      // Small delay to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (pageToken);
  } catch (error) {
    console.error(`Error fetching comments for video ${videoId}:`, error);
  }

  return comments;
}

// -------------------- LEAD GENERATION --------------------
async function createLeadFromComment(comment, videoId, videoTitle, source) {
  try {
    // Extract potential contact information and business indicators
    const leadData = await extractLeadInformation(
      comment,
      videoId,
      videoTitle,
      source
    );

    if (leadData.isQualifiedLead) {
      console.log("🎯 QUALIFIED LEAD DETECTED:");
      console.log("================================");
      console.log("Author:", leadData.authorName);
      console.log("Comment:", leadData.commentText.substring(0, 100) + "...");
      console.log("Lead Score:", leadData.leadScore);
      console.log("Indicators:", leadData.businessIndicators);
      console.log("Contact Info:", leadData.contactInfo);
      console.log("Video:", leadData.videoTitle);
      console.log("Source:", leadData.source);
      console.log("================================\n");

      // Here you can integrate with your CRM or database
      await saveLeadToDatabase(leadData);
    }
  } catch (error) {
    console.error("Error creating lead from comment:", error);
  }
}

async function extractLeadInformation(comment, videoId, videoTitle, source) {
  const commentText = comment.commentText.toLowerCase();
  const authorName = comment.authorName;

  // Business indicators
  const businessKeywords = [
    "business",
    "company",
    "startup",
    "entrepreneur",
    "ceo",
    "founder",
    "marketing",
    "sales",
    "lead",
    "customer",
    "client",
    "service",
    "website",
    "online",
    "digital",
    "ecommerce",
    "shop",
    "store",
    "consultation",
    "freelance",
    "agency",
    "firm",
    "llc",
    "inc",
    "looking for",
    "need help",
    "interested in",
    "want to hire",
    "budget",
    "quote",
    "proposal",
    "project",
    "collaborate",
  ];

  const urgencyKeywords = [
    "urgent",
    "asap",
    "immediately",
    "soon",
    "deadline",
    "quick",
    "fast",
    "now",
    "today",
    "this week",
    "next week",
  ];

  const questionKeywords = [
    "how much",
    "cost",
    "price",
    "rate",
    "fee",
    "budget",
    "how do",
    "can you",
    "do you offer",
    "available for",
    "what is your",
    "how to",
    "help with",
    "advice",
  ];

  // Extract contact information
  const emailRegex = /[\w\.-]+@[\w\.-]+\.\w+/g;
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const websiteRegex =
    /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;

  const emails = commentText.match(emailRegex) || [];
  const phones = commentText.match(phoneRegex) || [];
  const websites = commentText.match(websiteRegex) || [];

  // Calculate lead score
  let leadScore = 0;
  const businessIndicators = [];

  businessKeywords.forEach((keyword) => {
    if (commentText.includes(keyword)) {
      leadScore += 2;
      businessIndicators.push(keyword);
    }
  });

  urgencyKeywords.forEach((keyword) => {
    if (commentText.includes(keyword)) {
      leadScore += 3;
      businessIndicators.push(`urgent: ${keyword}`);
    }
  });

  questionKeywords.forEach((keyword) => {
    if (commentText.includes(keyword)) {
      leadScore += 2;
      businessIndicators.push(`question: ${keyword}`);
    }
  });

  // Bonus points for contact info
  if (emails.length > 0) leadScore += 5;
  if (phones.length > 0) leadScore += 5;
  if (websites.length > 0) leadScore += 3;

  // Bonus for longer, detailed comments
  if (comment.commentText.length > 100) leadScore += 1;
  if (comment.commentText.length > 200) leadScore += 2;

  // Bonus for engagement
  if (comment.likeCount > 0) leadScore += 1;
  if (comment.totalReplyCount > 0) leadScore += 1;

  const leadData = {
    // Comment Details
    commentId: comment.commentId,
    commentText: comment.commentText,
    publishedAt: comment.publishedAt,
    updatedAt: comment.updatedAt,
    likeCount: comment.likeCount,
    totalReplyCount: comment.totalReplyCount,

    // Author Details
    authorName: comment.authorName,
    authorChannelId: comment.authorChannelId,
    authorChannelUrl: comment.authorChannelUrl,
    authorProfileImageUrl: comment.authorProfileImageUrl,

    // Video Details
    videoId: videoId,
    videoTitle: videoTitle,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,

    // Lead Information
    contactInfo: {
      emails: emails,
      phones: phones,
      websites: websites,
    },
    businessIndicators: businessIndicators,
    leadScore: leadScore,
    source: source, // 'new_video' or 'existing_video'

    // Lead Qualification
    isQualifiedLead: leadScore >= 5, // Minimum score for qualification
    priority: leadScore >= 10 ? "high" : leadScore >= 7 ? "medium" : "low",

    // Timestamps
    detectedAt: new Date().toISOString(),
    processed: false,
  };

  return leadData;
}

async function saveLeadToDatabase(leadData) {
  try {
    // Here you would typically save to your database
    // For now, we'll save to a JSON file for demonstration

    const leadsFile = "leads.json";
    let leads = [];

    try {
      if (fs.existsSync(leadsFile)) {
        leads = JSON.parse(fs.readFileSync(leadsFile, "utf8"));
      }
    } catch (error) {
      console.error("Error loading existing leads:", error);
    }

    leads.push(leadData);
    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));

    console.log(
      `💾 Lead saved: ${leadData.authorName} - Score: ${leadData.leadScore}`
    );

    // You can also send webhook/notification to your main application here
    // await notifyMainApplication(leadData);
  } catch (error) {
    console.error("Error saving lead:", error);
  }
}

// -------------------- API ENDPOINTS FOR LEAD MANAGEMENT --------------------
app.get("/api/leads", (req, res) => {
  try {
    const leadsFile = "leads.json";
    if (fs.existsSync(leadsFile)) {
      const leads = JSON.parse(fs.readFileSync(leadsFile, "utf8"));
      res.json(leads);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: "Error fetching leads" });
  }
});

app.get("/api/stats", (req, res) => {
  try {
    const leadsFile = "leads.json";
    if (fs.existsSync(leadsFile)) {
      const leads = JSON.parse(fs.readFileSync(leadsFile, "utf8"));

      const stats = {
        totalLeads: leads.length,
        qualifiedLeads: leads.filter((l) => l.isQualifiedLead).length,
        highPriorityLeads: leads.filter((l) => l.priority === "high").length,
        averageLeadScore:
          leads.reduce((sum, l) => sum + l.leadScore, 0) / leads.length || 0,
        lastProcessed: new Date().toISOString(),
        totalProcessedComments: tracker.data.processedComments.size,
        totalProcessedVideos: tracker.data.processedVideos.size,
      };

      res.json(stats);
    } else {
      res.json({ totalLeads: 0, qualifiedLeads: 0 });
    }
  } catch (error) {
    res.status(500).json({ error: "Error fetching stats" });
  }
});

// -------------------- PERIODIC COMMENT CHECKING --------------------
// Check for new comments every 5 minutes
setInterval(() => {
  if (ACCESS_TOKEN && CHANNEL_ID) {
    processAllVideosForNewComments();
  }
}, 5 * 60 * 1000); // 5 minutes

// -------------------- STARTUP --------------------
app.listen(7070, () => {
  console.log("🚀 YouTube Comment Lead Generator running on port 7070");
  console.log("📋 Features:");
  console.log("  - Auto-detects new video uploads via PubSub");
  console.log("  - Monitors all videos for new comments");
  console.log("  - Extracts business leads from comments");
  console.log("  - Prevents duplicate comment processing");
  console.log("  - Provides API endpoints for lead management");
  console.log("\n🔗 Endpoints:");
  console.log("  - GET /auth - Start OAuth flow");
  console.log("  - GET /api/leads - View all leads");
  console.log("  - GET /api/stats - View statistics");
  console.log("\n⚡ Go to /auth to authenticate with YouTube");
});
