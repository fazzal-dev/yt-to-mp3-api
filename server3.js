const express = require("express");
const app = express();
const ytdl = require("ytdl-core");
const cors = require("cors");

app.use(cors({ origin: "http://localhost:3000" }));

app.get("/mp3", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const videoInfo = await ytdl.getInfo(videoUrl);
    const videoTitle = videoInfo.videoDetails.title || "ytmp3-video";
    const sanitizedTitle = videoTitle.replace(/[^\w\s]/g, "");
    const fileName = `${sanitizedTitle}.mp3`;

    const outputPath = path.join(__dirname, "audios", fileName);
    const writeStream = fs.createWriteStream(outputPath);
    const audio = ytdl(videoUrl, { quality: "highest", filter: "audioonly" });

    audio.on("progress", (_, downloaded, total) => {
      const percent = ((downloaded / total) * 100).toFixed(1);
      console.log(percent);
      io.emit("progress", percent);
    });
    audio.pipe(writeStream);
    audio.on("finish", () => {
      console.log("Conversion to Mp3 complete");
      res.json({ success: true, videoTitle });
    });
  } catch (error) {
    console.error("Error fetching video info:", error);
    res.status(500).json({ error: "Error fetching video info" });
  }
});

app.get("/download", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const videoInfo = await ytdl.getInfo(videoUrl);
  const videoTitle = videoInfo.videoDetails.title || "ytmp3-video";
  const sanitizedTitle = videoTitle.replace(/[^\w\s]/g, "");
  const fileName = `${sanitizedTitle}.mp3`;
  const outputPath = path.join(__dirname, "audios", fileName);

  if (fs.existsSync(outputPath)) {
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "audio/mpeg");

    const fileStream = fs.createReadStream(outputPath);
    fileStream.on("progress", (_, downloaded, total) => {
      const percent = ((downloaded / total) * 100).toFixed(1);
      io.emit("download", percent);
      console.log(percent);
    });

    fileStream.pipe(res);
    fileStream.on("end", () => {
      console.log("Download complete");
    });

    fileStream.on("error", (err) => {
      console.error("Error streaming file:", err);
      res.status(500).json({ error: "Error streaming file" });
    });
  }
});

app.listen(3001, () => {
  console.log("Server running on port 3001");
});
