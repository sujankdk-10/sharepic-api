// index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Config (env) ----
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || process.env.PHOTOS_CONTAINER || "photos";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME;
const COSMOS_PHOTOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";
const COSMOS_COMMENTS_CONTAINER = process.env.COSMOS_COMMENT_CONTAINER || "comments";
const COSMOS_RATINGS_CONTAINER = process.env.COSMOS_RATINGS_CONTAINER || "ratings";

const CREATOR_UPLOAD_KEY = process.env.CREATOR_UPLOAD_KEY || "";

// ---- Middleware ----
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-creator-key"],
  })
);

// Multer in-memory
const upload = multer({ storage: multer.memoryStorage() });

// ---- Cosmos client ----
function getCosmos() {
  if (!COSMOS_ENDPOINT || !COSMOS_KEY || !COSMOS_DB_NAME) {
    throw new Error("Cosmos env vars not configured (COSMOS_ENDPOINT/COSMOS_KEY/COSMOS_DB_NAME).");
  }
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const db = client.database(COSMOS_DB_NAME);
  return {
    client,
    db,
    photos: db.container(COSMOS_PHOTOS_CONTAINER),
    comments: db.container(COSMOS_COMMENTS_CONTAINER),
    ratings: db.container(COSMOS_RATINGS_CONTAINER),
  };
}

// ---- Creator gate ----
function requireCreatorKey(req, res, next) {
  // If key is not set on server, reject (safer, avoids accidentally open uploads)
  if (!CREATOR_UPLOAD_KEY) {
    return res.status(500).json({ message: "CREATOR_UPLOAD_KEY is not configured on the server." });
  }

  const provided = req.header("x-creator-key") || "";
  if (provided !== CREATOR_UPLOAD_KEY) {
    return res.status(401).json({ message: "Unauthorized: invalid creator key." });
  }
  next();
}

// ---- Health / Debug (safe) ----
app.get("/api/health", async (req, res) => {
  const info = {
    ok: true,
    time: new Date().toISOString(),
    corsOrigin: CORS_ORIGIN,
    hasStorageConn: !!AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: BLOB_CONTAINER_NAME,
    cosmosDb: COSMOS_DB_NAME,
    cosmosPhotosContainer: COSMOS_PHOTOS_CONTAINER,
    cosmosCommentsContainer: COSMOS_COMMENTS_CONTAINER,
    cosmosRatingsContainer: COSMOS_RATINGS_CONTAINER,
    hasCreatorKey: !!CREATOR_UPLOAD_KEY,
  };

  // quick cosmos read check (optional)
  try {
    const { db } = getCosmos();
    await db.read();
    info.cosmosStatus = "OK (DB readable)";
  } catch (e) {
    info.cosmosStatus = "NOT OK: " + (e?.message || String(e));
  }

  res.json(info);
});

// ---- GET photos (consumer gallery) ----
app.get("/api/photos", async (req, res) => {
  try {
    const { photos } = getCosmos();

    // Return only your useful fields (don’t leak Cosmos internal fields)
    const query = {
      query:
        "SELECT c.id, c.imageUrl, c.blobName, c.title, c.caption, c.location, c.people, c.createdAt FROM c ORDER BY c.createdAt DESC",
    };

    const { resources } = await photos.items.query(query).fetchAll();
    res.json(resources || []);
  } catch (err) {
    console.error("GET /api/photos ERROR:", err);
    res.status(500).json({ message: "Failed to fetch photos" });
  }
});

// ---- POST upload photo (creator only) ----
app.post(
  "/api/photos",
  requireCreatorKey,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image received" });
      }

      if (!AZURE_STORAGE_CONNECTION_STRING) {
        return res.status(500).json({ message: "AZURE_STORAGE_CONNECTION_STRING not configured" });
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        AZURE_STORAGE_CONNECTION_STRING
      );
      const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

      // Ensure container exists (optional safety)
      await containerClient.createIfNotExists({ access: "container" });

      const blobName = `${uuidv4()}-${req.file.originalname}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype },
      });

      const imageUrl = blockBlobClient.url;

      // Metadata
      const title = (req.body.title || "").trim();
      const caption = (req.body.caption || "").trim();
      const location = (req.body.location || "").trim();
      const peopleRaw = (req.body.people || "").trim();
      const people = peopleRaw
        ? peopleRaw.split(",").map((p) => p.trim()).filter(Boolean)
        : [];

      const photoDoc = {
        id: uuidv4(),
        imageUrl,
        blobName,
        title,
        caption,
        location,
        people,
        createdAt: new Date().toISOString(),
      };

      const { photos } = getCosmos();
      await photos.items.create(photoDoc);

      res.json({
        message: "Upload successful",
        photo: photoDoc,
      });
    } catch (err) {
      console.error("UPLOAD ERROR:", err);
      res.status(500).json({ message: "Upload failed" });
    }
  }
);

// ---- COMMENTS ----
app.get("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const { comments } = getCosmos();
    const photoId = req.params.photoId;

    const query = {
      query:
        "SELECT c.id, c.photoId, c.author, c.text, c.createdAt FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await comments.items.query(query).fetchAll();
    res.json(resources || []);
  } catch (err) {
    console.error("GET comments ERROR:", err);
    res.status(500).json({ message: "Failed to fetch comments" });
  }
});

app.post("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const { comments } = getCosmos();
    const photoId = req.params.photoId;

    const author = (req.body.author || "anonymous").trim();
    const text = (req.body.text || "").trim();
    if (!text) return res.status(400).json({ message: "Comment text required" });

    const doc = {
      id: uuidv4(),
      photoId,
      author,
      text,
      createdAt: new Date().toISOString(),
    };

    await comments.items.create(doc);
    res.json({ ok: true, comment: doc });
  } catch (err) {
    console.error("POST comment ERROR:", err);
    res.status(500).json({ message: "Failed to post comment" });
  }
});

// ---- RATINGS ----
app.post("/api/photos/:photoId/ratings", async (req, res) => {
  try {
    const { ratings } = getCosmos();
    const photoId = req.params.photoId;

    const author = (req.body.author || "anonymous").trim();
    const value = Number(req.body.value);

    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return res.status(400).json({ message: "Rating value must be 1-5" });
    }

    const doc = {
      id: uuidv4(),
      photoId,
      author,
      value,
      createdAt: new Date().toISOString(),
    };

    await ratings.items.create(doc);
    res.json({ ok: true, rating: doc });
  } catch (err) {
    console.error("POST rating ERROR:", err);
    res.status(500).json({ message: "Failed to save rating" });
  }
});

app.get("/api/photos/:photoId/ratings", async (req, res) => {
  try {
    const { ratings } = getCosmos();
    const photoId = req.params.photoId;

    const query = {
      query: "SELECT c.value FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await ratings.items.query(query).fetchAll();
    const values = (resources || []).map((r) => Number(r.value)).filter((n) => Number.isFinite(n));

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;

    for (const v of values) {
      if (v >= 1 && v <= 5) distribution[v] += 1;
      sum += v;
    }

    const count = values.length;
    const average = count ? sum / count : 0;

    res.json({ photoId, average, count, distribution });
  } catch (err) {
    console.error("GET ratings ERROR:", err);
    res.status(500).json({ message: "Failed to fetch ratings" });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`SharePic API running on port ${PORT}`);
});
