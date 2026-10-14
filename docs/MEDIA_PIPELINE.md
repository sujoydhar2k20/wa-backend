# Outgoing media pipeline (photos, videos, documents, voice notes, audio)

## Flow

```
client  POST /api/upload/file        multer diskStorage -> <VPS dir>/uploads/<name>.part -> renamed when complete
        POST /api/messages/send       { chatId, type, mediaUrl, async: true, clientMessageId, clientTimings }
server  -> Message (status 'queued', pipeline.stage 'queued') + Agenda job 'media-message:process' stored
        <- 202 + message              (only after both are in MongoDB)
worker  processMessage: source (own upload read from disk) -> prepare (image/video/audio/document rules)
        -> streamed upload to Meta (media id) -> stage 'ready'
        dispatchChat: the chat's earliest unfinished async media message is sent first (customer order kept)
        -> POST /{phone}/messages with biz_opaque_callback_data = "bjs:<messageId>:<attempt>"
        -> status 'sent' + wamid, or 'failed' + reason, or 'unconfirmed' (no answer: never re-sent automatically)
socket  'message:pipeline' on every stage change (pipeline.version only grows), 'message:status' on sent/failed
webhook delivered/read as before; a status for an unknown wamid carrying our callback data is matched to the
        message ("unconfirmed" -> sent/delivered/read)
sweep   every minute ('media-message:sweep'): re-enqueue queued/preparing rows whose job was lost (restart),
        turn stale 'sending' into 'unconfirmed', fail 'unconfirmed' after 3 min without a webhook
```

Text and template messages are unchanged (synchronous). A text sent while a video is still being prepared
reaches the customer before that video (decision of 15 Oct 2026); media keep their order among themselves.

Clients that do not send `async: true` (older app versions) keep the synchronous contract (201 when sent),
but use the same preparation rules, disk reads and safe-send rules.

## Preparation rules (services/media)

| Type | Pass-through when | Otherwise |
|---|---|---|
| Photo | real JPEG/PNG, <= 5 MB, longest edge <= 2048 px, 8-bit sRGB RGB(A), no EXIF rotation, single frame | auto-orient, resize to 2048 px, JPEG q80 (PNG kept if transparency is used), validated <= 5 MB |
| Video | H.264 8-bit 4:2:0 + AAC/no audio, MP4, only those streams, <= 16 MB | remux (`-c copy`) for .mov/.3gp/extra streams; audio-only re-encode for non-AAC audio; transcode (H.264 veryfast, short edge <= 720, bitrate capped to fit 16 MB) for other codecs or > 16 MB. Output re-probed and validated |
| Voice note | — | OGG/OPUS mono 48 kHz (libopus), as before |
| Audio file | — | AAC/M4A 128k, as before |
| Document | always (only the MIME type is corrected from magic bytes); <= 100 MB | — |

Limits from Meta's "Supported media types" (checked 14 Oct 2026): image 5 MB, video 16 MB (H.264 + AAC,
one audio stream or none), audio 16 MB, document 100 MB.

Converted files are kept in `<VPS dir>/prepared/` until the message is sent (so a retry does not convert
again) and removed on success; leftovers are deleted after 3 days by 'cleanup-prepared-media'. A Meta media id
is reused for retries for 25 days.

## Settings (environment, all optional)

| Variable | Default | Meaning |
|---|---|---|
| MEDIA_FFMPEG_CONCURRENCY | 1 | ffmpeg processes at once (per Node process) |
| MEDIA_IMAGE_CONCURRENCY | 2 | sharp transforms at once |
| MEDIA_META_UPLOAD_CONCURRENCY | 3 | uploads to Meta at once |
| MEDIA_JOB_CONCURRENCY | 4 | background media jobs at once |
| MEDIA_MAX_PENDING | 200 | unfinished async media messages before new ones get 503 (retryable) |
| META_SEND_TIMEOUT_MS | 30000 | POST /messages (text + media) |
| META_UPLOAD_TIMEOUT_MS | 180000 | POST /media |
| MEDIA_FETCH_TIMEOUT_MS | 60000 | downloading a non-local mediaUrl |
| MEDIA_FFMPEG_VIDEO_TIMEOUT_MS | 300000 | one transcode |
| VPS_UPLOAD_DIR / VPS_UPLOAD_URL | /var/www/WhatsappUpload / https://upload.biswakarmagold.com | only for tests or another server |

Requires `ffmpeg` and `ffprobe` on the server (`ffprobe -version`).

## Timings stored on the message (`pipeline.timings`)

`acceptedAt, prepareStartedAt, prepareEndedAt, sourceMs, prepareMs, convertMs, inputBytes, outputBytes,
metaUploadStartedAt, metaUploadMs, metaUploadedAt, sendStartedAt, sendMs, sentAt, failedAt, unconfirmedAt,
firstAcceptedAt/retriedAt (retries), client.{uploadMs, uploadBytes, queuedMs}` plus `statusTimes.{delivered,read}`.
Both clients show: Upload = client.uploadMs; Processing = acceptedAt -> prepareEndedAt; WhatsApp =
prepareEndedAt -> sentAt; Total = client.queuedMs + Upload + (acceptedAt -> sentAt).

## Tests and tools

- `npx jest src/services/media` — image/video rules (real sharp/ffmpeg), safe paths, streaming upload memory,
  async pipeline end to end (in-memory MongoDB, fake Meta), upload route.
- `node scripts/bench-media-prep.js 3` — before/after preparation timings on generated samples (run on the VPS
  for production-relevant numbers).
- `node scripts/e2e/start-e2e-backend.js` — local stack with a fake Meta API for the web panel's browser test
  (`whats-app-frontend/e2e/media-send.e2e.cjs`). Never run against production.
