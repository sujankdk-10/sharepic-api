const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- ENV CHECK ----------
const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING;

if (!AZURE_STORAGE_CONNECTION_STRING) {
  console.error("❌ AZURE_STORAGE_CONNECTION_STRING is missing");
}

// ---------- MULTER (MEMORY STORAGE) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- AZURE BLOB ----------
const blobServiceClient =
  BlobServiceClient.fromConnectionString(
    AZURE_STORAGE_CONNECTION_STRING
  );

const containerName = "photos";

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  res.send("SharePic API is running");
});

// ---------- GET PHOTOS (TEMP STATIC) ----------
app.get("/api/photos", async (req, res) => {
  try {
    const containerClient =
      blobServiceClient.getContainerClient(containerName);

    const photos = [];
    for await (const blob of containerClient.listBlobsFlat()) {
      photos.push({
        title: blob.name,
        url: `${containerClient.url}/${blob.name}`,
      });
    }

    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load photos" });
  }
});

// ---------- POST PHOTO (REAL UPLOAD) ----------
app.post(
  "/api/photos",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.body.title) {
        return res
          .status(400)
          .json({ error: "Title and image required" });
      }

      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      await containerClient.createIfNotExists({
        access: "blob",
      });

      const extension = req.file.originalname.split(".").pop();
      const blobName = `${uuidv4()}.${extension}`;

      const blockBlobClient =
        containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: {
          blobContentType: req.file.mimetype,
        },
      });

      res.json({
        message: "Upload successful",
        title: req.body.title,
        url: blockBlobClient.url,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ---------- COMMENTS (PLACEHOLDER) ----------
app.post("/api/photos/:id/comments", (req, res) => {
  res.json({ message: "Comment received (not stored yet)" });
});

// ---------- RATING (PLACEHOLDER) ----------
app.post("/api/photos/:id/rating", (req, res) => {
  res.json({ message: "Rating received (not stored yet)" });
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API running on port ${PORT}`)
);
