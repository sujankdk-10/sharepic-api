const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => res.send("SharePic API is running"));

// GET photos
app.get("/api/photos", (req, res) => {
  console.log("GET /api/photos hit!");
  res.json([{ id: 1, title: "Sample Photo", url: "https://via.placeholder.com/150" }]);
});

// POST photo
app.post("/api/photos", (req, res) => {
  console.log("POST /api/photos hit! Body:", req.body);
  res.json({ message: "Upload endpoint works" });
});

// POST comment
app.post("/api/photos/:id/comments", (req, res) => {
  console.log(`POST /api/photos/${req.params.id}/comments hit! Body:`, req.body);
  res.json({ message: `Comment added for photo ${req.params.id}` });
});

// POST rating
app.post("/api/photos/:id/rating", (req, res) => {
  console.log(`POST /api/photos/${req.params.id}/rating hit! Body:`, req.body);
  res.json({ message: `Rating added for photo ${req.params.id}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
