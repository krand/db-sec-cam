# Camera Recorder

A local-first Electron app for live camera preview and segmented video recording.

## Features

- Live preview from the built-in or attached camera.
- Video-only recording saved as independent WebM clips.
- Configurable clip duration, resolution, frame rate, and target bitrate.
- Approximate clip size shown from the selected target bitrate.
- Choose any local destination folder, including a Dropbox-synced folder.
- Optional total storage limit that removes the oldest Camera Recorder clips to stay under the configured size.
- Optional motion alerts using local, non-AI frame comparison, with a JPEG snapshot sent to Telegram when motion is detected.
- Optional Telegram bot notifications; no app server is required.
- Option to keep the display awake while recording or monitoring motion; otherwise the app prevents system idle sleep while allowing the display to sleep.
- Camera permission is requested through macOS and recordings stay local unless the destination folder is synced by another service.

## Configure Telegram motion alerts

Telegram notifications use a bot chat to send alerts to your personal Telegram account. The alert appears as a message from your bot; the app does not sign in as or send messages from your personal account. The bot API is free for normal single-user notifications, subject to Telegram's limits. No separate hosting or server is needed: this app sends messages directly to Telegram.

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts to create a dedicated bot.
2. Copy the bot token that BotFather gives you. Keep it private; anyone with the token can control that bot.
3. In Camera Recorder, open **Motion alerts**, paste the token, and choose **Save token**. The app verifies it and stores it using Electron's operating-system-backed secure storage.
4. Choose **Open Telegram & connect**. In the Telegram chat that opens, press **Start**. Return to Camera Recorder and choose **Check connection**.
5. Choose **Send test** to confirm the bot can message you.
6. Turn on **Enable motion monitoring** and start the camera. Adjust the comparison interval, changed-area threshold, and alert cooldown to suit the scene.

Motion monitoring runs only while the app is open and its camera preview is active. It compares downscaled grayscale frames locally; it does not use AI or save comparison images. When the configured portion of the image changes, the app captures a JPEG snapshot (up to 1280 pixels on the longest side) and sends it with the alert. The snapshot is not saved on the Mac, but Telegram receives and retains it in the bot chat. An internet connection and Telegram availability are required for delivery. Use **Disconnect** to remove the saved bot token and connection.

While Camera Recorder is open and Telegram is connected, send `/photo` in the private bot chat to get a current picture. The camera preview must be running. The bot accepts commands only from the private chat connected in Camera Recorder; `/snapshot` is also supported.

## Development

```sh
npm install
npm run dev
```

## macOS package

```sh
npm run package:mac
```

The app requests camera permission only when the user starts the camera. It does not request microphone access or record audio.

This command creates a macOS DMG installer in `release/`.
