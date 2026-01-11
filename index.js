const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Azure Blob
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(
  process.env.BLOB_CONTAINER_NAME
);

// Cosmos DB
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});
const database = cosmosClient.database(process.env.COSMOS_DB_NAME);
const photosContainer = database.container(process.env.PHOTOS_CONTAINER);
const commentsContainer = database.container(process.env.COSMOS_COMMENT_CONTAINER);

// Health check
app.get("/", (req, res) => res.send("SharePic API is running"));

// GET all photos
app.get("/api/photos", async (req, res) => {
  try {
    const { resources: photos } = await photosContainer.items.readAll().fetchAll();
    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch photos" });
  }
});

// GET photo by id
app.get("/api/photos/:id", async (req, res) => {
  try {
    const { resource } = await photosContainer.item(req.params.id, req.params.id).read();
    if (!resource) return res.status(404).json({ error: "Photo not found" });
    res.json(resource);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch photo" });
  }
});

// POST photo (upload)
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.body.title) {
      return res.status(400).json({ error: "Title and file are required" });
    }

    const fileName = `${uuidv4()}-${req.file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(fileName);

    // Upload to blob
    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const imageUrl = blockBlobClient.url;

    // Save metadata to Cosmos
    const photo = {
      id: uuidv4(),
      title: req.body.title,
      imageUrl,
      createdAt: new Date().toISOString(),
    };
    await photosContainer.items.create(photo);

    res.json({ message: "Upload successful", imageUrl, title: req.body.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// POST comment
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    const comment = {
      id: uuidv4(),
      photoId: req.params.id,
      text: req.body.text,
      createdAt: new Date().toISOString(),
    };
    await commentsContainer.items.create(comment);
    res.json({ message: `Comment added for photo ${req.params.id}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// POST rating
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    const { rating } = req.body;
    if (!rating) return res.status(400).json({ error: "Rating required" });
    // Just a placeholder: implement rating storage if needed
    res.json({ message: `Rating ${rating} added for photo ${req.params.id}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add rating" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
