const express = require("express");
const ytdl = require("ytdl-core");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpeg_static = require("ffmpeg-static");
const ytsr = require("ytsr");
const io = require("socket.io")(3002, {
  cors: {
    origin: "http://localhost:3000",
  },
});

const cors = require("cors");

io.on("connection", (socket) => {});

const app = express();
app.use(cors({ origin: "http://localhost:3000" }));
const PORT = 3001;

const ffmpegPath = "C:/ffmpeg/bin/ffmpeg.exe";
const ffprobePath = "C:/ffmpeg/bin/ffprobe.exe";
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

app.get("/", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const videoInfo = await ytdl.getInfo(videoUrl);

    const videoTitle = videoInfo.videoDetails.title || "video";
    const sanitizedTitle = videoTitle.replace(/[^\w]/g, "");
    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const duration = formatDuration(videoInfo.videoDetails.lengthSeconds);
    const formats = videoInfo.formats;
    const mp4Formats = videoInfo.formats
      .filter(
        (format) =>
          format.codecs === "vp9" &&
          format.qualityLabel &&
          parseInt(format.qualityLabel.replace("p", "")) <= 1080
      )
      .map((format) => ({
        mimeType: format.mimeType,
        qualityLabel: format.qualityLabel,
        bitrate: format.bitrate,
        size: format.contentLength
          ? Math.ceil(parseInt(format.contentLength) / 1048576)
          : null,
      }));

    const mp3Format = {
      mimeType: "audio/mp3",
      qualityLabel: "128kbps",
      bitrate: 128000,
      size: null,
    };

    res.json({
      title: videoTitle,
      thumbnail: thumbnailUrl,
      duration: duration,
      formats,
      // mp4Formats,
      // mp3Format,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.get("/mp3", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const videoInfo = await ytdl.getInfo(videoUrl);

  const videoTitle = videoInfo.videoDetails.title || "video";
  const sanitizedTitle = videoTitle.replace(/[^\w]/g, "");

  const videoStream = ytdl(videoUrl, { quality: "highestaudio" });

  const tempMp4Path = path.join(__dirname, "videos", `${sanitizedTitle}.mp4`);
  const outputPath = path.join(
    __dirname,
    "audios",
    `ytmp3-${sanitizedTitle}.mp3`
  );

  const writeStream = fs.createWriteStream(tempMp4Path);
  let downloadedSize = 0;
  let totalSize = parseInt(videoInfo.formats[0].contentLength);
  let downloadProgress = 0;
  videoStream.on("data", (chunk) => {
    downloadedSize += chunk.length;

    const progress = (downloadedSize / totalSize) * 100;
    if (Math.floor(progress) !== downloadProgress) {
      downloadProgress = Math.floor(progress);
      io.emit("downloadProgress", downloadProgress); // Emit download progress to client
      console.log("Download Progress:", downloadProgress + "%");
    }
  });
  videoStream.pipe(writeStream);
  videoStream.on("end", () => {
    console.log("Video downloaded successfully");
  });

  writeStream.on("finish", async () => {
    try {
      await convertMp4ToMp3(tempMp4Path, outputPath);
      res.setHeader("Content-Type", "audio/mp3");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanitizedTitle}.mp3"`
      );

      const audioStream = fs.createReadStream(outputPath);
      audioStream.on("error", (err) => {
        console.error("Error writing MP3 file:", err);
        res.status(500).json({ error: "Error writing MP3 file" });
      });
      audioStream.pipe(res);

      res.on("finish", () => {
        if (fs.existsSync(outputPath)) {
          fs.unlink(outputPath, (err) => {
            if (err) {
              console.error("Error deleting MP3 file:", err);
            } else {
              console.log("MP3 file deleted successfully");
            }
          });
        } else {
          console.log("MP3 file does not exist, skipping deletion");
        }

        if (fs.existsSync(tempMp4Path)) {
          fs.unlink(tempMp4Path, (err) => {
            if (err) {
              console.error("Error deleting MP4 file:", err);
            } else {
              console.log("MP4 file deleted successfully");
            }
          });
        } else {
          console.log("MP4 file does not exist, skipping deletion");
        }
      });
    } catch (err) {
      console.error("Error during conversion:", err);
      fs.unlinkSync(tempMp4Path);
      res.status(500).json({ error: "Conversion failed" });
    }
  });
});

app.get("/mp4", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "Missing videoId parameter" });
    }
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const videoInfo = await ytdl.getInfo(videoUrl);
    const videoTitle = videoInfo.videoDetails.title;
    const sanitizedTitle = videoTitle.replace(/[^\w]/g, "");

    const audio = ytdl(videoUrl, { quality: "highestaudio" });
    const video = ytdl(videoUrl, { quality: "highestvideo" });
    const outputPath = path.join(__dirname, "videos", `${sanitizedTitle}.mp4`);

    const ffmpegProcess = cp.spawn(
      ffmpeg_static,
      [
        "-y",
        "-loglevel",
        "8",
        "-hide_banner",
        "-progress",
        "pipe:3",
        "-i",
        "pipe:4",
        "-i",
        "pipe:5",
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-strict",
        "experimental",
        outputPath,
      ],
      {
        windowsHide: true,
        stdio: ["inherit", "inherit", "inherit", "pipe", "pipe", "pipe"],
      }
    );

    ffmpegProcess.stdio[3].on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      const args = {};
      for (const l of lines) {
        const [key, value] = l.split("=");
        args[key.trim()] = value.trim();
      }
    });

    audio.pipe(ffmpegProcess.stdio[4]);
    video.pipe(ffmpegProcess.stdio[5]);

    await new Promise((resolve, reject) => {
      ffmpegProcess.on("close", () => {
        console.log("Mp4 downloaded successfully");
        resolve();
      });
      ffmpegProcess.on("error", (err) => {
        reject(err);
      });
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizedTitle}.mp4"`
    );

    const videoStream = fs.createReadStream(outputPath);
    videoStream.pipe(res);
    videoStream.on("error", (err) => {
      console.error("Error reading MP4 file:", err);
      res.status(500).json({ error: "Error reading MP4 file" });
    });

    res.on("finish", () => {
      fs.unlink(outputPath, (err) => {
        if (err) {
          console.error("Error deleting MP4 file:", err);
        } else {
          console.log("MP4 file deleted successfully");
        }
      });
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.get("/search", async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) {
      return res.status(400).json({ error: "Missing keyword parameter" });
    }
    const sanitizedKeyword = keyword.replace(/\s+/g, "");
    console.log(sanitizedKeyword);

    const searchResults = await ytsr(sanitizedKeyword, { limit: 10 });
    const videos = searchResults.items
      .filter((item) => item.type === "video")
      .map((item) => ({
        title: item.title,
        videoId: item.id,
        thumbnail: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
      }));

    res.json({ videos });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

async function convertMp4ToMp3(inputPath, outputPath, ws) {
  let totalTime;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("libmp3lame")
      .on("codecData", (data) => {
        totalTime = parseInt(data.duration.replace(/:/g, ""));
      })
      .on("progress", (progress) => {
        const time = parseInt(progress.timemark.replace(/:/g, ""));
        const percent = (time / totalTime) * 100;
        io.emit("progress", percent);
        // console.log("Progress:", percent + "%");
      })
      .save(outputPath)
      .on("end", () => {
        console.log("MP4 to MP3 conversion complete");
        resolve();
      })
      .on("error", (err) => {
        console.error("Error converting MP4 to MP3:", err);
        reject(err);
      });
  });
}

function formatDuration(durationInSeconds) {
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = durationInSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
